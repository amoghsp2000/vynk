/**
 * Manual end-to-end smoke test against a running dev server (mock OTP).
 *   npx tsx scripts/smoke-realtime.ts [http://localhost:4000]
 * Registers two users, connects both over WebSocket, sends a message while the
 * recipient is offline, then brings the recipient online and checks sync,
 * delivery and read receipts.
 */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const BASE = process.argv[2] ?? 'http://localhost:4000';
const WS = BASE.replace(/^http/, 'ws') + '/ws';

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function user(name: string) {
  const phone = `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
  const reg = await call('POST', '/api/auth/register', { phone_number: phone, name, password: 'password123' });
  const { code } = await call('GET', `/api/dev/otp?phone_number=${encodeURIComponent(phone)}`);
  const v = await call('POST', '/api/auth/verify-otp', { challenge_id: reg.challenge_id, code, token_transport: 'body' });
  return { id: v.user.id as string, token: v.access_token as string, name };
}

function socket(token: string, label: string) {
  const ws = new WebSocket(WS);
  const events: any[] = [];
  const acks = new Map<string, (p: any) => void>();
  ws.on('message', (raw) => {
    const e = JSON.parse(raw.toString());
    if (e.type === 'ack') acks.get(e.payload.ref)?.(e.payload);
    else {
      events.push(e);
      console.log(`  [${label}] <- ${e.type}`, e.type === 'message.new' ? JSON.stringify(e.payload.body) : JSON.stringify(e.payload).slice(0, 120));
    }
  });
  const ready = new Promise<void>((res) => {
    ws.on('open', () => ws.send(JSON.stringify({ id: randomUUID(), type: 'auth', ts: Date.now(), payload: { access_token: token } })));
    ws.on('message', (raw) => JSON.parse(raw.toString()).type === 'auth.ok' && res());
  });
  const request = (type: string, payload: unknown) =>
    new Promise<any>((res) => {
      const id = randomUUID();
      acks.set(id, res);
      ws.send(JSON.stringify({ id, type, ts: Date.now(), payload }));
    });
  return { ws, events, ready, request };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`);
  if (!ok) process.exitCode = 1;
};

const alice = await user('Alice');
const bob = await user('Bob');
const conv = await call('POST', '/api/conversations', { user_id: bob.id }, alice.token);
console.log(`users ${alice.id} / ${bob.id}, conversation ${conv.id}`);

const a = socket(alice.token, 'alice');
await a.ready;
console.log('alice online; bob offline. alice sends 2 messages:');
const m1 = await a.request('message.send', { conversation_id: conv.id, client_msg_id: randomUUID(), body: 'Hi Bob 👋' });
const m2 = await a.request('message.send', { conversation_id: conv.id, client_msg_id: randomUUID(), body: 'You there?' });
check(m1.ok && m2.ok, 'server acked both sends (persisted)');

console.log('bob comes online and syncs:');
const b = socket(bob.token, 'bob');
await b.ready;
const synced = await b.request('sync', { cursor: 0 });
check(synced.result.messages.length === 2, `bob received ${synced.result.messages.length}/2 missed messages via sync`);
await b.request('message.delivered', { message_ids: synced.result.messages.map((m: any) => m.id) });
await sleep(200);
check(a.events.some((e) => e.type === 'message.status' && e.payload.status === 'delivered'), 'alice saw DELIVERED');

console.log('live message bob -> alice:');
await b.request('message.send', { conversation_id: conv.id, client_msg_id: randomUUID(), body: 'Yes! 😄' });
await sleep(200);
check(a.events.some((e) => e.type === 'message.new' && e.payload.body === 'Yes! 😄'), 'alice received live message');

await b.request('message.read', { conversation_id: conv.id, up_to_seq: m2.result.message.seq });
await sleep(200);
check(a.events.some((e) => e.type === 'message.status' && e.payload.status === 'read'), 'alice saw READ');

console.log('presence + typing:');
const snap = await b.request('presence.subscribe', { user_ids: [alice.id] });
check(snap.result.presence[0]?.online === true, 'bob sees alice online in presence snapshot');
await a.request('typing.start', { conversation_id: conv.id });
await sleep(200);
check(b.events.some((e) => e.type === 'user.typing' && e.payload.user_id === alice.id), 'bob saw alice typing');
await a.request('typing.stop', { conversation_id: conv.id });
a.ws.close();
console.log('alice disconnected; waiting for grace period...');
for (let i = 0; i < 40 && !b.events.some((e) => e.type === 'presence' && e.payload.online === false); i++) await sleep(500);
const off = b.events.find((e) => e.type === 'presence' && e.payload.online === false);
check(Boolean(off?.payload.last_seen), `bob saw alice go offline with last_seen=${off?.payload.last_seen}`);
b.ws.close();
