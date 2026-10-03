import { query, queryOne, transaction } from '../../database/pool.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { domainEvents } from '../../lib/domainEvents.js';
import { logger } from '../../lib/logger.js';
import { sendToUsers } from '../../websocket/bus.js';
import { requireMember, memberIds } from '../conversations/service.js';
import { requireOwnReadyMedia } from '../media/service.js';
import { MESSAGE_COLUMNS, toMessageDto, type MessageDto } from './dto.js';

export interface SendInput {
  conversation_id: string;
  client_msg_id: string;
  type: 'text' | 'image';
  body?: string | undefined;
  media_id?: string | undefined;
  reply_to_id?: string | undefined;
  status_reply_id?: string | undefined;
}

/** Messages may be deleted for everyone within this window. */
export const DELETE_FOR_EVERYONE_WINDOW_MS = 48 * 3600_000;

async function loadMessage(id: string, db?: Parameters<typeof query>[2]) {
  const r = await queryOne(`SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.id = $1`, [id], db);
  return r ? toMessageDto(r) : undefined;
}

/**
 * Persists a message, then fans it out. Idempotent on (sender, client_msg_id):
 * a retried send returns the original message instead of creating a second one.
 * The ack is only sent after the database commit, so an ack means "stored".
 */
export async function sendMessage(
  senderId: string,
  input: SendInput,
  opts: { exceptConn?: string } = {},
): Promise<{ message: MessageDto; duplicate: boolean }> {
  if (input.type === 'text' && !input.body?.trim()) throw badRequest('Message body is required');
  if (input.type === 'image' && !input.media_id) throw badRequest('media_id is required for image messages');

  const outcome = await transaction(async (tx) => {
    await requireMember(senderId, input.conversation_id, tx);

    const existing = await queryOne<{ id: string; conversation_id: string }>(
      'SELECT id, conversation_id FROM messages WHERE sender_id = $1 AND client_msg_id = $2',
      [senderId, input.client_msg_id],
      tx,
    );
    if (existing) {
      if (existing.conversation_id !== input.conversation_id) throw conflict('client_msg_id already used');
      return { duplicate: true as const, id: existing.id };
    }

    if (input.reply_to_id) {
      const target = await queryOne(
        'SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2',
        [input.reply_to_id, input.conversation_id],
        tx,
      );
      if (!target) throw badRequest('reply_to_id is not a message in this conversation');
    }
    if (input.media_id) await requireOwnReadyMedia(senderId, input.media_id, 'attachment');

    const others = (await memberIds(input.conversation_id, tx)).filter((id) => id !== senderId);
    const blocks = await query<{ blocker_id: string; blocked_id: string }>(
      `SELECT blocker_id, blocked_id FROM blocks
       WHERE (blocker_id = $1 AND blocked_id = ANY($2::uuid[])) OR (blocked_id = $1 AND blocker_id = ANY($2::uuid[]))`,
      [senderId, others],
      tx,
    );
    if (blocks.some((b) => b.blocker_id === senderId)) {
      throw new AppError(403, 'blocked', 'You blocked this contact. Unblock to send messages.');
    }
    // Recipients who blocked the sender silently never receive it (the sender
    // is not told, matching common messenger behaviour).
    const blockedBy = new Set(blocks.map((b) => b.blocker_id));
    const recipients = others.filter((id) => !blockedBy.has(id));

    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO messages (conversation_id, sender_id, client_msg_id, type, body, media_id, reply_to_id, status_reply_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (sender_id, client_msg_id) DO NOTHING RETURNING id`,
      [
        input.conversation_id,
        senderId,
        input.client_msg_id,
        input.type,
        input.body ?? null,
        input.media_id ?? null,
        input.reply_to_id ?? null,
        input.status_reply_id ?? null,
      ],
      tx,
    );
    if (!inserted) {
      // Lost a race with a concurrent retry of the same send.
      const again = await queryOne<{ id: string }>(
        'SELECT id FROM messages WHERE sender_id = $1 AND client_msg_id = $2',
        [senderId, input.client_msg_id],
        tx,
      );
      return { duplicate: true as const, id: again!.id };
    }

    if (recipients.length) {
      await query(
        `INSERT INTO message_receipts (message_id, user_id, sender_id)
         SELECT $1, unnest($2::uuid[]), $3`,
        [inserted.id, recipients, senderId],
        tx,
      );
    }
    if (blockedBy.size) {
      await query(
        `INSERT INTO message_hides (user_id, message_id) SELECT unnest($1::uuid[]), $2`,
        [[...blockedBy], inserted.id],
        tx,
      );
    }
    await query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [input.conversation_id], tx);
    // A chat deleted locally (or never opened by the peer) reappears on new activity.
    await query(
      `UPDATE conversation_members SET hidden = false
       WHERE conversation_id = $1 AND hidden AND user_id = ANY($2::uuid[])`,
      [input.conversation_id, [senderId, ...recipients]],
      tx,
    );
    return { duplicate: false as const, id: inserted.id, recipients };
  });

  const message = (await loadMessage(outcome.id))!;
  if (!outcome.duplicate) {
    logger.info(
      { messageId: message.id, conversationId: message.conversation_id, senderId, recipients: outcome.recipients.length },
      'message: stored',
    );
    // Recipients get message.new; the sender's other devices get it too so
    // every device converges. Fan-out happens strictly after commit.
    await sendToUsers(outcome.recipients, 'message.new', message, { from: senderId });
    await sendToUsers([senderId], 'message.new', message, {
      from: senderId,
      ...(opts.exceptConn ? { exceptConn: opts.exceptConn } : {}),
    });
    domainEvents.emit('message.created', { message, recipientIds: outcome.recipients });
  }
  return { message, duplicate: outcome.duplicate };
}

/** Cursor pagination by immutable order_seq (newest first when paging back). */
export async function history(
  userId: string,
  conversationId: string,
  opts: { before_seq?: number | undefined; after_seq?: number | undefined; limit: number },
) {
  const member = await requireMember(userId, conversationId);
  const params: unknown[] = [conversationId, userId, member.cleared_before_seq];
  let cond = '';
  let order = 'DESC';
  if (opts.after_seq !== undefined) {
    params.push(opts.after_seq);
    cond = ` AND m.order_seq > $${params.length}`;
    order = 'ASC';
  } else if (opts.before_seq !== undefined) {
    params.push(opts.before_seq);
    cond = ` AND m.order_seq < $${params.length}`;
  }
  params.push(opts.limit + 1);
  const rows = await query(
    `SELECT ${MESSAGE_COLUMNS} FROM messages m
     WHERE m.conversation_id = $1 AND m.order_seq > $3 ${cond}
       AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.user_id = $2 AND h.message_id = m.id)
     ORDER BY m.order_seq ${order} LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit).map(toMessageDto);
  if (order === 'DESC') page.reverse();
  return { messages: page, has_more: hasMore };
}

/**
 * Recipient device confirms it has the messages (persisted/rendered). This,
 * not socket.send(), is what moves a message to DELIVERED.
 */
export async function markDelivered(userId: string, messageIds: string[]) {
  if (!messageIds.length) return { updated: 0 };
  const rows = await query<{ message_id: string; sender_id: string; conversation_id: string }>(
    `UPDATE message_receipts mr SET status = 'delivered', delivered_at = now()
     FROM messages m
     WHERE mr.message_id = m.id AND mr.user_id = $1 AND mr.message_id = ANY($2::uuid[]) AND mr.status = 'sent'
     RETURNING mr.message_id, mr.sender_id, m.conversation_id`,
    [userId, messageIds],
  );
  await notifyStatus(rows, userId, 'delivered');
  return { updated: rows.length };
}

/**
 * A client that just loaded its state from scratch (no local cache) has
 * received everything addressed to it: confirm all still-undelivered receipts.
 */
export async function markAllDelivered(userId: string) {
  const rows = await query<{ message_id: string; sender_id: string; conversation_id: string }>(
    `UPDATE message_receipts mr SET status = 'delivered', delivered_at = now()
     FROM messages m
     WHERE mr.message_id = m.id AND mr.user_id = $1 AND mr.status = 'sent'
     RETURNING mr.message_id, mr.sender_id, m.conversation_id`,
    [userId],
  );
  // Group per (sender, conversation) so each status event names one conversation.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(`${r.sender_id}:${r.conversation_id}`, [...(groups.get(`${r.sender_id}:${r.conversation_id}`) ?? []), r]);
  for (const g of groups.values()) await notifyStatus(g, userId, 'delivered');
  return { updated: rows.length };
}

/** Marks everything up to `upToSeq` in a conversation as read by `userId`. */
export async function markRead(userId: string, conversationId: string, upToSeq: number) {
  await requireMember(userId, conversationId);
  const member = await queryOne<{ last_read_seq: string }>(
    `UPDATE conversation_members SET last_read_seq = $3
     WHERE conversation_id = $1 AND user_id = $2 AND last_read_seq < $3 RETURNING last_read_seq`,
    [conversationId, userId, upToSeq],
  );
  const prefs = await queryOne<{ read_receipts: boolean }>('SELECT read_receipts FROM user_privacy WHERE user_id = $1', [userId]);
  // With read receipts disabled the reader's own unread state still advances,
  // but senders only ever see DELIVERED.
  const target = prefs?.read_receipts === false ? 'delivered' : 'read';
  const rows = await query<{ message_id: string; sender_id: string; conversation_id: string }>(
    `UPDATE message_receipts mr
     SET status = $4,
         delivered_at = COALESCE(mr.delivered_at, now()),
         read_at = CASE WHEN $4 = 'read' THEN now() ELSE mr.read_at END
     FROM messages m
     WHERE mr.message_id = m.id AND m.conversation_id = $1 AND mr.user_id = $2 AND m.order_seq <= $3
       AND (mr.status = 'sent' OR ($4 = 'read' AND mr.status = 'delivered'))
     RETURNING mr.message_id, mr.sender_id, m.conversation_id`,
    [conversationId, userId, upToSeq, target],
  );
  await notifyStatus(rows, userId, target);
  if (member) {
    // Other devices of the reader clear their unread badges.
    await sendToUsers([userId], 'conversation.read', { conversation_id: conversationId, last_read_seq: upToSeq });
  }
  return { updated: rows.length };
}

async function notifyStatus(
  rows: { message_id: string; sender_id: string; conversation_id: string }[],
  recipientId: string,
  status: 'delivered' | 'read',
) {
  const bySender = new Map<string, typeof rows>();
  for (const r of rows) bySender.set(r.sender_id, [...(bySender.get(r.sender_id) ?? []), r]);
  for (const [senderId, list] of bySender) {
    await sendToUsers([senderId], 'message.status', {
      conversation_id: list[0]!.conversation_id,
      user_id: recipientId,
      status,
      message_ids: list.map((r) => r.message_id),
      at: new Date().toISOString(),
    });
  }
}

export async function deleteMessage(userId: string, messageId: string, scope: 'me' | 'everyone') {
  const m = await queryOne<{ id: string; conversation_id: string; sender_id: string; created_at: Date; deleted_at: Date | null }>(
    'SELECT id, conversation_id, sender_id, created_at, deleted_at FROM messages WHERE id = $1',
    [messageId],
  );
  if (!m) throw notFound('Message');
  await requireMember(userId, m.conversation_id); // non-members get 404

  if (scope === 'me') {
    await query('INSERT INTO message_hides (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, messageId]);
    await sendToUsers([userId], 'message.hidden', { conversation_id: m.conversation_id, message_id: messageId });
    return { ok: true };
  }

  if (m.sender_id !== userId) throw forbidden('Only the sender can delete a message for everyone');
  if (m.deleted_at) return { ok: true };
  if (Date.now() - m.created_at.getTime() > DELETE_FOR_EVERYONE_WINDOW_MS) {
    throw forbidden('This message is too old to delete for everyone');
  }
  await query('UPDATE messages SET deleted_at = now(), body = NULL, media_id = NULL WHERE id = $1', [messageId]);
  logger.info({ messageId, conversationId: m.conversation_id }, 'message: deleted for everyone');
  await sendToUsers(await memberIds(m.conversation_id), 'message.deleted', {
    conversation_id: m.conversation_id,
    message_id: messageId,
  });
  return { ok: true };
}

export async function search(userId: string, q: string, conversationId?: string, limit = 50) {
  if (conversationId) await requireMember(userId, conversationId);
  const pattern = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const rows = await query(
    `SELECT ${MESSAGE_COLUMNS} FROM messages m
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
     WHERE m.deleted_at IS NULL AND m.body ILIKE $2 AND m.order_seq > cm.cleared_before_seq
       AND ($3::uuid IS NULL OR m.conversation_id = $3)
       AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.user_id = $1 AND h.message_id = m.id)
     ORDER BY m.order_seq DESC LIMIT $4`,
    [userId, pattern, conversationId ?? null, limit],
  );
  return { messages: rows.map(toMessageDto) };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Changes newer than this may belong to transactions still committing. */
const SYNC_SAFETY_MS = 10_000;
const SYNC_PAGE = 500;

/**
 * Returns every change relevant to `userId` with change_seq > cursor:
 * new/edited/deleted messages, status changes of messages they sent,
 * messages they hid, and their per-conversation state (read marker, cleared,
 * hidden). Clients apply results idempotently and loop while has_more.
 */
export async function sync(userId: string, cursor: number) {
  const [msgRows, receiptRows, hideRows, memberRows, nowRow] = await Promise.all([
    query(
      `SELECT x.* FROM conversation_members cm
       CROSS JOIN LATERAL (
         SELECT ${MESSAGE_COLUMNS}, m.changed_at FROM messages m
         WHERE m.conversation_id = cm.conversation_id AND m.change_seq > $2 AND m.order_seq > cm.cleared_before_seq
           AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.user_id = $1 AND h.message_id = m.id)
         ORDER BY m.change_seq LIMIT ${SYNC_PAGE}
       ) x
       WHERE cm.user_id = $1
       ORDER BY x.change_seq LIMIT ${SYNC_PAGE}`,
      [userId, cursor],
    ),
    query(
      `SELECT mr.message_id, m.conversation_id, mr.user_id, mr.status, mr.delivered_at, mr.read_at,
              mr.change_seq, mr.changed_at
       FROM message_receipts mr JOIN messages m ON m.id = mr.message_id
       WHERE mr.sender_id = $1 AND mr.change_seq > $2
       ORDER BY mr.change_seq LIMIT ${SYNC_PAGE}`,
      [userId, cursor],
    ),
    query(
      `SELECT h.message_id, m.conversation_id, h.change_seq, h.changed_at
       FROM message_hides h JOIN messages m ON m.id = h.message_id
       WHERE h.user_id = $1 AND h.change_seq > $2 ORDER BY h.change_seq LIMIT ${SYNC_PAGE}`,
      [userId, cursor],
    ),
    query(
      `SELECT conversation_id, last_read_seq, cleared_before_seq, hidden, change_seq, changed_at
       FROM conversation_members WHERE user_id = $1 AND change_seq > $2
       ORDER BY change_seq LIMIT ${SYNC_PAGE}`,
      [userId, cursor],
    ),
    queryOne<{ now: Date }>('SELECT clock_timestamp() AS now'),
  ]);

  // If any stream filled its page, only return changes up to the smallest
  // last-seq among full streams so no stream skips ahead of another.
  let upper = Infinity;
  for (const rows of [msgRows, receiptRows, hideRows, memberRows]) {
    if (rows.length === SYNC_PAGE) upper = Math.min(upper, Number(rows.at(-1)!.change_seq));
  }
  const within = <T extends { change_seq: string | number }>(rows: T[]) => rows.filter((r) => Number(r.change_seq) <= upper);
  const messages = within(msgRows);
  const receipts = within(receiptRows);
  const hides = within(hideRows);
  const members = within(memberRows);

  const all = [...messages, ...receipts, ...hides, ...members];
  const hasMore = upper !== Infinity;
  let next = cursor;
  if (all.length) {
    const maxSeq = Math.max(...all.map((r) => Number(r.change_seq)));
    if (hasMore) {
      next = upper;
    } else {
      // Hold the cursor behind very recent changes: a lower seq allocated by a
      // still-open transaction could commit after this read. Re-sending recent
      // rows next time is harmless because clients apply changes idempotently.
      const horizon = nowRow!.now.getTime() - SYNC_SAFETY_MS;
      const recent = all.filter((r) => new Date(r.changed_at).getTime() > horizon).map((r) => Number(r.change_seq));
      next = recent.length ? Math.max(cursor, Math.min(...recent) - 1) : maxSeq;
    }
  }

  return {
    messages: messages.map(toMessageDto),
    receipts: receipts.map((r) => ({
      message_id: r.message_id,
      conversation_id: r.conversation_id,
      user_id: r.user_id,
      status: r.status,
      delivered_at: r.delivered_at,
      read_at: r.read_at,
    })),
    hidden: hides.map((h) => ({ message_id: h.message_id, conversation_id: h.conversation_id })),
    conversations: members.map((c) => ({
      conversation_id: c.conversation_id,
      last_read_seq: Number(c.last_read_seq),
      cleared_before_seq: Number(c.cleared_before_seq),
      hidden: c.hidden,
    })),
    cursor: String(next),
    has_more: hasMore,
  };
}

/**
 * Current head of the change stream. A client that loads state through REST
 * starts syncing from here: it connects its socket first (so later commits
 * arrive live), reads the head, then loads conversations/history.
 */
export async function syncHead() {
  const r = await queryOne<{ last_value: string; is_called: boolean }>('SELECT last_value, is_called FROM sync_seq');
  return { cursor: r!.is_called ? r!.last_value : '0' };
}

/** Messages addressed to the user that no device of theirs has confirmed yet. */
export async function undeliveredCount(userId: string) {
  const r = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM message_receipts WHERE user_id = $1 AND status = 'sent'`,
    [userId],
  );
  return r?.n ?? 0;
}
