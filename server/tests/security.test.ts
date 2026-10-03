import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { api, createUser, loginAgain, mockOtp, useServer } from './helpers.js';
import { TestSocket } from './wsClient.js';
import { redis } from '../src/lib/redis.js';

const srv = useServer();

describe('injection & stored content', () => {
  it('treats SQL metacharacters as data', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = (await api(srv.url, 'POST', '/api/conversations', { token: a.accessToken, body: { user_id: b.id } })).body.id;
    const evil = "'); DROP TABLE messages; --";
    const sent = await api(srv.url, 'POST', '/api/messages', {
      token: a.accessToken,
      body: { conversation_id: conv, client_msg_id: randomUUID(), type: 'text', body: evil },
    });
    expect(sent.body.message.body).toBe(evil);
    const s = await api(srv.url, 'GET', `/api/messages/search?q=${encodeURIComponent("' OR 1=1 --")}`, { token: b.accessToken });
    expect(s.status).toBe(200);
    expect(s.body.messages).toHaveLength(0);
    const conv2 = await api(srv.url, 'GET', `/api/conversations?q=${encodeURIComponent("x' OR 'a'='a")}`, { token: a.accessToken });
    expect(conv2.body.conversations).toHaveLength(0);
  });

  it('stores markup verbatim (rendered as text by the client, never as HTML)', async () => {
    const a = await createUser(srv.url);
    const r = await api(srv.url, 'PATCH', '/api/users/me', { token: a.accessToken, body: { about: '<img src=x onerror=alert(1)>' } });
    expect(r.body.about).toBe('<img src=x onerror=alert(1)>');
  });

  it('strips control characters from display text', async () => {
    const a = await createUser(srv.url);
    const r = await api(srv.url, 'PATCH', '/api/users/me', { token: a.accessToken, body: { name: 'Eve\u0000\u0007il' } });
    expect(r.body.name).toBe('Eveil');
  });

  it('rejects malformed ids before they reach the database', async () => {
    const a = await createUser(srv.url);
    expect((await api(srv.url, 'GET', "/api/users/1%20OR%201=1", { token: a.accessToken })).status).toBe(400);
    expect((await api(srv.url, 'GET', '/api/conversations/not-a-uuid', { token: a.accessToken })).status).toBe(400);
  });
});

describe('authorization (IDOR)', () => {
  it("can't read, write or delete inside someone else's conversation", async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const eve = await createUser(srv.url);
    const conv = (await api(srv.url, 'POST', '/api/conversations', { token: a.accessToken, body: { user_id: b.id } })).body.id;
    const m = (
      await api(srv.url, 'POST', '/api/messages', {
        token: a.accessToken,
        body: { conversation_id: conv, client_msg_id: randomUUID(), type: 'text', body: 'private' },
      })
    ).body.message;
    const t = eve.accessToken;
    expect((await api(srv.url, 'GET', `/api/conversations/${conv}/messages`, { token: t })).status).toBe(404);
    expect((await api(srv.url, 'DELETE', `/api/messages/${m.id}?scope=everyone`, { token: t })).status).toBe(404);
    expect((await api(srv.url, 'DELETE', `/api/messages/${m.id}?scope=me`, { token: t })).status).toBe(404);
    expect((await api(srv.url, 'POST', `/api/conversations/${conv}/read`, { token: t, body: { up_to_seq: 999 } })).status).toBe(404);
    const sync = await api(srv.url, 'GET', '/api/sync?cursor=0', { token: t });
    expect(sync.body.messages).toHaveLength(0);
    // Delivery receipts can only be set for messages addressed to you.
    await api(srv.url, 'POST', '/api/messages/delivered', { token: t, body: { message_ids: [m.id] } });
    const h = await api(srv.url, 'GET', `/api/conversations/${conv}/messages`, { token: a.accessToken });
    expect(h.body.messages[0].status).toBe('sent');
  });

  it("can't revoke another user's session", async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    expect((await api(srv.url, 'DELETE', `/api/auth/sessions/${b.sessionId}`, { token: a.accessToken })).status).toBe(404);
    expect((await api(srv.url, 'GET', '/api/auth/sessions', { token: b.accessToken })).status).toBe(200);
  });

  it("device_id from another account is not reused at login", async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const l = await api(srv.url, 'POST', '/api/auth/login', { body: { phone_number: b.phone, password: b.password } });
    const v = await api(srv.url, 'POST', '/api/auth/verify-otp', {
      body: { challenge_id: l.body.challenge_id, code: await mockOtp(b.phone), token_transport: 'body', device: { device_id: a.deviceId } },
    });
    expect(v.body.device_id).not.toBe(a.deviceId);
  });
});

describe('abuse limits', () => {
  it('caps WebSocket connection attempts per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 65; i++) {
      statuses.push(
        await new Promise<number>((res) => {
          const ws = new WebSocket(srv.wsUrl);
          ws.on('open', () => (ws.close(), res(101)));
          ws.on('unexpected-response', (_req, r) => res(r.statusCode ?? 0));
          ws.on('error', () => res(0));
        }),
      );
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('closes unauthenticated sockets that send garbage', async () => {
    const ws = new WebSocket(srv.wsUrl);
    await new Promise((r) => ws.on('open', r));
    const code = await new Promise<number>((res) => {
      ws.on('close', (c) => res(c));
      ws.send('not json');
    });
    expect(code).toBe(4004);
  });

  it('rejects oversized WebSocket frames', async () => {
    const a = await createUser(srv.url);
    const s = await TestSocket.connect(srv.wsUrl, a.accessToken);
    s.ws.send('x'.repeat(70 * 1024));
    await new Promise((r) => setTimeout(r, 200));
    expect(s.closeCode).toBe(1009);
  });

  it('applies a per-IP ceiling to the API', async () => {
    await redis.set(`rl:ip:127.0.0.1`, '100000', 'PX', 60_000);
    const r = await api(srv.url, 'GET', '/api/notifications/config');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
  });
});

describe('password change', () => {
  it('requires the current password and signs out other sessions', async () => {
    const a = await createUser(srv.url);
    const other = await loginAgain(srv.url, a);
    const wrong = await api(srv.url, 'POST', '/api/auth/password', {
      token: a.accessToken,
      body: { current_password: 'nope', new_password: 'brand-new-pass' },
    });
    expect(wrong.status).toBe(401);
    const ok = await api(srv.url, 'POST', '/api/auth/password', {
      token: a.accessToken,
      body: { current_password: a.password, new_password: 'brand-new-pass' },
    });
    expect(ok.body).toMatchObject({ ok: true, revoked_sessions: 1 });
    expect((await api(srv.url, 'GET', '/api/auth/sessions', { token: other.accessToken })).status).toBe(401);
    expect((await api(srv.url, 'GET', '/api/auth/sessions', { token: a.accessToken })).status).toBe(200);
    const oldLogin = await api(srv.url, 'POST', '/api/auth/login', { body: { phone_number: a.phone, password: a.password } });
    expect(oldLogin.status).toBe(401);
  });
});
