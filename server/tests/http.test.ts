import { describe, expect, it } from 'vitest';
import { createUser, useServer } from './helpers.js';

const srv = useServer();

describe('http plumbing', () => {
  it('accepts a bodyless POST that sends content-type: application/json', async () => {
    const u = await createUser(srv.url);
    const res = await fetch(`${srv.url}/api/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${u.accessToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects malformed JSON and prototype-poisoning payloads', async () => {
    const bad = await fetch(`${srv.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
    const poisoned = await fetch(`${srv.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"__proto__": {"admin": true}}',
    });
    expect(poisoned.status).toBe(400);
  });

  it('echoes a well-formed X-Request-Id and generates one otherwise', async () => {
    const echoed = await fetch(`${srv.url}/health/live`, { headers: { 'x-request-id': 'client-req-12345' } });
    expect(echoed.headers.get('x-request-id')).toBe('client-req-12345');
    const generated = await fetch(`${srv.url}/health/live`, { headers: { 'x-request-id': 'bad id\n' } });
    expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const r = await fetch(`${srv.url}/api/nope`);
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe('not_found');
  });
});
