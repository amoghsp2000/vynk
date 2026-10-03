import { query, queryOne } from '../../database/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { domainEvents } from '../../lib/domainEvents.js';
import { requireOwnReadyMedia } from '../media/service.js';
import { canViewerSee, loadRelations, type PrivacySettings, type Relation } from './privacy.js';

interface UserRow {
  id: string;
  phone_number: string;
  name: string;
  about: string;
  profile_photo_id: string | null;
  online_status: 'online' | 'offline';
  last_seen: Date | null;
}

export interface PublicProfile {
  id: string;
  phone_number: string;
  name: string;
  /** Name the viewer saved this user under, if any. */
  contact_name: string | null;
  about: string | null;
  profile_photo_id: string | null;
  online: boolean | null; // null = hidden by privacy
  last_seen: Date | null;
  is_contact: boolean;
  blocked_by_me: boolean;
}

function project(u: UserRow, rel: Relation | undefined, contactName: string | null): PublicProfile {
  const see = (f: Parameters<typeof canViewerSee>[1]) => (rel ? canViewerSee(rel, f) : false);
  return {
    id: u.id,
    phone_number: u.phone_number,
    name: u.name,
    contact_name: contactName,
    about: see('about') ? u.about : null,
    profile_photo_id: see('profile_photo') ? u.profile_photo_id : null,
    online: see('online') ? u.online_status === 'online' : null,
    last_seen: see('last_seen') ? u.last_seen : null,
    is_contact: rel?.viewerHasOwner ?? false,
    blocked_by_me: rel?.blockedByViewer ?? false,
  };
}

/** Privacy-filtered profiles of many users for one viewer, in two queries total. */
export async function getProfiles(viewerId: string, userIds: string[]): Promise<Map<string, PublicProfile>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, PublicProfile>();
  if (!ids.length) return out;
  const [users, rels] = await Promise.all([
    query<UserRow & { contact_name: string | null }>(
      `SELECT u.id, u.phone_number, u.name, u.about, u.profile_photo_id, u.online_status, u.last_seen,
              c.display_name AS contact_name
       FROM users u LEFT JOIN contacts c ON c.owner_id = $1 AND c.contact_id = u.id
       WHERE u.id = ANY($2::uuid[])`,
      [viewerId, ids],
    ),
    loadRelations(viewerId, ids),
  ]);
  for (const u of users) out.set(u.id, project(u, rels.get(u.id), u.contact_name));
  return out;
}

export async function getProfile(viewerId: string, userId: string) {
  const p = (await getProfiles(viewerId, [userId])).get(userId);
  if (!p) throw notFound('User');
  return p;
}

export async function getMe(userId: string) {
  const me = await queryOne(
    `SELECT u.id, u.phone_number, u.name, u.about, u.profile_photo_id, u.created_at, u.updated_at,
            row_to_json(p.*)::jsonb - 'user_id' - 'updated_at' AS privacy
     FROM users u JOIN user_privacy p ON p.user_id = u.id WHERE u.id = $1`,
    [userId],
  );
  if (!me) throw notFound('User');
  return me;
}

export async function updateMe(
  userId: string,
  patch: { name?: string | undefined; about?: string | undefined; profile_photo_id?: string | null | undefined },
) {
  if (patch.profile_photo_id) await requireOwnReadyMedia(userId, patch.profile_photo_id, 'avatar');
  const sets: string[] = [];
  const params: unknown[] = [userId];
  for (const [col, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    params.push(val);
    sets.push(`${col} = $${params.length}`); // column names come from the fixed schema keys above
  }
  if (sets.length) {
    await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
    domainEvents.emit('user.profileUpdated', { userId });
  }
  return getMe(userId);
}

export async function updatePrivacy(userId: string, patch: Partial<PrivacySettings>) {
  const allowed = ['last_seen', 'online', 'profile_photo', 'about', 'status', 'read_receipts'] as const;
  const sets: string[] = [];
  const params: unknown[] = [userId];
  for (const k of allowed) {
    if (patch[k] === undefined) continue;
    params.push(patch[k]);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length) await query(`UPDATE user_privacy SET ${sets.join(', ')} WHERE user_id = $1`, params);
  domainEvents.emit('user.profileUpdated', { userId });
  return (await getMe(userId)).privacy;
}

export async function findByPhone(viewerId: string, phone: string) {
  const u = await queryOne<{ id: string }>('SELECT id FROM users WHERE phone_number = $1', [phone]);
  if (!u) throw notFound('User');
  return getProfile(viewerId, u.id);
}

// ---- contacts ----

export async function listContacts(userId: string) {
  const rows = await query<{ contact_id: string }>(
    'SELECT contact_id FROM contacts WHERE owner_id = $1',
    [userId],
  );
  const profiles = await getProfiles(userId, rows.map((r) => r.contact_id));
  return [...profiles.values()].sort((a, b) => (a.contact_name ?? a.name).localeCompare(b.contact_name ?? b.name));
}

export async function addContact(ownerId: string, contactId: string, displayName: string | null) {
  if (ownerId === contactId) throw badRequest('You cannot add yourself as a contact');
  const exists = await queryOne('SELECT 1 FROM users WHERE id = $1', [contactId]);
  if (!exists) throw notFound('User');
  await query(
    `INSERT INTO contacts (owner_id, contact_id, display_name) VALUES ($1, $2, $3)
     ON CONFLICT (owner_id, contact_id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [ownerId, contactId, displayName],
  );
  return getProfile(ownerId, contactId);
}

export async function removeContact(ownerId: string, contactId: string) {
  await query('DELETE FROM contacts WHERE owner_id = $1 AND contact_id = $2', [ownerId, contactId]);
}

// ---- blocks ----

export async function listBlocked(userId: string) {
  const rows = await query<{ blocked_id: string }>(
    'SELECT blocked_id FROM blocks WHERE blocker_id = $1 ORDER BY created_at DESC',
    [userId],
  );
  const profiles = await getProfiles(userId, rows.map((r) => r.blocked_id));
  return rows.map((r) => profiles.get(r.blocked_id)).filter(Boolean);
}

export async function block(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) throw badRequest('You cannot block yourself');
  const exists = await queryOne('SELECT 1 FROM users WHERE id = $1', [blockedId]);
  if (!exists) throw notFound('User');
  await query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [blockerId, blockedId]);
  domainEvents.emit('user.blocked', { blockerId, blockedId });
}

export async function unblock(blockerId: string, blockedId: string) {
  await query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId]);
}

/** True if either user blocked the other. */
export async function isBlockedBetween(a: string, b: string) {
  const r = await queryOne(
    `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
    [a, b],
  );
  return Boolean(r);
}
