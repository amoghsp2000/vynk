import { query } from '../../database/pool.js';

export type Visibility = 'everyone' | 'contacts' | 'nobody';
export type PrivacyField = 'last_seen' | 'online' | 'profile_photo' | 'about' | 'status';

export interface PrivacySettings {
  last_seen: Visibility;
  online: Visibility;
  profile_photo: Visibility;
  about: Visibility;
  status: Visibility;
  read_receipts: boolean;
}

/** Everything needed to decide what `viewer` may see of `owner`. */
export interface Relation {
  ownerId: string;
  viewerId: string;
  /** Owner saved the viewer as a contact ('contacts' visibility means *owner's* contacts). */
  ownerHasViewer: boolean;
  viewerHasOwner: boolean;
  blockedByOwner: boolean;
  blockedByViewer: boolean;
  privacy: PrivacySettings;
}

/**
 * Batch-loads relations between one viewer and many owners in a single query
 * (no N+1 when rendering chat lists or status feeds).
 */
export async function loadRelations(viewerId: string, ownerIds: string[]): Promise<Map<string, Relation>> {
  const ids = [...new Set(ownerIds)];
  const map = new Map<string, Relation>();
  if (!ids.length) return map;
  const rows = await query(
    `SELECT p.user_id,
            p.last_seen, p.online, p.profile_photo, p.about, p.status, p.read_receipts,
            EXISTS (SELECT 1 FROM contacts c WHERE c.owner_id = p.user_id AND c.contact_id = $1) AS owner_has_viewer,
            EXISTS (SELECT 1 FROM contacts c WHERE c.owner_id = $1 AND c.contact_id = p.user_id) AS viewer_has_owner,
            EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = p.user_id AND b.blocked_id = $1) AS blocked_by_owner,
            EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = p.user_id) AS blocked_by_viewer
     FROM user_privacy p WHERE p.user_id = ANY($2::uuid[])`,
    [viewerId, ids],
  );
  for (const r of rows) {
    map.set(r.user_id, {
      ownerId: r.user_id,
      viewerId,
      ownerHasViewer: r.owner_has_viewer,
      viewerHasOwner: r.viewer_has_owner,
      blockedByOwner: r.blocked_by_owner,
      blockedByViewer: r.blocked_by_viewer,
      privacy: {
        last_seen: r.last_seen,
        online: r.online,
        profile_photo: r.profile_photo,
        about: r.about,
        status: r.status,
        read_receipts: r.read_receipts,
      },
    });
  }
  return map;
}

/** Inverse batch: one owner, many viewers (e.g. who may see this presence change). */
export async function loadRelationsForViewers(ownerId: string, viewerIds: string[]): Promise<Map<string, Relation>> {
  const ids = [...new Set(viewerIds)];
  const map = new Map<string, Relation>();
  if (!ids.length) return map;
  const rows = await query(
    `SELECT v.viewer_id,
            p.last_seen, p.online, p.profile_photo, p.about, p.status, p.read_receipts,
            EXISTS (SELECT 1 FROM contacts c WHERE c.owner_id = $1 AND c.contact_id = v.viewer_id) AS owner_has_viewer,
            EXISTS (SELECT 1 FROM contacts c WHERE c.owner_id = v.viewer_id AND c.contact_id = $1) AS viewer_has_owner,
            EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = v.viewer_id) AS blocked_by_owner,
            EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = v.viewer_id AND b.blocked_id = $1) AS blocked_by_viewer
     FROM user_privacy p CROSS JOIN unnest($2::uuid[]) AS v(viewer_id)
     WHERE p.user_id = $1`,
    [ownerId, ids],
  );
  for (const r of rows) {
    map.set(r.viewer_id, {
      ownerId,
      viewerId: r.viewer_id,
      ownerHasViewer: r.owner_has_viewer,
      viewerHasOwner: r.viewer_has_owner,
      blockedByOwner: r.blocked_by_owner,
      blockedByViewer: r.blocked_by_viewer,
      privacy: {
        last_seen: r.last_seen,
        online: r.online,
        profile_photo: r.profile_photo,
        about: r.about,
        status: r.status,
        read_receipts: r.read_receipts,
      },
    });
  }
  return map;
}

export function canViewerSee(rel: Relation, field: PrivacyField): boolean {
  if (rel.ownerId === rel.viewerId) return true;
  // Blocking in either direction hides presence, photo, about and status.
  if (rel.blockedByOwner || rel.blockedByViewer) return false;
  const level = rel.privacy[field];
  return level === 'everyone' || (level === 'contacts' && rel.ownerHasViewer);
}

export const isBlockedEitherWay = (rel: Relation) => rel.blockedByOwner || rel.blockedByViewer;
