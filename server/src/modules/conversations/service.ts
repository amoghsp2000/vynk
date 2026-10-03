import { query, queryOne, transaction, type Queryable } from '../../database/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getProfiles, type PublicProfile } from '../users/service.js';

export const directKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export interface MemberRow {
  conversation_id: string;
  user_id: string;
  cleared_before_seq: string;
  hidden: boolean;
  last_read_seq: string;
}

/**
 * Membership is the authorization boundary for everything conversation-scoped.
 * Non-members get 404 (not 403) so conversation ids cannot be probed.
 */
export async function requireMember(userId: string, conversationId: string, db?: Queryable): Promise<MemberRow> {
  const m = await queryOne<MemberRow>(
    'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId],
    db,
  );
  if (!m) throw notFound('Conversation');
  return m;
}

export async function memberIds(conversationId: string, db?: Queryable): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
    [conversationId],
    db,
  );
  return rows.map((r) => r.user_id);
}

/** Opens (or re-opens) the unique 1:1 chat between two users. */
export async function getOrCreateDirect(userId: string, peerId: string) {
  if (userId === peerId) throw badRequest('You cannot start a chat with yourself');
  const peer = await queryOne('SELECT 1 FROM users WHERE id = $1', [peerId]);
  if (!peer) throw notFound('User');

  const conversationId = await transaction(async (tx) => {
    // DO UPDATE (no-op) so RETURNING yields the id whether inserted or existing.
    const conv = await queryOne<{ id: string }>(
      `INSERT INTO conversations (type, direct_key, created_by) VALUES ('direct', $1, $2)
       ON CONFLICT (direct_key) DO UPDATE SET direct_key = EXCLUDED.direct_key RETURNING id`,
      [directKey(userId, peerId), userId],
      tx,
    );
    // The peer's side starts hidden: it appears for them once a message arrives.
    await query(
      `INSERT INTO conversation_members (conversation_id, user_id, hidden)
       VALUES ($1, $2, false), ($1, $3, true) ON CONFLICT DO NOTHING`,
      [conv!.id, userId, peerId],
      tx,
    );
    await query(
      'UPDATE conversation_members SET hidden = false WHERE conversation_id = $1 AND user_id = $2 AND hidden',
      [conv!.id, userId],
      tx,
    );
    return conv!.id;
  });
  return getConversation(userId, conversationId);
}

export interface ConversationDto {
  id: string;
  type: 'direct' | 'group';
  peer: PublicProfile | null;
  last_message: {
    id: string;
    sender_id: string;
    type: string;
    body: string | null;
    deleted: boolean;
    created_at: string;
    seq: number;
    status: string | null;
  } | null;
  unread_count: number;
  last_read_seq: number;
  cleared_before_seq: number;
  muted_until: string | null;
  last_activity_at: string;
  created_at: string;
}

const LIST_SQL = `
SELECT c.id, c.type, c.created_at, COALESCE(c.last_message_at, c.created_at) AS activity_at,
       cm.last_read_seq, cm.cleared_before_seq, cm.muted_until,
       peer.user_id AS peer_id,
       lm.last_message,
       (SELECT count(*) FROM messages u
         WHERE u.conversation_id = c.id
           AND u.order_seq > GREATEST(cm.last_read_seq, cm.cleared_before_seq)
           AND u.sender_id <> $1 AND u.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.user_id = $1 AND h.message_id = u.id)
       )::int AS unread_count
FROM conversation_members cm
JOIN conversations c ON c.id = cm.conversation_id
LEFT JOIN LATERAL (
  SELECT o.user_id FROM conversation_members o
  WHERE o.conversation_id = c.id AND o.user_id <> $1 LIMIT 1
) peer ON true
LEFT JOIN LATERAL (
  SELECT json_build_object(
           'id', m.id, 'sender_id', m.sender_id, 'type', m.type,
           'body', CASE WHEN m.deleted_at IS NULL THEN left(m.body, 200) END,
           'deleted', m.deleted_at IS NOT NULL, 'created_at', m.created_at, 'seq', m.order_seq,
           'status', (SELECT CASE WHEN bool_and(mr.status = 'read') THEN 'read'
                                  WHEN bool_and(mr.status IN ('delivered','read')) THEN 'delivered'
                                  ELSE 'sent' END
                      FROM message_receipts mr WHERE mr.message_id = m.id)
         ) AS last_message
  FROM messages m
  WHERE m.conversation_id = c.id AND m.order_seq > cm.cleared_before_seq
    AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.user_id = $1 AND h.message_id = m.id)
  ORDER BY m.order_seq DESC LIMIT 1
) lm ON true
WHERE cm.user_id = $1`;

function toDto(r: any, peers: Map<string, PublicProfile>): ConversationDto {
  return {
    id: r.id,
    type: r.type,
    peer: r.peer_id ? (peers.get(r.peer_id) ?? null) : null,
    last_message: r.last_message
      ? { ...r.last_message, seq: Number(r.last_message.seq), created_at: new Date(r.last_message.created_at).toISOString() }
      : null,
    unread_count: r.unread_count,
    last_read_seq: Number(r.last_read_seq),
    cleared_before_seq: Number(r.cleared_before_seq),
    muted_until: r.muted_until,
    last_activity_at: new Date(r.activity_at).toISOString(),
    created_at: new Date(r.created_at).toISOString(),
  };
}

export async function listConversations(
  userId: string,
  opts: { q?: string | undefined; before?: string | undefined; limit: number },
) {
  const params: unknown[] = [userId];
  let where = ' AND NOT cm.hidden';
  if (opts.q) {
    params.push(`%${opts.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    const p = `$${params.length}`;
    where += ` AND EXISTS (
      SELECT 1 FROM users pu LEFT JOIN contacts ct ON ct.owner_id = $1 AND ct.contact_id = pu.id
      WHERE pu.id = peer.user_id AND (pu.name ILIKE ${p} OR pu.phone_number LIKE ${p} OR ct.display_name ILIKE ${p}))`;
  }
  if (opts.before) {
    const [ts, id] = decodeCursor(opts.before);
    params.push(ts, id);
    where += ` AND (COALESCE(c.last_message_at, c.created_at), c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(opts.limit + 1);
  const rows = await query(
    `${LIST_SQL}${where} ORDER BY activity_at DESC, c.id DESC LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, opts.limit);
  const peers = await getProfiles(userId, page.map((r) => r.peer_id).filter(Boolean));
  const last = page.at(-1);
  return {
    conversations: page.map((r) => toDto(r, peers)),
    next_cursor: rows.length > opts.limit && last ? encodeCursor(last.activity_at, last.id) : null,
  };
}

export async function getConversation(userId: string, conversationId: string) {
  await requireMember(userId, conversationId);
  const rows = await query(`${LIST_SQL} AND c.id = $2`, [userId, conversationId]);
  const peers = await getProfiles(userId, rows.map((r) => r.peer_id).filter(Boolean));
  return toDto(rows[0], peers);
}

/** "Delete chat" for me only: hides the chat and clears my view of its history. */
export async function deleteLocally(userId: string, conversationId: string) {
  await requireMember(userId, conversationId);
  await query(
    `UPDATE conversation_members cm
     SET hidden = true,
         cleared_before_seq = sub.max_seq,
         last_read_seq = GREATEST(cm.last_read_seq, sub.max_seq)
     FROM (SELECT COALESCE(max(order_seq), 0) AS max_seq FROM messages WHERE conversation_id = $1) sub
     WHERE cm.conversation_id = $1 AND cm.user_id = $2`,
    [conversationId, userId],
  );
}

const encodeCursor = (ts: Date, id: string) => Buffer.from(`${new Date(ts).toISOString()}|${id}`).toString('base64url');
function decodeCursor(c: string): [string, string] {
  const [ts, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!ts || !id || Number.isNaN(Date.parse(ts)) || !/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('Invalid cursor');
  return [ts, id];
}
