import { afterEach, describe, expect, it } from 'vitest';
import { api, createUser, loginAgain, sleep, useServer, waitFor, type TestUser } from './helpers.js';
import { TestSocket } from './wsClient.js';
import { pool } from '../src/database/pool.js';
import { redis } from '../src/lib/redis.js';
import { startServer } from '../src/server.js';
import * as presence from '../src/modules/presence/service.js';

// Test env: PRESENCE_GRACE_MS=300, HEARTBEAT_INTERVAL_MS=1000.
const GRACE = 300;
const srv = useServer();
const sockets: TestSocket[] = [];
const connect = async (u: TestUser, wsUrl = srv.wsUrl) => {
  const s = await TestSocket.connect(wsUrl, u.accessToken);
  sockets.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const dbStatus = async (id: string) =>
  (await pool.query('SELECT online_status, last_seen FROM users WHERE id = $1', [id])).rows[0];

async function watcherOf(target: TestUser) {
  const w = await createUser(srv.url, 'Watcher');
  const s = await connect(w);
  const r = await s.request('presence.subscribe', { user_ids: [target.id] });
  return { w, s, snapshot: r.result.presence };
}

describe('presence', () => {
  it('goes online on connect and offline (with last_seen) after the grace period', async () => {
    const a = await createUser(srv.url, 'A');
    const { s: watcher } = await watcherOf(a);

    const sa = await connect(a);
    const on = await watcher.waitEvent('presence', (e) => e.payload.online === true);
    expect(on.payload.user_id).toBe(a.id);
    expect((await dbStatus(a.id)).online_status).toBe('online');

    await sa.close();
    await sleep(GRACE / 2);
    expect((await dbStatus(a.id)).online_status).toBe('online'); // still within grace
    const off = await watcher.waitEvent('presence', (e) => e.payload.online === false);
    expect(off.payload.last_seen).toBeTruthy();
    const row = await dbStatus(a.id);
    expect(row.online_status).toBe('offline');
    expect(row.last_seen).toBeInstanceOf(Date);
  });

  it('stays online while any device is connected', async () => {
    const a = await createUser(srv.url);
    const a2 = await loginAgain(srv.url, a);
    const { s: watcher } = await watcherOf(a);
    const s1 = await connect(a);
    const s2 = await connect(a2);
    await watcher.waitEvent('presence', (e) => e.payload.online === true);

    await s1.close();
    await sleep(GRACE * 3);
    expect(watcher.of('presence').filter((e) => e.payload.online === false)).toHaveLength(0);
    expect((await dbStatus(a.id)).online_status).toBe('online');

    await s2.close();
    await watcher.waitEvent('presence', (e) => e.payload.online === false);
  });

  it('a reconnect inside the grace period does not flap offline', async () => {
    const a = await createUser(srv.url);
    const { s: watcher } = await watcherOf(a);
    const s1 = await connect(a);
    await watcher.waitEvent('presence', (e) => e.payload.online === true);
    await s1.close();
    await sleep(GRACE / 3);
    await connect(a); // e.g. Wi-Fi -> mobile data handover
    await sleep(GRACE * 3);
    expect(watcher.of('presence').filter((e) => e.payload.online === false)).toHaveLength(0);
  });

  it('terminates stale connections that stop answering heartbeats', async () => {
    const a = await createUser(srv.url);
    const { s: watcher } = await watcherOf(a);
    const sa = await connect(a);
    await watcher.waitEvent('presence', (e) => e.payload.online === true);
    // Simulate a half-open connection: the client stops reading (and so never pongs).
    (sa.ws as any)._socket.pause();
    await watcher.waitEvent('presence', (e) => e.payload.online === false, 5000);
  });

  it('respects online/last-seen privacy and blocking', async () => {
    const a = await createUser(srv.url);
    await api(srv.url, 'PATCH', '/api/users/me/privacy', { token: a.accessToken, body: { online: 'nobody', last_seen: 'nobody' } });
    const { s: watcher, snapshot } = await watcherOf(a);
    expect(snapshot[0]).toMatchObject({ user_id: a.id, online: null, last_seen: null });
    const sa = await connect(a);
    await sleep(200);
    await sa.close();
    await sleep(GRACE * 2);
    expect(watcher.of('presence')).toHaveLength(0);
  });

  it('subscription snapshot reports current state', async () => {
    const a = await createUser(srv.url);
    await connect(a);
    const { snapshot } = await watcherOf(a);
    expect(snapshot[0]).toMatchObject({ user_id: a.id, online: true });
  });

  it('reaps connections of a crashed instance', async () => {
    const a = await createUser(srv.url);
    // Fake a connection held by an instance that stopped heartbeating long ago.
    await pool.query(`UPDATE users SET online_status = 'online' WHERE id = $1`, [a.id]);
    await redis.hset(`presence:conns:${a.id}`, 'ghost-conn', 'dead-instance');
    await redis.sadd('presence:instance:dead-instance', `${a.id}|ghost-conn`);
    await redis.zadd('presence:instances', Date.now() - 120_000, 'dead-instance');
    await presence.reapDeadInstances();
    expect(await presence.isOnline(a.id)).toBe(false);
    await waitFor(async () => (await dbStatus(a.id)).online_status === 'offline');
  });

  it('survives a server restart: clients reconnect and presence recovers', async () => {
    const a = await createUser(srv.url);
    const s2 = await startServer({ host: '127.0.0.1', port: 0 });
    const wsUrl = s2.url.replace('http', 'ws') + '/ws';
    const sa = await connect(a, wsUrl);
    expect(await presence.isOnline(a.id)).toBe(true);

    await s2.close(); // "restart": all sockets get 1012
    await waitFor(() => sa.closeCode);
    expect(sa.closeCode).toBe(1012);

    // Client reconnects (to the surviving instance) within the grace period.
    await connect(a);
    await sleep(GRACE * 3);
    expect((await dbStatus(a.id)).online_status).toBe('online');
  });
});

describe('typing indicators', () => {
  async function pair() {
    const a = await createUser(srv.url, 'A');
    const b = await createUser(srv.url, 'B');
    const c = await api(srv.url, 'POST', '/api/conversations', { token: a.accessToken, body: { user_id: b.id } });
    return { a, b, conv: c.body.id as string };
  }

  it('relays start/stop to other members only and stores nothing', async () => {
    const { a, b, conv } = await pair();
    const sa = await connect(a);
    const sb = await connect(b);
    expect((await sa.request('typing.start', { conversation_id: conv })).ok).toBe(true);
    const t = await sb.waitEvent('user.typing');
    expect(t.payload).toEqual({ conversation_id: conv, user_id: a.id });
    expect(t.from).toBe(a.id);
    await sa.request('typing.stop', { conversation_id: conv });
    await sb.waitEvent('user.stopped_typing');
    expect(sa.of('user.typing')).toHaveLength(0);
    const tables = await pool.query(`SELECT 1 FROM pg_tables WHERE tablename ILIKE '%typing%'`);
    expect(tables.rowCount).toBe(0);
  });

  it('rejects non-members and does not relay across blocks', async () => {
    const { a, b, conv } = await pair();
    const eve = await createUser(srv.url);
    const se = await connect(eve);
    expect((await se.request('typing.start', { conversation_id: conv })).error.code).toBe('not_found');

    await api(srv.url, 'POST', '/api/blocks', { token: b.accessToken, body: { user_id: a.id } });
    const sa = await connect(a);
    const sb = await connect(b);
    await sa.request('typing.start', { conversation_id: conv });
    await sleep(150);
    expect(sb.of('user.typing')).toHaveLength(0);
  });

  it('is rate limited', async () => {
    const { a, conv } = await pair();
    const sa = await connect(a);
    const acks = await Promise.all(Array.from({ length: 45 }, () => sa.request('typing.start', { conversation_id: conv })));
    expect(acks.some((x) => x.error?.code === 'rate_limited')).toBe(true);
  });
});
