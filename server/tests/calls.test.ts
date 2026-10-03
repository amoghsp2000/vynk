import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { api, createUser, loginAgain, sleep, useServer, waitFor, type TestUser } from './helpers.js';
import { TestSocket } from './wsClient.js';
import { pool } from '../src/database/pool.js';
import { redis } from '../src/lib/redis.js';

// Test env: CALL_RING_TIMEOUT_MS=1500, CALL_RECONNECT_GRACE_MS=800, sweeper every 1s.
const srv = useServer();
const sockets: TestSocket[] = [];
const connect = async (u: TestUser) => {
  const s = await TestSocket.connect(srv.wsUrl, u.accessToken);
  sockets.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const ANSWER = OFFER.replace('o=- 1', 'o=- 3');
const cand = (n: number) => ({ candidate: `candidate:${n} 1 udp 2122260223 192.0.2.${n} 5000${n} typ host`, sdpMid: '0', sdpMLineIndex: 0 });
const dbCall = async (id: string) => (await pool.query('SELECT * FROM calls WHERE id = $1', [id])).rows[0];

async function setup() {
  const a = await createUser(srv.url, 'Caller');
  const b = await createUser(srv.url, 'Callee');
  const [sa, sb] = [await connect(a), await connect(b)];
  return { a, b, sa, sb };
}

/** Drives a call all the way to CONNECTED. */
async function connected() {
  const ctx = await setup();
  const { a, sa, sb } = ctx;
  const init = await sa.request('call.initiate', { callee_id: ctx.b.id });
  const callId = init.result.call.id as string;
  await sb.waitEvent('call.incoming');
  await sa.request('call.offer', { call_id: callId, sdp: OFFER });
  await sb.request('call.accept', { call_id: callId });
  await sb.request('call.answer', { call_id: callId, sdp: ANSWER });
  await sa.request('call.state', { call_id: callId, state: 'connected' });
  expect((await dbCall(callId)).status).toBe('CONNECTED');
  return { ...ctx, callId, a };
}

describe('ICE servers', () => {
  it('returns STUN + short-lived TURN credentials, never the secret', async () => {
    const a = await createUser(srv.url);
    const r = await api(srv.url, 'GET', '/api/calls/ice-servers', { token: a.accessToken });
    const turn = r.body.ice_servers.find((s: any) => s.username);
    const [expiry, uid] = turn.username.split(':');
    expect(uid).toBe(a.id);
    expect(Number(expiry)).toBeGreaterThan(Date.now() / 1000);
    expect(turn.credential).toBe(createHmac('sha1', 'test-turn-secret').update(turn.username).digest('base64'));
    expect(JSON.stringify(r.body)).not.toContain('test-turn-secret');
    expect(r.body.ice_servers.some((s: any) => s.urls.some((u: string) => u.startsWith('stun:')))).toBe(true);
  });
});

describe('call flow', () => {
  it('offer -> ring -> accept -> answer -> ICE -> connected -> end', async () => {
    const { a, b, sa, sb } = await setup();
    const b2 = await loginAgain(srv.url, b);
    const sb2 = await connect(b2);

    const init = await sa.request('call.initiate', { callee_id: b.id });
    expect(init.ok).toBe(true);
    expect(init.result.call.status).toBe('RINGING');
    expect(init.result.ice_servers.length).toBeGreaterThan(0);
    const callId = init.result.call.id;

    // Both callee devices ring, with the caller's (privacy-filtered) profile.
    const ring = await sb.waitEvent('call.incoming');
    expect(ring.payload.caller).toMatchObject({ id: a.id, name: 'Caller' });
    expect(ring.from).toBe(a.id);
    await sb2.waitEvent('call.incoming');

    // Caller sends offer + candidates before anyone picked up: buffered.
    expect((await sa.request('call.offer', { call_id: callId, sdp: OFFER })).ok).toBe(true);
    await sa.request('call.ice_candidate', { call_id: callId, candidate: cand(1) });
    await sa.request('call.ice_candidate', { call_id: callId, candidate: cand(2) });

    const acc = await sb.request('call.accept', { call_id: callId });
    expect(acc.ok).toBe(true);
    expect(acc.result.offer).toBe(OFFER);
    expect(acc.result.candidates.map((c: any) => c.candidate)).toEqual([cand(1).candidate, cand(2).candidate]);
    await sa.waitEvent('call.accepted');
    await sb2.waitEvent('call.answered_elsewhere');

    await sb.request('call.answer', { call_id: callId, sdp: ANSWER });
    const ans = await sa.waitEvent('call.answer');
    expect(ans.payload.sdp).toBe(ANSWER);
    expect(ans.from).toBe(b.id);
    expect((await dbCall(callId)).status).toBe('CONNECTING');

    // Trickle ICE both ways once both sides are bound.
    await sb.request('call.ice_candidate', { call_id: callId, candidate: cand(3) });
    expect((await sa.waitEvent('call.ice_candidate')).payload.candidate.candidate).toBe(cand(3).candidate);
    await sa.request('call.ice_candidate', { call_id: callId, candidate: cand(4) });
    expect((await sb.waitEvent('call.ice_candidate')).payload.candidate.candidate).toBe(cand(4).candidate);
    expect(sb2.of('call.ice_candidate')).toHaveLength(0); // only the bound device

    await sb.request('call.state', { call_id: callId, state: 'connected' });
    await sa.waitEvent('call.state', (e) => e.payload.status === 'CONNECTED');
    await sleep(50);

    const end = await sa.request('call.end', { call_id: callId });
    expect(end.result.call).toMatchObject({ status: 'ENDED', end_reason: 'hangup', ended_by: a.id });
    expect(end.result.call.duration_ms).toBeGreaterThan(0);
    await sb.waitEvent('call.ended', (e) => e.payload.status === 'ENDED');
    expect(await redis.get(`call:active:${a.id}`)).toBeNull();
    expect(await redis.get(`call:active:${b.id}`)).toBeNull();
  });

  it('callee rejects', async () => {
    const { b, sa, sb } = await setup();
    const callId = (await sa.request('call.initiate', { callee_id: b.id })).result.call.id;
    await sb.waitEvent('call.incoming');
    const r = await sb.request('call.reject', { call_id: callId });
    expect(r.result.call.status).toBe('REJECTED');
    await sa.waitEvent('call.ended', (e) => e.payload.status === 'REJECTED');
  });

  it('unanswered call becomes MISSED after the ring timeout', async () => {
    const { b, sa, sb } = await setup();
    const callId = (await sa.request('call.initiate', { callee_id: b.id })).result.call.id;
    const missed = await sb.waitEvent('call.missed', () => true, 5000);
    expect(missed.payload).toMatchObject({ id: callId, status: 'MISSED', end_reason: 'no_answer' });
    await sa.waitEvent('call.ended', (e) => e.payload.status === 'MISSED');
  });

  it('caller cancelling while ringing is a missed call for the callee', async () => {
    const { b, sa, sb } = await setup();
    const callId = (await sa.request('call.initiate', { callee_id: b.id })).result.call.id;
    await sa.request('call.end', { call_id: callId });
    const m = await sb.waitEvent('call.missed');
    expect(m.payload.end_reason).toBe('cancelled');
  });

  it('busy callee', async () => {
    const { b, callId } = await connected();
    const c = await createUser(srv.url, 'Third');
    const sc = await connect(c);
    const r = await sc.request('call.initiate', { callee_id: b.id });
    expect(r.result.busy).toBe(true);
    expect(r.result.call).toMatchObject({ status: 'MISSED', end_reason: 'busy' });
    await sc.waitEvent('call.busy');
    expect((await dbCall(callId)).status).toBe('CONNECTED'); // existing call unaffected
  });

  it('a user already in a call cannot start another', async () => {
    const { sa } = await connected();
    const c = await createUser(srv.url);
    const r = await sa.request('call.initiate', { callee_id: c.id });
    expect(r.error.code).toBe('conflict');
  });

  it('client-reported failure ends the call as FAILED', async () => {
    const { sa, sb, callId } = await connected();
    const r = await sb.request('call.fail', { call_id: callId, reason: 'ice_failed' });
    expect(r.result.call).toMatchObject({ status: 'FAILED', end_reason: 'ice_failed' });
    await sa.waitEvent('call.ended', (e) => e.payload.status === 'FAILED');
  });

  it('stale busy locks from ended calls self-heal', async () => {
    const { b, sa } = await setup();
    await redis.set(`call:active:${b.id}`, '00000000-0000-4000-8000-000000000000');
    const r = await sa.request('call.initiate', { callee_id: b.id });
    expect(r.result.busy).toBe(false);
  });
});

describe('authorization', () => {
  it('non-participants cannot signal into a call', async () => {
    const { b, sa } = await setup();
    const eve = await createUser(srv.url, 'Eve');
    const se = await connect(eve);
    const callId = (await sa.request('call.initiate', { callee_id: b.id })).result.call.id;
    for (const [type, extra] of [
      ['call.offer', { sdp: OFFER }],
      ['call.answer', { sdp: ANSWER }],
      ['call.ice_candidate', { candidate: cand(9) }],
      ['call.accept', {}],
      ['call.reject', {}],
      ['call.end', {}],
    ] as const) {
      const r = await se.request(type, { call_id: callId, ...extra });
      expect(r.error.code, type).toBe('not_found');
    }
    expect((await api(srv.url, 'GET', `/api/calls/${callId}`, { token: eve.accessToken })).status).toBe(404);
  });

  it('role and state checks: caller cannot accept, callee cannot offer before accepting', async () => {
    const { b, sa, sb } = await setup();
    const callId = (await sa.request('call.initiate', { callee_id: b.id })).result.call.id;
    expect((await sa.request('call.accept', { call_id: callId })).error.code).toBe('invalid_call_state');
    expect((await sb.request('call.offer', { call_id: callId, sdp: OFFER })).error.code).toBe('invalid_call_state');
    expect((await sb.request('call.answer', { call_id: callId, sdp: ANSWER })).error.code).toBe('invalid_call_state');
  });

  it("the callee's other device cannot take over an accepted call", async () => {
    const { b, sa, sb } = await setup();
    const sb2 = await connect(await loginAgain(srv.url, b));
    const callId = (await sa.request('call.initiate', { callee_id: b.id })).result.call.id;
    await sb.request('call.accept', { call_id: callId });
    expect((await sb2.request('call.accept', { call_id: callId })).error.code).toBe('invalid_call_state');
    expect((await sb2.request('call.answer', { call_id: callId, sdp: ANSWER })).error.code).toBe('call_on_other_device');
  });

  it('spoofed from/to fields in payloads are ignored', async () => {
    const { a, b, sa, sb } = await setup();
    const callId = (await sa.request('call.initiate', { callee_id: b.id })).result.call.id;
    await sb.request('call.accept', { call_id: callId });
    await sb.request('call.answer', { call_id: callId, sdp: ANSWER, from: a.id, to: b.id });
    const e = await sa.waitEvent('call.answer');
    expect(e.from).toBe(b.id);
  });

  it('validates SDP and candidate payloads', async () => {
    const { b, sa } = await setup();
    const callId = (await sa.request('call.initiate', { callee_id: b.id })).result.call.id;
    expect((await sa.request('call.offer', { call_id: callId, sdp: 'x'.repeat(30_000) })).error.code).toBe('bad_request');
    expect((await sa.request('call.ice_candidate', { call_id: callId, candidate: { candidate: 1 } })).error.code).toBe('bad_request');
  });

  it("calling someone who blocked you never reaches them and isn't revealed", async () => {
    const { a, b, sa, sb } = await setup();
    await api(srv.url, 'POST', '/api/blocks', { token: b.accessToken, body: { user_id: a.id } });
    const r = await sa.request('call.initiate', { callee_id: b.id });
    expect(r.result.call.status).toBe('RINGING');
    await sa.waitEvent('call.ended', (e) => e.payload.status === 'MISSED', 5000);
    expect(sb.of('call.incoming')).toHaveLength(0);
    expect(sb.of('call.missed')).toHaveLength(0);
  });

  it('blocker cannot call', async () => {
    const { a, b, sa } = await setup();
    await api(srv.url, 'POST', '/api/blocks', { token: a.accessToken, body: { user_id: b.id } });
    expect((await sa.request('call.initiate', { callee_id: b.id })).error.code).toBe('blocked');
  });
});

describe('reconnection', () => {
  it('signaling drop on one side keeps a connected call; resume + ICE restart offer flows', async () => {
    const { a, sa, sb, callId } = await connected();
    await sa.close(); // caller's websocket dies (e.g. Wi-Fi -> mobile switch)
    const lost = await sb.waitEvent('call.peer_disconnected');
    expect(lost.payload.user_id).toBe(a.id);
    await sleep(1800); // beyond the reconnect grace
    expect((await dbCall(callId)).status).toBe('CONNECTED'); // media may still be flowing peer-to-peer

    const sa2 = await connect(a);
    // A new connection must resume before signaling.
    expect((await sa2.request('call.offer', { call_id: callId, sdp: OFFER })).error.code).toBe('resume_required');
    const res = await sa2.request('call.resume', { call_id: callId });
    expect(res.result).toMatchObject({ role: 'caller', call: { status: 'CONNECTED' } });
    await sb.waitEvent('call.peer_resumed');
    await sa2.request('call.state', { call_id: callId, state: 'reconnecting' });
    expect((await dbCall(callId)).status).toBe('RECONNECTING');
    await sa2.request('call.offer', { call_id: callId, sdp: OFFER + 'a=ice-options:restart\r\n' });
    expect((await sb.waitEvent('call.offer')).payload.sdp).toContain('restart');
    await sb.request('call.answer', { call_id: callId, sdp: ANSWER });
    await sa2.waitEvent('call.answer');
    await sa2.request('call.state', { call_id: callId, state: 'connected' });
    expect((await dbCall(callId)).status).toBe('CONNECTED');
  });

  it('a party that never comes back while RECONNECTING fails the call', async () => {
    const { sa, sb, callId } = await connected();
    await sa.request('call.state', { call_id: callId, state: 'reconnecting' });
    await sa.close();
    const e = await sb.waitEvent('call.ended', () => true, 5000);
    expect(e.payload).toMatchObject({ status: 'FAILED', end_reason: 'connection_lost' });
  });

  it('caller disconnecting while ringing (and not returning) cancels the call', async () => {
    const { b, sa, sb } = await setup();
    await sa.request('call.initiate', { callee_id: b.id });
    await sb.waitEvent('call.incoming');
    await sa.close();
    const m = await sb.waitEvent('call.missed', () => true, 5000);
    expect(m.payload.end_reason).toMatch(/cancelled|no_answer/);
  });

  it('a call where both sides lost signaling is cleaned up', async () => {
    const { sa, sb, callId } = await connected();
    await sa.close();
    await sb.close();
    await waitFor(async () => (await dbCall(callId)).status === 'FAILED', 5000);
  });
});

describe('history', () => {
  it('lists calls with direction and peer', async () => {
    const { a, b, callId } = await connected();
    await api(srv.url, 'POST', `/api/calls/${callId}/end`, { token: b.accessToken });
    const ha = await api(srv.url, 'GET', '/api/calls', { token: a.accessToken });
    expect(ha.body.calls[0]).toMatchObject({ id: callId, direction: 'outgoing', status: 'ENDED', peer: { id: b.id } });
    const hb = await api(srv.url, 'GET', '/api/calls', { token: b.accessToken });
    expect(hb.body.calls[0]).toMatchObject({ id: callId, direction: 'incoming', peer: { id: a.id } });
  });

  it('REST initiation works and active call can be restored', async () => {
    const { b } = await setup();
    const a2 = await createUser(srv.url, 'RestCaller');
    const r = await api(srv.url, 'POST', '/api/calls', { token: a2.accessToken, body: { callee_id: b.id } });
    expect(r.status).toBe(201);
    const active = await api(srv.url, 'GET', '/api/calls/active', { token: b.accessToken });
    expect(active.body.active).toMatchObject({ role: 'callee', call: { id: r.body.call.id, status: 'RINGING' } });
  });
});
