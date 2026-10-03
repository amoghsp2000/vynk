import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { api, createUser, sleep, useServer, type TestUser } from './helpers.js';
import { TestSocket } from './wsClient.js';
import { pool } from '../src/database/pool.js';
import { purgeExpired } from '../src/modules/status/service.js';

const srv = useServer();
const sockets: TestSocket[] = [];
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Owner and viewer who saved each other as contacts (default status privacy = contacts). */
async function friends(ownerName = 'Owner', viewerName = 'Viewer') {
  const owner = await createUser(srv.url, ownerName);
  const viewer = await createUser(srv.url, viewerName);
  await api(srv.url, 'POST', '/api/contacts', { token: owner.accessToken, body: { user_id: viewer.id } });
  await api(srv.url, 'POST', '/api/contacts', { token: viewer.accessToken, body: { user_id: owner.id } });
  return { owner, viewer };
}

const postText = (u: TestUser, text: string) =>
  api(srv.url, 'POST', '/api/status', { token: u.accessToken, body: { type: 'text', text, bg_color: '#336699' } });

async function uploadStatusImage(u: TestUser) {
  const init = await api(srv.url, 'POST', '/api/media/uploads', {
    token: u.accessToken,
    body: { purpose: 'status', mime_type: 'image/png', size_bytes: PNG.length, filename: 's.png' },
  });
  const form = new FormData();
  for (const [k, v] of Object.entries(init.body.upload.fields as Record<string, string>)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }));
  await fetch(init.body.upload.url, { method: 'POST', body: form });
  await api(srv.url, 'POST', `/api/media/${init.body.media_id}/complete`, { token: u.accessToken });
  return init.body.media_id as string;
}

describe('create & view', () => {
  it('creates a text status with 24h expiry and shows it to contacts', async () => {
    const { owner, viewer } = await friends();
    const r = await postText(owner, 'Good morning ☀️');
    expect(r.status).toBe(201);
    const ttl = Date.parse(r.body.expires_at) - Date.parse(r.body.created_at);
    expect(Math.round(ttl / 3600_000)).toBe(24);

    const feed = await api(srv.url, 'GET', '/api/status', { token: viewer.accessToken });
    expect(feed.body.updates).toHaveLength(1);
    expect(feed.body.updates[0].user.id).toBe(owner.id);
    expect(feed.body.updates[0].statuses[0]).toMatchObject({ text: 'Good morning ☀️', viewed: false });
    const mine = await api(srv.url, 'GET', '/api/status', { token: owner.accessToken });
    expect(mine.body.mine[0]).toMatchObject({ id: r.body.id, view_count: 0 });
  });

  it('creates an image status whose media is visible only to the audience', async () => {
    const { owner, viewer } = await friends();
    const stranger = await createUser(srv.url);
    const mediaId = await uploadStatusImage(owner);
    const r = await api(srv.url, 'POST', '/api/status', { token: owner.accessToken, body: { type: 'image', media_id: mediaId, text: 'caption' } });
    expect(r.status).toBe(201);
    expect(r.body.media_mime).toBe('image/png');
    expect((await api(srv.url, 'GET', `/api/media/${mediaId}/url`, { token: viewer.accessToken })).status).toBe(200);
    expect((await api(srv.url, 'GET', `/api/media/${mediaId}/url`, { token: stranger.accessToken })).status).toBe(404);
  });

  it('validates type/media combinations', async () => {
    const u = await createUser(srv.url);
    expect((await api(srv.url, 'POST', '/api/status', { token: u.accessToken, body: { type: 'text' } })).status).toBe(400);
    expect((await api(srv.url, 'POST', '/api/status', { token: u.accessToken, body: { type: 'image' } })).status).toBe(400);
    const mediaId = await uploadStatusImage(u);
    expect(
      (await api(srv.url, 'POST', '/api/status', { token: u.accessToken, body: { type: 'video', media_id: mediaId } })).status,
    ).toBe(400);
    const other = await createUser(srv.url);
    expect(
      (await api(srv.url, 'POST', '/api/status', { token: other.accessToken, body: { type: 'image', media_id: mediaId } })).status,
    ).toBe(404);
  });

  it('records views, notifies the owner, and lists viewers', async () => {
    const { owner, viewer } = await friends();
    const so = await TestSocket.connect(srv.wsUrl, owner.accessToken);
    sockets.push(so);
    const s = (await postText(owner, 'hi')).body;
    await api(srv.url, 'POST', `/api/status/${s.id}/view`, { token: viewer.accessToken });
    await api(srv.url, 'POST', `/api/status/${s.id}/view`, { token: viewer.accessToken }); // idempotent
    const ev = await so.waitEvent('status.viewed');
    expect(ev.payload).toMatchObject({ status_id: s.id, viewer_id: viewer.id });
    expect(so.of('status.viewed')).toHaveLength(1);

    const v = await api(srv.url, 'GET', `/api/status/${s.id}/viewers`, { token: owner.accessToken });
    expect(v.body.viewers.map((x: any) => x.user.id)).toEqual([viewer.id]);
    expect((await api(srv.url, 'GET', `/api/status/${s.id}/viewers`, { token: viewer.accessToken })).status).toBe(404);
    const feed = await api(srv.url, 'GET', '/api/status', { token: viewer.accessToken });
    expect(feed.body.updates[0].all_viewed).toBe(true);
  });

  it('viewers with read receipts off are not reported to the owner', async () => {
    const { owner, viewer } = await friends();
    await api(srv.url, 'PATCH', '/api/users/me/privacy', { token: viewer.accessToken, body: { read_receipts: false } });
    const s = (await postText(owner, 'hi')).body;
    await api(srv.url, 'POST', `/api/status/${s.id}/view`, { token: viewer.accessToken });
    const v = await api(srv.url, 'GET', `/api/status/${s.id}/viewers`, { token: owner.accessToken });
    expect(v.body.viewers).toHaveLength(0);
    const feed = await api(srv.url, 'GET', '/api/status', { token: viewer.accessToken });
    expect(feed.body.updates[0].all_viewed).toBe(true); // viewer's own seen state still tracked
  });

  it('orders unviewed updates first, newest first within each group', async () => {
    const viewer = await createUser(srv.url, 'Viewer');
    const owners: TestUser[] = [];
    for (const n of ['A', 'B', 'C']) {
      const o = await createUser(srv.url, n);
      await api(srv.url, 'POST', '/api/contacts', { token: o.accessToken, body: { user_id: viewer.id } });
      await api(srv.url, 'POST', '/api/contacts', { token: viewer.accessToken, body: { user_id: o.id } });
      owners.push(o);
    }
    const ids: string[] = [];
    for (const o of owners) {
      ids.push((await postText(o, `from ${o.name}`)).body.id);
      await sleep(20);
    }
    // Viewer has seen C's (newest) update.
    await api(srv.url, 'POST', `/api/status/${ids[2]}/view`, { token: viewer.accessToken });
    const feed = await api(srv.url, 'GET', '/api/status', { token: viewer.accessToken });
    expect(feed.body.updates.map((g: any) => g.user.name)).toEqual(['B', 'A', 'C']);
  });
});

describe('privacy', () => {
  it("'contacts' means people the owner saved", async () => {
    const owner = await createUser(srv.url);
    const fan = await createUser(srv.url); // fan saved owner, owner didn't save fan
    await api(srv.url, 'POST', '/api/contacts', { token: fan.accessToken, body: { user_id: owner.id } });
    const s = (await postText(owner, 'hi')).body;
    expect((await api(srv.url, 'GET', '/api/status', { token: fan.accessToken })).body.updates).toHaveLength(0);
    expect((await api(srv.url, 'GET', `/api/status/${s.id}`, { token: fan.accessToken })).status).toBe(404);
  });

  it("'nobody' hides from everyone; 'everyone' still limits the feed to known people", async () => {
    const { owner, viewer } = await friends();
    const stranger = await createUser(srv.url);
    await api(srv.url, 'PATCH', '/api/users/me/privacy', { token: owner.accessToken, body: { status: 'nobody' } });
    const s = (await postText(owner, 'hi')).body;
    expect((await api(srv.url, 'GET', '/api/status', { token: viewer.accessToken })).body.updates).toHaveLength(0);

    await api(srv.url, 'PATCH', '/api/users/me/privacy', { token: owner.accessToken, body: { status: 'everyone' } });
    expect((await api(srv.url, 'GET', '/api/status', { token: viewer.accessToken })).body.updates).toHaveLength(1);
    expect((await api(srv.url, 'GET', '/api/status', { token: stranger.accessToken })).body.updates).toHaveLength(0);
    expect((await api(srv.url, 'GET', `/api/status/${s.id}`, { token: stranger.accessToken })).status).toBe(200);
  });

  it('blocking hides statuses', async () => {
    const { owner, viewer } = await friends();
    await postText(owner, 'hi');
    await api(srv.url, 'POST', '/api/blocks', { token: owner.accessToken, body: { user_id: viewer.id } });
    expect((await api(srv.url, 'GET', '/api/status', { token: viewer.accessToken })).body.updates).toHaveLength(0);
  });
});

describe('expiry & delete', () => {
  it('expired statuses disappear and are purged with their media', async () => {
    const { owner, viewer } = await friends();
    const mediaId = await uploadStatusImage(owner);
    const s = (await api(srv.url, 'POST', '/api/status', { token: owner.accessToken, body: { type: 'image', media_id: mediaId } })).body;
    await pool.query(`UPDATE status_updates SET expires_at = now() - interval '1 second' WHERE id = $1`, [s.id]);

    expect((await api(srv.url, 'GET', '/api/status', { token: viewer.accessToken })).body.updates).toHaveLength(0);
    expect((await api(srv.url, 'GET', '/api/status', { token: owner.accessToken })).body.mine).toHaveLength(0);
    expect((await api(srv.url, 'GET', `/api/status/${s.id}`, { token: viewer.accessToken })).status).toBe(404);
    expect((await api(srv.url, 'GET', `/api/media/${mediaId}/url`, { token: viewer.accessToken })).status).toBe(404);

    await pool.query(`UPDATE status_updates SET expires_at = now() - interval '2 hours' WHERE id = $1`, [s.id]);
    expect(await purgeExpired()).toBe(1);
    expect((await pool.query('SELECT 1 FROM status_updates WHERE id = $1', [s.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM media_objects WHERE id = $1', [mediaId])).rowCount).toBe(0);
  });

  it('only the owner can delete; deletion notifies the audience', async () => {
    const { owner, viewer } = await friends();
    const sv = await TestSocket.connect(srv.wsUrl, viewer.accessToken);
    sockets.push(sv);
    const s = (await postText(owner, 'bye')).body;
    await sv.waitEvent('status.updated');
    expect((await api(srv.url, 'DELETE', `/api/status/${s.id}`, { token: viewer.accessToken })).status).toBe(404);
    expect((await api(srv.url, 'DELETE', `/api/status/${s.id}`, { token: owner.accessToken })).status).toBe(200);
    await sv.waitEvent('status.deleted', (e) => e.payload.status_id === s.id);
    expect((await api(srv.url, 'GET', '/api/status', { token: viewer.accessToken })).body.updates).toHaveLength(0);
  });
});

describe('reply', () => {
  it('replying sends a 1:1 message that references the status', async () => {
    const { owner, viewer } = await friends();
    const so = await TestSocket.connect(srv.wsUrl, owner.accessToken);
    sockets.push(so);
    const s = (await postText(owner, 'new haircut')).body;
    const r = await api(srv.url, 'POST', `/api/status/${s.id}/reply`, {
      token: viewer.accessToken,
      body: { client_msg_id: randomUUID(), body: 'Looks great!' },
    });
    expect(r.status).toBe(200);
    expect(r.body.message.status_reply_id).toBe(s.id);
    const ev = await so.waitEvent('message.new');
    expect(ev.payload).toMatchObject({ body: 'Looks great!', status_reply_id: s.id, sender_id: viewer.id });
    expect(
      (await api(srv.url, 'POST', `/api/status/${s.id}/reply`, {
        token: owner.accessToken,
        body: { client_msg_id: randomUUID(), body: 'self' },
      })).status,
    ).toBe(400);
  });
});
