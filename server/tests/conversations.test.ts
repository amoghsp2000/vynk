import { describe, expect, it } from 'vitest';
import { api, createUser, useServer } from './helpers.js';

const srv = useServer();

describe('conversations', () => {
  it('creates one direct chat per pair (idempotent from either side)', async () => {
    const a = await createUser(srv.url, 'A');
    const b = await createUser(srv.url, 'B');
    const c1 = await api(srv.url, 'POST', '/api/conversations', { token: a.accessToken, body: { user_id: b.id } });
    expect(c1.status).toBe(200);
    expect(c1.body.peer.id).toBe(b.id);
    const c2 = await api(srv.url, 'POST', '/api/conversations', { token: a.accessToken, body: { user_id: b.id } });
    const c3 = await api(srv.url, 'POST', '/api/conversations', { token: b.accessToken, body: { phone_number: a.phone } });
    expect(c2.body.id).toBe(c1.body.id);
    expect(c3.body.id).toBe(c1.body.id);
  });

  it('empty chat is hidden from the peer until they open it', async () => {
    const a = await createUser(srv.url, 'A');
    const b = await createUser(srv.url, 'B');
    await api(srv.url, 'POST', '/api/conversations', { token: a.accessToken, body: { user_id: b.id } });
    expect((await api(srv.url, 'GET', '/api/conversations', { token: a.accessToken })).body.conversations).toHaveLength(1);
    expect((await api(srv.url, 'GET', '/api/conversations', { token: b.accessToken })).body.conversations).toHaveLength(0);
  });

  it('rejects chatting with yourself and unknown users', async () => {
    const a = await createUser(srv.url);
    expect((await api(srv.url, 'POST', '/api/conversations', { token: a.accessToken, body: { user_id: a.id } })).status).toBe(400);
    expect(
      (await api(srv.url, 'POST', '/api/conversations', {
        token: a.accessToken,
        body: { user_id: '00000000-0000-4000-8000-000000000000' },
      })).status,
    ).toBe(404);
  });

  it('non-members get 404 for a conversation', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const eve = await createUser(srv.url, 'Eve');
    const c = await api(srv.url, 'POST', '/api/conversations', { token: a.accessToken, body: { user_id: b.id } });
    expect((await api(srv.url, 'GET', `/api/conversations/${c.body.id}`, { token: eve.accessToken })).status).toBe(404);
    expect((await api(srv.url, 'DELETE', `/api/conversations/${c.body.id}`, { token: eve.accessToken })).status).toBe(404);
  });

  it('searches by peer name and paginates', async () => {
    const me = await createUser(srv.url, 'Me');
    for (const name of ['Zoe', 'Zack', 'Yara']) {
      const p = await createUser(srv.url, name);
      await api(srv.url, 'POST', '/api/conversations', { token: me.accessToken, body: { user_id: p.id } });
    }
    const z = await api(srv.url, 'GET', '/api/conversations?q=za', { token: me.accessToken });
    expect(z.body.conversations.map((c: any) => c.peer.name)).toEqual(['Zack']);

    const p1 = await api(srv.url, 'GET', '/api/conversations?limit=2', { token: me.accessToken });
    expect(p1.body.conversations).toHaveLength(2);
    expect(p1.body.next_cursor).toBeTruthy();
    const p2 = await api(srv.url, 'GET', `/api/conversations?limit=2&before=${p1.body.next_cursor}`, { token: me.accessToken });
    expect(p2.body.conversations).toHaveLength(1);
    expect(p2.body.next_cursor).toBeNull();
    const all = [...p1.body.conversations, ...p2.body.conversations].map((c: any) => c.id);
    expect(new Set(all).size).toBe(3);
  });

  it('local delete hides the chat only for me', async () => {
    const a = await createUser(srv.url);
    const b = await createUser(srv.url);
    const c = await api(srv.url, 'POST', '/api/conversations', { token: a.accessToken, body: { user_id: b.id } });
    await api(srv.url, 'POST', '/api/conversations', { token: b.accessToken, body: { user_id: a.id } });
    await api(srv.url, 'DELETE', `/api/conversations/${c.body.id}`, { token: a.accessToken });
    expect((await api(srv.url, 'GET', '/api/conversations', { token: a.accessToken })).body.conversations).toHaveLength(0);
    expect((await api(srv.url, 'GET', '/api/conversations', { token: b.accessToken })).body.conversations).toHaveLength(1);
  });
});
