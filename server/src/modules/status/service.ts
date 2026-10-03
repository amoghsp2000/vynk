import { query, queryOne } from '../../database/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { sendToUsers } from '../../websocket/bus.js';
import { deleteObject } from '../media/storage.js';
import { registerMediaAccessChecker, requireOwnReadyMedia } from '../media/service.js';
import { canViewerSee, loadRelations, loadRelationsForViewers } from '../users/privacy.js';
import { getProfiles, type PublicProfile } from '../users/service.js';
import { getOrCreateDirect } from '../conversations/service.js';
import { sendMessage } from '../messages/service.js';

/**
 * Visibility: a status from owner U is visible to viewer V when U's `status`
 * privacy allows V (everyone / U's contacts / nobody) and neither blocked the
 * other. The *feed* additionally limits owners to people V knows (V's contacts
 * and 1:1 chat partners) so "everyone" doesn't mean "every user on the server".
 * Audience is evaluated at view time, not snapshotted at post time.
 */

interface StatusRow {
  id: string;
  user_id: string;
  type: 'text' | 'image' | 'video';
  text: string | null;
  bg_color: string | null;
  font: number | null;
  media_id: string | null;
  media_mime: string | null;
  created_at: Date;
  expires_at: Date;
  viewed?: boolean;
  view_count?: number;
}

const STATUS_SELECT = `
  s.id, s.user_id, s.type, s.text, s.bg_color, s.font, s.media_id, s.created_at, s.expires_at,
  COALESCE(mo.detected_mime, mo.declared_mime) AS media_mime`;

const LIVE = `s.expires_at > now() AND s.deleted_at IS NULL`;

function toDto(r: StatusRow) {
  return {
    id: r.id,
    user_id: r.user_id,
    type: r.type,
    text: r.text,
    bg_color: r.bg_color,
    font: r.font,
    media_id: r.media_id,
    media_mime: r.media_mime,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at.toISOString(),
    ...(r.viewed !== undefined ? { viewed: r.viewed } : {}),
    ...(r.view_count !== undefined ? { view_count: r.view_count } : {}),
  };
}

/** People whose statuses may appear in `viewerId`'s feed (before privacy filtering). */
async function feedCandidates(viewerId: string) {
  const rows = await query<{ uid: string }>(
    `SELECT contact_id AS uid FROM contacts WHERE owner_id = $1
     UNION
     SELECT o.user_id FROM conversation_members me
     JOIN conversations c ON c.id = me.conversation_id AND c.type = 'direct'
     JOIN conversation_members o ON o.conversation_id = c.id AND o.user_id <> $1
     WHERE me.user_id = $1`,
    [viewerId],
  );
  return rows.map((r) => r.uid);
}

/** People who may currently see `ownerId`'s statuses and would have them in their feed. */
async function audienceOf(ownerId: string) {
  const rows = await query<{ uid: string }>(
    `SELECT owner_id AS uid FROM contacts WHERE contact_id = $1
     UNION
     SELECT o.user_id FROM conversation_members me
     JOIN conversations c ON c.id = me.conversation_id AND c.type = 'direct'
     JOIN conversation_members o ON o.conversation_id = c.id AND o.user_id <> $1
     WHERE me.user_id = $1`,
    [ownerId],
  );
  const rels = await loadRelationsForViewers(ownerId, rows.map((r) => r.uid));
  return rows.map((r) => r.uid).filter((id) => {
    const rel = rels.get(id);
    return rel && canViewerSee(rel, 'status');
  });
}

async function canView(viewerId: string, ownerId: string) {
  if (viewerId === ownerId) return true;
  const rel = (await loadRelations(viewerId, [ownerId])).get(ownerId);
  return Boolean(rel && canViewerSee(rel, 'status'));
}

async function loadLive(statusId: string) {
  return queryOne<StatusRow>(
    `SELECT ${STATUS_SELECT} FROM status_updates s LEFT JOIN media_objects mo ON mo.id = s.media_id
     WHERE s.id = $1 AND ${LIVE}`,
    [statusId],
  );
}

/** Loads a status the viewer may see, or 404 (same for missing/expired/forbidden). */
async function requireVisible(viewerId: string, statusId: string) {
  const s = await loadLive(statusId);
  if (!s || !(await canView(viewerId, s.user_id))) throw notFound('Status');
  return s;
}

export async function createStatus(
  userId: string,
  input: {
    type: 'text' | 'image' | 'video';
    text?: string | undefined;
    bg_color?: string | undefined;
    font?: number | undefined;
    media_id?: string | undefined;
  },
) {
  if (input.type === 'text') {
    if (!input.text?.trim()) throw badRequest('Text status needs text');
    if (input.media_id) throw badRequest('Text status cannot have media');
  } else {
    if (!input.media_id) throw badRequest(`${input.type} status needs media_id`);
    const m = await requireOwnReadyMedia(userId, input.media_id, 'status');
    const kind = (m.detected_mime ?? m.declared_mime).split('/')[0];
    if (kind !== input.type) throw badRequest(`Uploaded file is not an ${input.type}`);
  }
  const row = await queryOne<{ id: string }>(
    `INSERT INTO status_updates (user_id, type, text, bg_color, font, media_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, input.type, input.text ?? null, input.bg_color ?? null, input.font ?? null, input.media_id ?? null],
  );
  const status = (await loadLive(row!.id))!;
  logger.info({ statusId: status.id, userId, type: status.type }, 'status: created');
  // Lightweight hint; clients refetch the feed. No content in the event.
  await sendToUsers(await audienceOf(userId), 'status.updated', { user_id: userId });
  await sendToUsers([userId], 'status.updated', { user_id: userId });
  return toDto({ ...status, view_count: 0 });
}

export async function feed(viewerId: string) {
  const candidates = await feedCandidates(viewerId);
  const rels = await loadRelations(viewerId, candidates);
  const visibleOwners = candidates.filter((id) => {
    const rel = rels.get(id);
    return rel && canViewerSee(rel, 'status');
  });

  const [others, mine] = await Promise.all([
    query<StatusRow>(
      `SELECT ${STATUS_SELECT},
              EXISTS (SELECT 1 FROM status_views v WHERE v.status_id = s.id AND v.viewer_id = $1) AS viewed
       FROM status_updates s LEFT JOIN media_objects mo ON mo.id = s.media_id
       WHERE s.user_id = ANY($2::uuid[]) AND ${LIVE}
       ORDER BY s.created_at`,
      [viewerId, visibleOwners],
    ),
    query<StatusRow>(
      `SELECT ${STATUS_SELECT},
              (SELECT count(*)::int FROM status_views v JOIN user_privacy p ON p.user_id = v.viewer_id
                WHERE v.status_id = s.id AND p.read_receipts) AS view_count
       FROM status_updates s LEFT JOIN media_objects mo ON mo.id = s.media_id
       WHERE s.user_id = $1 AND ${LIVE}
       ORDER BY s.created_at`,
      [viewerId],
    ),
  ]);

  const groups = new Map<string, StatusRow[]>();
  for (const s of others) groups.set(s.user_id, [...(groups.get(s.user_id) ?? []), s]);
  const profiles = await getProfiles(viewerId, [...groups.keys()]);

  const list = [...groups.entries()].map(([uid, statuses]) => ({
    user: profiles.get(uid) as PublicProfile,
    statuses: statuses.map(toDto),
    latest_at: statuses.at(-1)!.created_at.toISOString(),
    all_viewed: statuses.every((s) => s.viewed),
  }));
  // Unseen updates first, each section newest first.
  list.sort((a, b) => Number(a.all_viewed) - Number(b.all_viewed) || b.latest_at.localeCompare(a.latest_at));
  return { mine: mine.map(toDto), updates: list };
}

export async function getStatus(viewerId: string, statusId: string) {
  const s = await requireVisible(viewerId, statusId);
  const viewed = await queryOne('SELECT 1 FROM status_views WHERE status_id = $1 AND viewer_id = $2', [statusId, viewerId]);
  return toDto({ ...s, viewed: Boolean(viewed) });
}

export async function markViewed(viewerId: string, statusId: string) {
  const s = await requireVisible(viewerId, statusId);
  if (s.user_id === viewerId) return { ok: true };
  const inserted = await queryOne<{ viewed_at: Date }>(
    `INSERT INTO status_views (status_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING viewed_at`,
    [statusId, viewerId],
  );
  if (inserted) {
    const prefs = await queryOne<{ read_receipts: boolean }>('SELECT read_receipts FROM user_privacy WHERE user_id = $1', [viewerId]);
    // Viewers with read receipts off still get their own "seen" state, but the owner isn't told.
    if (prefs?.read_receipts !== false) {
      await sendToUsers([s.user_id], 'status.viewed', {
        status_id: statusId,
        viewer_id: viewerId,
        viewed_at: inserted.viewed_at.toISOString(),
      });
    }
  }
  return { ok: true };
}

export async function viewers(ownerId: string, statusId: string) {
  const s = await queryOne<{ user_id: string }>('SELECT user_id FROM status_updates WHERE id = $1 AND deleted_at IS NULL', [statusId]);
  if (!s || s.user_id !== ownerId) throw notFound('Status');
  const rows = await query<{ viewer_id: string; viewed_at: Date }>(
    `SELECT v.viewer_id, v.viewed_at FROM status_views v JOIN user_privacy p ON p.user_id = v.viewer_id
     WHERE v.status_id = $1 AND p.read_receipts ORDER BY v.viewed_at DESC`,
    [statusId],
  );
  const profiles = await getProfiles(ownerId, rows.map((r) => r.viewer_id));
  return {
    viewers: rows.map((r) => ({ user: profiles.get(r.viewer_id), viewed_at: r.viewed_at.toISOString() })),
  };
}

export async function deleteStatus(ownerId: string, statusId: string) {
  const s = await queryOne<{ media_key: string | null }>(
    `SELECT mo.object_key AS media_key FROM status_updates s LEFT JOIN media_objects mo ON mo.id = s.media_id
     WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL`,
    [statusId, ownerId],
  );
  if (!s) throw notFound('Status');
  await query('UPDATE status_updates SET deleted_at = now() WHERE id = $1', [statusId]);
  if (s.media_key) {
    await deleteObject(s.media_key).catch((err) => logger.error({ err, statusId }, 'status: media delete failed'));
    await query(`UPDATE media_objects SET state = 'deleted' WHERE object_key = $1`, [s.media_key]);
  }
  await sendToUsers([...(await audienceOf(ownerId)), ownerId], 'status.deleted', { user_id: ownerId, status_id: statusId });
  return { ok: true };
}

/** Replying to a status sends a normal 1:1 message that references it. */
export async function reply(viewerId: string, statusId: string, input: { client_msg_id: string; body: string }) {
  const s = await requireVisible(viewerId, statusId);
  if (s.user_id === viewerId) throw badRequest('You cannot reply to your own status');
  const conv = await getOrCreateDirect(viewerId, s.user_id);
  return sendMessage(viewerId, {
    conversation_id: conv.id,
    client_msg_id: input.client_msg_id,
    type: 'text',
    body: input.body,
    status_reply_id: statusId,
  });
}

/** Hard-deletes statuses (and their media) that expired or were deleted over an hour ago. */
export async function purgeExpired() {
  const rows = await query<{ id: string; media_id: string | null; object_key: string | null }>(
    `SELECT s.id, s.media_id, mo.object_key FROM status_updates s LEFT JOIN media_objects mo ON mo.id = s.media_id
     WHERE s.expires_at < now() - interval '1 hour' OR s.deleted_at < now() - interval '1 hour'
     LIMIT 1000`,
  );
  if (!rows.length) return 0;
  await query('DELETE FROM status_updates WHERE id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
  for (const r of rows) {
    if (!r.object_key) continue;
    await deleteObject(r.object_key).catch(() => undefined);
    await query('DELETE FROM media_objects WHERE id = $1', [r.media_id]);
  }
  logger.info({ count: rows.length }, 'status: purged expired');
  return rows.length;
}

// Status media is viewable exactly when its status is.
registerMediaAccessChecker('status', async (viewerId, media) => {
  const s = await queryOne<{ user_id: string }>(
    `SELECT s.user_id FROM status_updates s WHERE s.media_id = $1 AND ${LIVE}`,
    [media.id],
  );
  return Boolean(s && (await canView(viewerId, s.user_id)));
});
