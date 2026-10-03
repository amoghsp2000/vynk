import { describe, expect, it } from 'vitest';
import { api, createUser, useServer } from './helpers.js';

const srv = useServer();

describe('profile', () => {
  it('gets and updates own profile', async () => {
    const u = await createUser(srv.url, 'Alice');
    const me = await api(srv.url, 'GET', '/api/users/me', { token: u.accessToken });
    expect(me.body).toMatchObject({ id: u.id, name: 'Alice', about: 'Available' });
    expect(me.body.privacy).toMatchObject({ last_seen: 'everyone', status: 'contacts', read_receipts: true });

    const upd = await api(srv.url, 'PATCH', '/api/users/me', {
      token: u.accessToken,
      body: { name: '  Alice B  ', about: 'At the gym 🏋️' },
    });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: 'Alice B', about: 'At the gym 🏋️' });
  });

  it('rejects unknown fields and invalid values', async () => {
    const u = await createUser(srv.url);
    const r1 = await api(srv.url, 'PATCH', '/api/users/me', { token: u.accessToken, body: { phone_number: '+10000000000' } });
    expect(r1.status).toBe(400);
    const r2 = await api(srv.url, 'PATCH', '/api/users/me', { token: u.accessToken, body: { name: '' } });
    expect(r2.status).toBe(400);
    const r3 = await api(srv.url, 'PATCH', '/api/users/me', { token: u.accessToken, body: { about: 'x'.repeat(141) } });
    expect(r3.status).toBe(400);
  });

  it("can't set someone else's media as profile photo", async () => {
    const u = await createUser(srv.url);
    const r = await api(srv.url, 'PATCH', '/api/users/me', {
      token: u.accessToken,
      body: { profile_photo_id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(r.status).toBe(404);
  });
});

describe('privacy', () => {
  it('hides fields according to settings (everyone / contacts / nobody)', async () => {
    const owner = await createUser(srv.url, 'Owner');
    const friend = await createUser(srv.url, 'Friend');
    const stranger = await createUser(srv.url, 'Stranger');

    await api(srv.url, 'POST', '/api/contacts', { token: owner.accessToken, body: { user_id: friend.id } });
    await api(srv.url, 'PATCH', '/api/users/me/privacy', {
      token: owner.accessToken,
      body: { about: 'contacts', last_seen: 'nobody' },
    });

    const asFriend = await api(srv.url, 'GET', `/api/users/${owner.id}`, { token: friend.accessToken });
    const asStranger = await api(srv.url, 'GET', `/api/users/${owner.id}`, { token: stranger.accessToken });
    expect(asFriend.body.about).toBe('Available');
    expect(asStranger.body.about).toBeNull();
    expect(asFriend.body.last_seen).toBeNull();
    expect(asFriend.body.name).toBe('Owner');
  });

  it('rejects invalid privacy values', async () => {
    const u = await createUser(srv.url);
    const r = await api(srv.url, 'PATCH', '/api/users/me/privacy', { token: u.accessToken, body: { about: 'friends' } });
    expect(r.status).toBe(400);
  });
});

describe('lookup & contacts', () => {
  it('finds a user by phone and saves them as a contact', async () => {
    const a = await createUser(srv.url, 'A');
    const b = await createUser(srv.url, 'B');
    const found = await api(srv.url, 'GET', `/api/users/lookup?phone_number=${encodeURIComponent(b.phone)}`, {
      token: a.accessToken,
    });
    expect(found.body.id).toBe(b.id);
    await api(srv.url, 'POST', '/api/contacts', { token: a.accessToken, body: { phone_number: b.phone, display_name: 'Bobby' } });
    const list = await api(srv.url, 'GET', '/api/contacts', { token: a.accessToken });
    expect(list.body.contacts).toHaveLength(1);
    expect(list.body.contacts[0]).toMatchObject({ id: b.id, contact_name: 'Bobby', is_contact: true });
  });

  it('returns 404 for unknown phone numbers', async () => {
    const a = await createUser(srv.url);
    const r = await api(srv.url, 'GET', '/api/users/lookup?phone_number=%2B19999999999', { token: a.accessToken });
    expect(r.status).toBe(404);
  });
});

describe('blocking', () => {
  it('block hides photo/about/presence both ways and can be undone', async () => {
    const a = await createUser(srv.url, 'A');
    const b = await createUser(srv.url, 'B');
    expect((await api(srv.url, 'POST', '/api/blocks', { token: a.accessToken, body: { user_id: b.id } })).status).toBe(200);

    const bSeesA = await api(srv.url, 'GET', `/api/users/${a.id}`, { token: b.accessToken });
    expect(bSeesA.body.about).toBeNull();
    expect(bSeesA.body.online).toBeNull();
    const aSeesB = await api(srv.url, 'GET', `/api/users/${b.id}`, { token: a.accessToken });
    expect(aSeesB.body.blocked_by_me).toBe(true);
    expect(aSeesB.body.about).toBeNull();

    const list = await api(srv.url, 'GET', '/api/blocks', { token: a.accessToken });
    expect(list.body.blocked.map((x: any) => x.id)).toEqual([b.id]);

    await api(srv.url, 'DELETE', `/api/blocks/${b.id}`, { token: a.accessToken });
    const after = await api(srv.url, 'GET', `/api/users/${a.id}`, { token: b.accessToken });
    expect(after.body.about).toBe('Available');
  });

  it("can't block yourself", async () => {
    const a = await createUser(srv.url);
    expect((await api(srv.url, 'POST', '/api/blocks', { token: a.accessToken, body: { user_id: a.id } })).status).toBe(400);
  });
});
