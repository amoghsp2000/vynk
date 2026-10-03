import { randomUUID } from 'node:crypto';
import { query, queryOne } from '../../database/pool.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { deleteObject, headObject, presignDownload, presignUpload, readHead } from './storage.js';
import { sniffMime } from './sniff.js';
import { canViewerSee, loadRelations } from '../users/privacy.js';

export type MediaPurpose = 'avatar' | 'status' | 'attachment';

const MB = 1024 * 1024;
const IMAGE_EXT: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
};
const VIDEO_EXT: Record<string, string[]> = {
  'video/mp4': ['mp4', 'm4v'],
  'video/webm': ['webm'],
};

/** Per-purpose allow-list: MIME -> max bytes. */
const POLICY: Record<MediaPurpose, Record<string, number>> = {
  avatar: { 'image/jpeg': 5 * MB, 'image/png': 5 * MB, 'image/webp': 5 * MB },
  status: {
    'image/jpeg': 10 * MB,
    'image/png': 10 * MB,
    'image/webp': 10 * MB,
    'image/gif': 10 * MB,
    'video/mp4': 30 * MB,
    'video/webm': 30 * MB,
  },
  attachment: { 'image/jpeg': 16 * MB, 'image/png': 16 * MB, 'image/webp': 16 * MB, 'image/gif': 16 * MB },
};

export interface MediaRow {
  id: string;
  owner_id: string;
  purpose: MediaPurpose;
  object_key: string;
  declared_mime: string;
  detected_mime: string | null;
  size_bytes: string | null;
  state: 'pending' | 'ready' | 'rejected' | 'deleted';
  created_at: Date;
}

export const toMediaDto = (m: MediaRow) => ({
  id: m.id,
  purpose: m.purpose,
  mime_type: m.detected_mime ?? m.declared_mime,
  size_bytes: m.size_bytes === null ? null : Number(m.size_bytes),
  state: m.state,
  created_at: m.created_at,
});

export async function createUpload(
  ownerId: string,
  input: { purpose: MediaPurpose; mime_type: string; size_bytes: number; filename: string },
) {
  const allowed = POLICY[input.purpose];
  const max = allowed[input.mime_type];
  if (!max) throw badRequest(`File type ${input.mime_type} is not allowed for ${input.purpose}`);
  if (input.size_bytes > max) throw badRequest(`File too large (max ${Math.floor(max / MB)} MB)`);
  const ext = input.filename.split('.').pop()?.toLowerCase() ?? '';
  const validExt = { ...IMAGE_EXT, ...VIDEO_EXT }[input.mime_type] ?? [];
  if (!validExt.includes(ext)) throw badRequest(`File extension .${ext} does not match ${input.mime_type}`);

  const id = randomUUID();
  // Key never contains user-supplied text.
  const key = `${input.purpose}/${ownerId}/${id}`;
  await query(
    `INSERT INTO media_objects (id, owner_id, purpose, object_key, declared_mime, original_name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, ownerId, input.purpose, key, input.mime_type, input.filename.slice(0, 255)],
  );
  const post = await presignUpload(key, input.mime_type, Math.min(max, Math.ceil(input.size_bytes * 1.01) + 1024));
  return { media_id: id, upload: { url: post.url, fields: post.fields }, expires_in: 300, max_bytes: max };
}

const equivalentMime = (declared: string, detected: string | null) => detected === declared;

/** Verifies the uploaded object actually is what was declared, then marks it ready. */
export async function completeUpload(ownerId: string, mediaId: string) {
  const m = await queryOne<MediaRow>('SELECT * FROM media_objects WHERE id = $1', [mediaId]);
  if (!m || m.owner_id !== ownerId) throw notFound('Media');
  if (m.state === 'ready') return toMediaDto(m); // idempotent
  if (m.state !== 'pending') throw badRequest(`Media is ${m.state}`);

  const head = await headObject(m.object_key);
  if (!head) throw badRequest('Upload not found in storage — upload the file before completing');
  const max = POLICY[m.purpose][m.declared_mime] ?? 0;
  const detected = sniffMime(await readHead(m.object_key));

  if (head.size > max || !equivalentMime(m.declared_mime, detected)) {
    await deleteObject(m.object_key).catch((err) => logger.error({ err, mediaId }, 'media: failed to delete rejected object'));
    await query(`UPDATE media_objects SET state = 'rejected', detected_mime = $2, size_bytes = $3 WHERE id = $1`, [
      mediaId,
      detected,
      head.size,
    ]);
    logger.warn({ mediaId, declared: m.declared_mime, detected, size: head.size }, 'media: upload rejected');
    throw new AppError(422, 'invalid_media', 'File content does not match its declared type or exceeds the size limit');
  }
  const row = await queryOne<MediaRow>(
    `UPDATE media_objects SET state = 'ready', detected_mime = $2, size_bytes = $3, completed_at = now()
     WHERE id = $1 RETURNING *`,
    [mediaId, detected, head.size],
  );
  return toMediaDto(row!);
}

/** Loads media that `ownerId` may attach for `purpose` (must be ready and theirs). */
export async function requireOwnReadyMedia(ownerId: string, mediaId: string, purpose: MediaPurpose) {
  const m = await queryOne<MediaRow>('SELECT * FROM media_objects WHERE id = $1', [mediaId]);
  if (!m || m.owner_id !== ownerId) throw notFound('Media');
  if (m.purpose !== purpose) throw badRequest(`Media was uploaded for ${m.purpose}, not ${purpose}`);
  if (m.state !== 'ready') throw badRequest('Media upload is not complete');
  return m;
}

/** Status-media visibility is registered by the status module to avoid a circular import. */
type Checker = (viewerId: string, media: MediaRow) => Promise<boolean>;
const extraCheckers: Partial<Record<MediaPurpose, Checker>> = {};
export const registerMediaAccessChecker = (purpose: MediaPurpose, fn: Checker) => {
  extraCheckers[purpose] = fn;
};

async function canView(viewerId: string, m: MediaRow): Promise<boolean> {
  if (m.state !== 'ready') return false;
  if (m.owner_id === viewerId) return true;
  switch (m.purpose) {
    case 'avatar': {
      const current = await queryOne('SELECT 1 FROM users WHERE id = $1 AND profile_photo_id = $2', [m.owner_id, m.id]);
      if (!current) return false;
      const rel = (await loadRelations(viewerId, [m.owner_id])).get(m.owner_id);
      return Boolean(rel && canViewerSee(rel, 'profile_photo'));
    }
    case 'attachment': {
      const r = await queryOne(
        `SELECT 1 FROM messages msg
         JOIN conversation_members cm ON cm.conversation_id = msg.conversation_id AND cm.user_id = $2
         WHERE msg.media_id = $1 AND msg.deleted_at IS NULL LIMIT 1`,
        [m.id, viewerId],
      );
      return Boolean(r);
    }
    default:
      return (await extraCheckers[m.purpose]?.(viewerId, m)) ?? false;
  }
}

export async function getViewUrl(viewerId: string, mediaId: string) {
  const m = await queryOne<MediaRow>('SELECT * FROM media_objects WHERE id = $1', [mediaId]);
  // Same 404 for "missing" and "forbidden" so ids can't be probed.
  if (!m || !(await canView(viewerId, m))) throw notFound('Media');
  const mime = m.detected_mime ?? m.declared_mime;
  return { url: await presignDownload(m.object_key, mime), mime_type: mime, expires_in: 300 };
}

/** Removes stale unfinished uploads (called by the jobs runner). */
export async function cleanupPendingUploads(olderThanMinutes = 60) {
  const rows = await query<{ id: string; object_key: string }>(
    `DELETE FROM media_objects WHERE state IN ('pending', 'rejected') AND created_at < now() - make_interval(mins => $1)
     RETURNING id, object_key`,
    [olderThanMinutes],
  );
  for (const r of rows) await deleteObject(r.object_key).catch(() => undefined);
  return rows.length;
}

