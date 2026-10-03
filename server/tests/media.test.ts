import { describe, expect, it } from 'vitest';
import { api, createUser, useServer, type TestUser } from './helpers.js';

const srv = useServer();

// Smallest valid PNG (1x1 transparent pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(user: TestUser, bytes: Buffer, declared = 'image/png', filename = 'a.png', purpose = 'avatar') {
  const init = await api(srv.url, 'POST', '/api/media/uploads', {
    token: user.accessToken,
    body: { purpose, mime_type: declared, size_bytes: bytes.length, filename },
  });
  if (init.status !== 200) return { init };
  const form = new FormData();
  for (const [k, v] of Object.entries(init.body.upload.fields as Record<string, string>)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: declared }));
  const put = await fetch(init.body.upload.url, { method: 'POST', body: form });
  const complete = await api(srv.url, 'POST', `/api/media/${init.body.media_id}/complete`, { token: user.accessToken });
  return { init, put, complete, mediaId: init.body.media_id as string };
}

describe('media uploads', () => {
  it('uploads directly to object storage, verifies content, and serves a signed URL', async () => {
    const u = await createUser(srv.url);
    const r = await upload(u, PNG);
    expect(r.put!.status).toBe(204);
    expect(r.complete!.status).toBe(200);
    expect(r.complete!.body).toMatchObject({ state: 'ready', mime_type: 'image/png', size_bytes: PNG.length });

    const url = await api(srv.url, 'GET', `/api/media/${r.mediaId}/url`, { token: u.accessToken });
    expect(url.status).toBe(200);
    const file = await fetch(url.body.url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('rejects content that does not match the declared MIME type', async () => {
    const u = await createUser(srv.url);
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const r = await upload(u, html, 'image/png', 'evil.png');
    expect(r.complete!.status).toBe(422);
    const url = await api(srv.url, 'GET', `/api/media/${r.mediaId}/url`, { token: u.accessToken });
    expect(url.status).toBe(404);
  });

  it('enforces allow-list, extension and size before issuing an upload URL', async () => {
    const u = await createUser(srv.url);
    const bad = (body: object) => api(srv.url, 'POST', '/api/media/uploads', { token: u.accessToken, body });
    expect((await bad({ purpose: 'avatar', mime_type: 'image/svg+xml', size_bytes: 10, filename: 'a.svg' })).status).toBe(400);
    expect((await bad({ purpose: 'avatar', mime_type: 'image/png', size_bytes: 10, filename: 'a.exe' })).status).toBe(400);
    expect((await bad({ purpose: 'avatar', mime_type: 'image/png', size_bytes: 50 * 1024 * 1024, filename: 'a.png' })).status).toBe(400);
    expect((await bad({ purpose: 'avatar', mime_type: 'video/mp4', size_bytes: 10, filename: 'a.mp4' })).status).toBe(400);
  });

  it('storage refuses bytes beyond the signed size range', async () => {
    const u = await createUser(srv.url);
    const init = await api(srv.url, 'POST', '/api/media/uploads', {
      token: u.accessToken,
      body: { purpose: 'avatar', mime_type: 'image/png', size_bytes: PNG.length, filename: 'a.png' },
    });
    const form = new FormData();
    for (const [k, v] of Object.entries(init.body.upload.fields as Record<string, string>)) form.append(k, v);
    form.append('file', new Blob([new Uint8Array(Buffer.concat([PNG, Buffer.alloc(200_000)]))]));
    const put = await fetch(init.body.upload.url, { method: 'POST', body: form });
    expect(put.status).toBe(400);
  });

  it('profile photo visibility follows privacy settings', async () => {
    const owner = await createUser(srv.url, 'Owner');
    const other = await createUser(srv.url, 'Other');
    const r = await upload(owner, PNG);
    // Not yet set as avatar -> others can't fetch it.
    expect((await api(srv.url, 'GET', `/api/media/${r.mediaId}/url`, { token: other.accessToken })).status).toBe(404);

    await api(srv.url, 'PATCH', '/api/users/me', { token: owner.accessToken, body: { profile_photo_id: r.mediaId } });
    expect((await api(srv.url, 'GET', `/api/media/${r.mediaId}/url`, { token: other.accessToken })).status).toBe(200);
    const profile = await api(srv.url, 'GET', `/api/users/${owner.id}`, { token: other.accessToken });
    expect(profile.body.profile_photo_id).toBe(r.mediaId);

    await api(srv.url, 'PATCH', '/api/users/me/privacy', { token: owner.accessToken, body: { profile_photo: 'nobody' } });
    expect((await api(srv.url, 'GET', `/api/media/${r.mediaId}/url`, { token: other.accessToken })).status).toBe(404);
    expect((await api(srv.url, 'GET', `/api/users/${owner.id}`, { token: other.accessToken })).body.profile_photo_id).toBeNull();
  });

  it("can't complete someone else's upload", async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const init = await api(srv.url, 'POST', '/api/media/uploads', {
      token: a.accessToken,
      body: { purpose: 'avatar', mime_type: 'image/png', size_bytes: 10, filename: 'a.png' },
    });
    expect((await api(srv.url, 'POST', `/api/media/${init.body.media_id}/complete`, { token: b.accessToken })).status).toBe(404);
  });
});
