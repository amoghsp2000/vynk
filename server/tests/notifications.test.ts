import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, createUser, sleep, useServer, waitFor, type TestUser } from './helpers.js';
import { TestSocket } from './wsClient.js';
import { pool } from '../src/database/pool.js';
import { dispatchDue } from '../src/modules/notifications/service.js';
import { setProviderForTests, type PushMessage, type PushResult, type PushTarget } from '../src/modules/notifications/providers.js';

const srv = useServer();
const sockets: TestSocket[] = [];
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

// Captures pushes instead of contacting a real push service.
let sent: { target: PushTarget; msg: PushMessage }[] = [];
let nextResult: PushResult = 'ok';
beforeEach(() => {
  sent = [];
  nextResult = 'ok';
  setProviderForTests('webpush', {
    name: 'webpush',
    enabled: true,
    async send(target, msg) {
      sent.push({ target, msg });
      return nextResult;
    },
  });
});

const subscribe = (u: TestUser, n = 1) =>
  api(srv.url, 'PUT', '/api/devices/current/push', {
    token: u.accessToken,
    body: { provider: 'webpush', endpoint: `https://push.example.com/sub/${u.id}/${n}`, keys: { p256dh: 'B'.repeat(80), auth: 'A'.repeat(16) } },
  });

async function chat(a: TestUser, b: TestUser) {
  return (await api(srv.url, 'POST', '/api/conversations', { token: a.accessToken, body: { user_id: b.id } })).body.id as string;
}
const msg = (conversation_id: string, body: string) => ({ conversation_id, client_msg_id: randomUUID(), type: 'text', body });
const pending = async (userId: string) =>
  (await pool.query(`SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at`, [userId])).rows;

describe('push notifications', () => {
  it('pushes a minimal, collapsed notification to an offline recipient', async () => {
    const a = await createUser(srv.url, 'Alice');
    const b = await createUser(srv.url, 'Bob');
    expect((await subscribe(b)).status).toBe(200);
    const conv = await chat(a, b);
    for (const t of ['secret one', 'secret two', 'secret three']) {
      await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: msg(conv, t) });
    }
    // Triggers run asynchronously after each send; three sends collapse into one row.
    await waitFor(async () => (await pending(b.id))[0]?.payload.count === 3);
    expect(await pending(b.id)).toHaveLength(1);
    const [row] = await pending(b.id);
    expect(row.payload).toMatchObject({ conversation_id: conv, sender_name: 'Alice', count: 3 });

    expect(await dispatchDue()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.msg.type).toBe('message');
    // Never includes message content.
    expect(JSON.stringify(sent[0]!.msg)).not.toContain('secret');
    expect((await pending(b.id))[0]).toMatchObject({ state: 'sent' });
  });

  it('uses the name the recipient saved the sender as', async () => {
    const a = await createUser(srv.url, 'Alice');
    const b = await createUser(srv.url, 'Bob');
    await api(srv.url, 'POST', '/api/contacts', { token: b.accessToken, body: { user_id: a.id, display_name: 'Mom' } });
    await subscribe(b);
    await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: msg(await chat(a, b), 'hi') });
    await waitFor(async () => (await pending(b.id)).length === 1);
    expect((await pending(b.id))[0].payload.sender_name).toBe('Mom');
  });

  it('does not push to users who are online', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    await subscribe(b);
    const sb = await TestSocket.connect(srv.wsUrl, b.accessToken);
    sockets.push(sb);
    await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: msg(await chat(a, b), 'hi') });
    await sb.waitEvent('message.new');
    await sleep(100);
    expect(await pending(b.id)).toHaveLength(0);
  });

  it('pushes incoming and missed calls to an offline callee', async () => {
    const a = await createUser(srv.url, 'Caller');
    const b = await createUser(srv.url);
    await subscribe(b);
    const sa = await TestSocket.connect(srv.wsUrl, a.accessToken);
    sockets.push(sa);
    const r = await sa.request('call.initiate', { callee_id: b.id });
    await waitFor(async () => (await pending(b.id)).some((n) => n.type === 'call.incoming'));
    await dispatchDue();
    const incoming = sent.find((s) => s.msg.type === 'call.incoming')!;
    expect(incoming.msg).toMatchObject({ urgency: 'high', ttl: 45, payload: { call_id: r.result.call.id, sender_name: 'Caller' } });
    await sa.waitEvent('call.ended', () => true, 5000); // ring timeout
    await waitFor(async () => (await pending(b.id)).some((n) => n.type === 'call.missed'));
  });

  it('removes dead subscriptions and retries transient failures with backoff', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    await subscribe(b);
    const conv = await chat(a, b);
    await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: msg(conv, 'x') });
    await waitFor(async () => (await pending(b.id)).length === 1);

    nextResult = { error: 'push service HTTP 503', retryable: true };
    await dispatchDue();
    let [row] = await pending(b.id);
    expect(row).toMatchObject({ state: 'pending', attempts: 1, last_error: 'push service HTTP 503' });
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 10_000);

    // Due again; this time the subscription is gone (HTTP 410).
    await pool.query(`UPDATE notifications SET next_attempt_at = now() WHERE id = $1`, [row.id]);
    nextResult = 'gone';
    await dispatchDue();
    [row] = await pending(b.id);
    expect(row.state).not.toBe('pending');
    const dev = await pool.query('SELECT push_endpoint FROM devices WHERE id = $1', [b.deviceId]);
    expect(dev.rows[0].push_endpoint).toBeNull();
  });

  it('skips users with no push-enabled devices, and logged-out devices', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    await subscribe(b);
    await api(srv.url, 'POST', '/api/auth/logout', { token: b.accessToken });
    await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: msg(await chat(a, b), 'x') });
    await waitFor(async () => (await pending(b.id)).length === 1);
    await dispatchDue();
    expect(sent).toHaveLength(0);
    expect((await pending(b.id))[0]).toMatchObject({ state: 'skipped', last_error: 'no_push_devices' });
  });

  it('concurrent dispatchers never send the same notification twice', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    await subscribe(b);
    await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: msg(await chat(a, b), 'x') });
    await waitFor(async () => (await pending(b.id)).length === 1);
    await Promise.all([dispatchDue(), dispatchDue(), dispatchDue()]);
    expect(sent).toHaveLength(1);
  });

  it('validates push subscriptions', async () => {
    const b = await createUser(srv.url);
    const bad = await api(srv.url, 'PUT', '/api/devices/current/push', {
      token: b.accessToken,
      body: { provider: 'webpush', endpoint: 'http://169.254.169.254/latest', keys: { p256dh: 'B'.repeat(80), auth: 'A'.repeat(16) } },
    });
    expect(bad.status).toBe(400);
    const cfg = await api(srv.url, 'GET', '/api/notifications/config', { token: b.accessToken });
    expect(cfg.body.webpush).toHaveProperty('enabled');
  });
});
