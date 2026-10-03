import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { api, createUser, loginAgain, sleep, useServer, type TestUser } from './helpers.js';
import { TestSocket } from './wsClient.js';
import { pool } from '../src/database/pool.js';

const srv = useServer();
const sockets: TestSocket[] = [];
const connect = async (u: TestUser, origin?: string) => {
  const s = await TestSocket.connect(srv.wsUrl, u.accessToken, origin ? { origin } : {});
  sockets.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

async function chat(a: TestUser, b: TestUser) {
  const c = await api(srv.url, 'POST', '/api/conversations', { token: a.accessToken, body: { user_id: b.id } });
  return c.body.id as string;
}
/** Pretends all current changes happened a minute ago (bypassing the bump triggers). */
async function ageChanges() {
  const c = await pool.connect();
  try {
    await c.query('SET session_replication_role = replica');
    for (const t of ['messages', 'conversation_members', 'message_receipts', 'message_hides']) {
      await c.query(`UPDATE ${t} SET changed_at = changed_at - interval '1 minute'`);
    }
  } finally {
    await c.query('SET session_replication_role = DEFAULT');
    c.release();
  }
}
const text = (conversation_id: string, body: string, extra: object = {}) => ({
  conversation_id,
  client_msg_id: randomUUID(),
  type: 'text',
  body,
  ...extra,
});

describe('websocket connection', () => {
  it('authenticates with the first frame', async () => {
    const a = await createUser(srv.url);
    const s = await connect(a);
    expect(s.authOk.payload).toMatchObject({ user_id: a.id, device_id: a.deviceId, protocol: 1 });
  });

  it('rejects an invalid token', async () => {
    const s = await TestSocket.connect(srv.wsUrl, 'not-a-token');
    expect(s.authOk.failed).toBe(4002);
  });

  it('rejects a foreign browser origin', async () => {
    const a = await createUser(srv.url);
    await expect(TestSocket.connect(srv.wsUrl, a.accessToken, { origin: 'https://evil.example' })).rejects.toThrow();
  });

  it('closes sockets of a revoked session', async () => {
    const a = await createUser(srv.url);
    const s = await connect(a);
    await api(srv.url, 'POST', '/api/auth/logout', { token: a.accessToken });
    await sleep(200);
    expect(s.closeCode).toBe(4003);
  });

  it('answers app-level ping', async () => {
    const a = await createUser(srv.url);
    const s = await connect(a);
    const r = await s.request('ping', {});
    expect(r.ok).toBe(true);
    expect(r.result.server_time).toBeGreaterThan(0);
  });

  it('rejects unknown events and invalid payloads without dropping the connection', async () => {
    const a = await createUser(srv.url);
    const s = await connect(a);
    expect((await s.request('nope', {})).error.code).toBe('unknown_event');
    expect((await s.request('message.send', { conversation_id: 'x' })).error.code).toBe('bad_request');
    expect((await s.request('ping', {})).ok).toBe(true);
  });
});

describe('send / receive', () => {
  it('delivers instantly to the recipient and to the sender\'s other devices', async () => {
    const a = await createUser(srv.url, 'A');
    const a2 = await loginAgain(srv.url, a);
    const b = await createUser(srv.url, 'B');
    const conv = await chat(a, b);
    const [sa, sa2, sb] = [await connect(a), await connect(a2), await connect(b)];

    const ack = await sa.request('message.send', text(conv, 'hello 👋'));
    expect(ack.ok).toBe(true);
    expect(ack.result.message).toMatchObject({ body: 'hello 👋', sender_id: a.id, status: 'sent' });

    const got = await sb.waitEvent('message.new');
    expect(got.payload.id).toBe(ack.result.message.id);
    expect(got.from).toBe(a.id);
    await sa2.waitEvent('message.new');
    await sleep(100);
    expect(sa.of('message.new')).toHaveLength(0); // sending socket already has it via ack
  });

  it('ignores a spoofed sender in the payload', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    const sa = await connect(a);
    const ack = await sa.request('message.send', { ...text(conv, 'hi'), sender_id: b.id });
    expect(ack.result.message.sender_id).toBe(a.id);
  });

  it('non-members cannot send into a conversation', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const eve = await createUser(srv.url);
    const conv = await chat(a, b);
    const se = await connect(eve);
    const ack = await se.request('message.send', text(conv, 'intruder'));
    expect(ack.ok).toBe(false);
    expect(ack.error.code).toBe('not_found');
  });

  it('supports replies and validates the reply target', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    const sa = await connect(a);
    const first = await sa.request('message.send', text(conv, 'question?'));
    const reply = await sa.request('message.send', text(conv, 'answer', { reply_to_id: first.result.message.id }));
    expect(reply.result.message.reply_to).toMatchObject({ id: first.result.message.id, body: 'question?' });
    const bad = await sa.request('message.send', text(conv, 'x', { reply_to_id: randomUUID() }));
    expect(bad.ok).toBe(false);
  });
});

describe('idempotency & duplicates', () => {
  it('replays the original ack for a repeated request id', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    const sa = await connect(a);
    const reqId = randomUUID();
    const payload = text(conv, 'once');
    const ack1 = await sa.request('message.send', payload, reqId);
    const ack2 = await sa.request('message.send', payload, reqId);
    expect(ack2).toEqual(ack1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [conv]);
    expect(rows[0].n).toBe(1);
  });

  it('deduplicates retries by client_msg_id (e.g. resend after reconnect, or via REST)', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    const sa = await connect(a);
    const payload = text(conv, 'retry me');
    const ack1 = await sa.request('message.send', payload);
    await sa.close();
    const sa2 = await connect(a);
    const ack2 = await sa2.request('message.send', payload); // new request id, same client_msg_id
    expect(ack2.result.duplicate).toBe(true);
    expect(ack2.result.message.id).toBe(ack1.result.message.id);
    const rest = await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: payload });
    expect(rest.status).toBe(200);
    expect(rest.body.message.id).toBe(ack1.result.message.id);
  });

  it('concurrent duplicate sends create exactly one message', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    const payload = text(conv, 'race');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: payload })),
    );
    expect(new Set(results.map((r) => r.body.message.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  });
});

describe('offline recipient & sync', () => {
  it('stores messages for an offline recipient and delivers them on reconnect via sync', async () => {
    const a = await createUser(srv.url, 'A');
    const b = await createUser(srv.url, 'B');
    const conv = await chat(a, b);
    const sa = await connect(a);
    const sent = [];
    for (const t of ['one', 'two', 'three']) sent.push((await sa.request('message.send', text(conv, t))).result.message);

    // B comes online later and syncs from scratch.
    const sb = await connect(b);
    const s1 = await sb.request('sync', { cursor: 0 });
    expect(s1.ok).toBe(true);
    expect(s1.result.messages.map((m: any) => m.body)).toEqual(['one', 'two', 'three']);
    expect(s1.result.conversations.find((c: any) => c.conversation_id === conv)).toBeTruthy();

    // B confirms receipt -> A sees DELIVERED.
    await sb.request('message.delivered', { message_ids: sent.map((m) => m.id) });
    const st = await sa.waitEvent('message.status', (e) => e.payload.status === 'delivered');
    expect(st.payload.message_ids.sort()).toEqual(sent.map((m) => m.id).sort());
  });

  it('a freshly loaded client confirms everything it was sent while offline', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    const sa = await connect(a);
    const m = (await sa.request('message.send', text(conv, 'while you were away'))).result.message;
    const sb = await connect(b);
    expect((await sb.request('message.delivered_all', {})).result.updated).toBe(1);
    const st = await sa.waitEvent('message.status');
    expect(st.payload).toMatchObject({ status: 'delivered', message_ids: [m.id], conversation_id: conv });
    expect((await sb.request('message.delivered_all', {})).result.updated).toBe(0);
  });

  it('cursor advances and only returns newer changes; recent changes may repeat but never get skipped', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    const sa = await connect(a);
    await sa.request('message.send', text(conv, 'm1'));

    const first = await api(srv.url, 'GET', '/api/sync?cursor=0', { token: b.accessToken });
    expect(first.body.messages.map((m: any) => m.body)).toContain('m1');

    // Age existing changes past the safety horizon so the cursor can move beyond them.
    await ageChanges();

    const settled = await api(srv.url, 'GET', '/api/sync?cursor=0', { token: b.accessToken });
    await sa.request('message.send', text(conv, 'm2'));
    const next = await api(srv.url, 'GET', `/api/sync?cursor=${settled.body.cursor}`, { token: b.accessToken });
    const bodies = next.body.messages.map((m: any) => m.body);
    expect(bodies).toContain('m2');
    expect(bodies).not.toContain('m1');
  });

  it('sync reports deletes, hides, read markers and receipt changes', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    const sa = await connect(a);
    const sb = await connect(b);
    const m1 = (await sa.request('message.send', text(conv, 'keep'))).result.message;
    const m2 = (await sa.request('message.send', text(conv, 'oops'))).result.message;
    await sa.request('message.delete', { message_id: m2.id, scope: 'everyone' });
    await sb.request('message.delete', { message_id: m1.id, scope: 'me' });
    await sb.request('message.read', { conversation_id: conv, up_to_seq: m2.seq });

    const bs = (await sb.request('sync', { cursor: 0 })).result;
    expect(bs.hidden.map((h: any) => h.message_id)).toContain(m1.id);
    expect(bs.messages.find((m: any) => m.id === m1.id)).toBeUndefined(); // hidden for B
    expect(bs.messages.find((m: any) => m.id === m2.id)).toMatchObject({ deleted: true, body: null });
    expect(bs.conversations.find((c: any) => c.conversation_id === conv).last_read_seq).toBe(m2.seq);

    const as = (await sa.request('sync', { cursor: 0 })).result;
    expect(as.receipts.find((r: any) => r.message_id === m1.id).status).toBe('read');
  });
});

describe('read receipts', () => {
  it('marks read up to a seq and notifies the sender and reader\'s other devices', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const b2 = await loginAgain(srv.url, b);
    const conv = await chat(a, b);
    const [sa, sb, sb2] = [await connect(a), await connect(b), await connect(b2)];
    const m1 = (await sa.request('message.send', text(conv, 'x'))).result.message;
    const m2 = (await sa.request('message.send', text(conv, 'y'))).result.message;

    await sb.request('message.read', { conversation_id: conv, up_to_seq: m2.seq });
    const st = await sa.waitEvent('message.status', (e) => e.payload.status === 'read');
    expect(st.payload.message_ids.sort()).toEqual([m1.id, m2.id].sort());
    await sb2.waitEvent('conversation.read');

    const list = await api(srv.url, 'GET', '/api/conversations', { token: b.accessToken });
    expect(list.body.conversations[0].unread_count).toBe(0);
    const aList = await api(srv.url, 'GET', '/api/conversations', { token: a.accessToken });
    expect(aList.body.conversations[0].last_message.status).toBe('read');
  });

  it('with read receipts disabled the sender only sees delivered', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    await api(srv.url, 'PATCH', '/api/users/me/privacy', { token: b.accessToken, body: { read_receipts: false } });
    const sa = await connect(a);
    const sb = await connect(b);
    const m = (await sa.request('message.send', text(conv, 'x'))).result.message;
    await sb.request('message.read', { conversation_id: conv, up_to_seq: m.seq });
    await sa.waitEvent('message.status');
    expect(sa.of('message.status').every((e) => e.payload.status === 'delivered')).toBe(true);
    const list = await api(srv.url, 'GET', '/api/conversations', { token: b.accessToken });
    expect(list.body.conversations[0].unread_count).toBe(0);
  });

  it('unread counts reflect messages after the read marker', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    for (const t of ['1', '2', '3']) await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: text(conv, t) });
    const list = await api(srv.url, 'GET', '/api/conversations', { token: b.accessToken });
    expect(list.body.conversations[0]).toMatchObject({ unread_count: 3 });
    expect(list.body.conversations[0].last_message.body).toBe('3');
  });
});

describe('history, delete, search', () => {
  it('paginates history with a seq cursor', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    for (let i = 1; i <= 7; i++) await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: text(conv, `m${i}`) });
    const p1 = await api(srv.url, 'GET', `/api/conversations/${conv}/messages?limit=3`, { token: b.accessToken });
    expect(p1.body.messages.map((m: any) => m.body)).toEqual(['m5', 'm6', 'm7']);
    expect(p1.body.has_more).toBe(true);
    const p2 = await api(srv.url, 'GET', `/api/conversations/${conv}/messages?limit=3&before_seq=${p1.body.messages[0].seq}`, {
      token: b.accessToken,
    });
    expect(p2.body.messages.map((m: any) => m.body)).toEqual(['m2', 'm3', 'm4']);
  });

  it('delete for everyone is sender-only and notifies all members', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    const sa = await connect(a);
    const sb = await connect(b);
    const m = (await sa.request('message.send', text(conv, 'secret'))).result.message;
    expect((await sb.request('message.delete', { message_id: m.id, scope: 'everyone' })).error.code).toBe('forbidden');
    expect((await sa.request('message.delete', { message_id: m.id, scope: 'everyone' })).ok).toBe(true);
    await sb.waitEvent('message.deleted');
    const h = await api(srv.url, 'GET', `/api/conversations/${conv}/messages`, { token: b.accessToken });
    expect(h.body.messages[0]).toMatchObject({ deleted: true, body: null });
  });

  it('local chat delete clears history for me only; new messages reappear', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: text(conv, 'old') });
    await api(srv.url, 'DELETE', `/api/conversations/${conv}`, { token: b.accessToken });
    expect((await api(srv.url, 'GET', '/api/conversations', { token: b.accessToken })).body.conversations).toHaveLength(0);
    await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: text(conv, 'new') });
    const h = await api(srv.url, 'GET', `/api/conversations/${conv}/messages`, { token: b.accessToken });
    expect(h.body.messages.map((m: any) => m.body)).toEqual(['new']);
    const ha = await api(srv.url, 'GET', `/api/conversations/${conv}/messages`, { token: a.accessToken });
    expect(ha.body.messages).toHaveLength(2);
  });

  it('searches only my visible messages', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const eve = await createUser(srv.url);
    const conv = await chat(a, b);
    await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: text(conv, 'Lunch at noon?') });
    await api(srv.url, 'POST', '/api/messages', { token: a.accessToken, body: text(conv, 'dinner later') });
    const r = await api(srv.url, 'GET', '/api/messages/search?q=LUNCH', { token: b.accessToken });
    expect(r.body.messages.map((m: any) => m.body)).toEqual(['Lunch at noon?']);
    const e = await api(srv.url, 'GET', '/api/messages/search?q=lunch', { token: eve.accessToken });
    expect(e.body.messages).toHaveLength(0);
    const pct = await api(srv.url, 'GET', '/api/messages/search?q=%25', { token: b.accessToken });
    expect(pct.body.messages).toHaveLength(0); // % is literal, not a wildcard
  });
});

describe('blocking', () => {
  it('blocker cannot send; messages from a blocked user are never delivered', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    await api(srv.url, 'POST', '/api/blocks', { token: a.accessToken, body: { user_id: b.id } });
    const sa = await connect(a);
    const sb = await connect(b);

    expect((await sa.request('message.send', text(conv, 'hi'))).error.code).toBe('blocked');
    const fromB = await sb.request('message.send', text(conv, 'let me in'));
    expect(fromB.ok).toBe(true); // B is not told they're blocked
    await sleep(150);
    expect(sa.of('message.new')).toHaveLength(0);
    const h = await api(srv.url, 'GET', `/api/conversations/${conv}/messages`, { token: a.accessToken });
    expect(h.body.messages).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  it('throttles message floods', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const conv = await chat(a, b);
    const sa = await connect(a);
    const acks = await Promise.all(Array.from({ length: 65 }, (_, i) => sa.request('message.send', text(conv, `spam ${i}`))));
    expect(acks.filter((x) => x.error?.code === 'rate_limited').length).toBeGreaterThan(0);
  });
});
