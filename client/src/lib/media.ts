import { useEffect, useState } from 'react';
import { api } from './api';

export type MediaPurpose = 'avatar' | 'status' | 'attachment';

/**
 * Upload flow: ask the API for a presigned POST, send the file straight to
 * object storage, then ask the API to verify it (magic bytes, size).
 */
export async function uploadFile(file: File, purpose: MediaPurpose): Promise<string> {
  const init = await api<{ media_id: string; upload: { url: string; fields: Record<string, string> } }>('POST', '/api/media/uploads', {
    purpose,
    mime_type: file.type,
    size_bytes: file.size,
    filename: file.name,
  });
  const form = new FormData();
  for (const [k, v] of Object.entries(init.upload.fields)) form.append(k, v);
  form.append('file', file);
  const res = await fetch(init.upload.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Upload to storage failed');
  await api('POST', `/api/media/${init.media_id}/complete`);
  return init.media_id;
}

// Signed URLs expire after 5 minutes; cache for 4.
const cache = new Map<string, { url: string; at: number; mime: string }>();
const inflight = new Map<string, Promise<{ url: string; mime: string } | null>>();

async function resolve(id: string) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 240_000) return hit;
  let p = inflight.get(id);
  if (!p) {
    p = api<{ url: string; mime_type: string }>('GET', `/api/media/${id}/url`)
      .then((r) => {
        const v = { url: r.url, at: Date.now(), mime: r.mime_type };
        cache.set(id, v);
        return v;
      })
      .catch(() => null)
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

/** Signed, short-lived URL for a media id the viewer is allowed to see (null if not). */
export function useMediaUrl(id: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(() => (id ? (cache.get(id)?.url ?? null) : null));
  useEffect(() => {
    let alive = true;
    if (!id) return setUrl(null);
    void resolve(id).then((r) => alive && setUrl(r?.url ?? null));
    return () => {
      alive = false;
    };
  }, [id]);
  return url;
}
