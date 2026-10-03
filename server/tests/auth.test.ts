import { describe, expect, it } from 'vitest';
import { api, createUser, mockOtp, nextPhone, useServer } from './helpers.js';

const srv = useServer();

describe('registration', () => {
  it('registers via OTP and returns tokens + profile', async () => {
    const phone = nextPhone();
    const reg = await api(srv.url, 'POST', '/api/auth/register', {
      body: { phone_number: phone, name: 'Alice', password: 'password123' },
    });
    expect(reg.status).toBe(200);
    expect(reg.body.challenge_id).toBeTruthy();

    const v = await api(srv.url, 'POST', '/api/auth/verify-otp', {
      body: { challenge_id: reg.body.challenge_id, code: await mockOtp(phone), token_transport: 'body' },
    });
    expect(v.status).toBe(200);
    expect(v.body.access_token).toBeTruthy();
    expect(v.body.refresh_token).toBeTruthy();
    expect(v.body.user).toMatchObject({ phone_number: phone, name: 'Alice' });
    expect(v.body.user.password_hash).toBeUndefined();
  });

  it('does not create the user before OTP verification', async () => {
    const phone = nextPhone();
    await api(srv.url, 'POST', '/api/auth/register', { body: { phone_number: phone, name: 'A', password: 'password123' } });
    const login = await api(srv.url, 'POST', '/api/auth/login', { body: { phone_number: phone, password: 'password123' } });
    expect(login.status).toBe(401);
  });

  it('rejects an existing phone number', async () => {
    const u = await createUser(srv.url);
    const r = await api(srv.url, 'POST', '/api/auth/register', {
      body: { phone_number: u.phone, name: 'Dup', password: 'password123' },
    });
    expect(r.status).toBe(409);
  });

  it('validates input', async () => {
    const r = await api(srv.url, 'POST', '/api/auth/register', {
      body: { phone_number: '12345', name: '', password: 'short' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.length).toBeGreaterThanOrEqual(3);
  });

  it('normalises phone formatting', async () => {
    const r = await api(srv.url, 'POST', '/api/auth/register', {
      body: { phone_number: '+1 (415) 555-0199', name: 'Fmt', password: 'password123' },
    });
    expect(r.status).toBe(200);
    expect(await mockOtp('+14155550199')).toMatch(/^\d{6}$/);
  });
});

describe('OTP', () => {
  it('rejects a wrong code and burns the challenge after max attempts', async () => {
    const phone = nextPhone();
    const reg = await api(srv.url, 'POST', '/api/auth/register', {
      body: { phone_number: phone, name: 'A', password: 'password123' },
    });
    const code = await mockOtp(phone);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      const r = await api(srv.url, 'POST', '/api/auth/verify-otp', { body: { challenge_id: reg.body.challenge_id, code: wrong } });
      expect(r.status).toBe(400);
    }
    await api(srv.url, 'POST', '/api/auth/verify-otp', { body: { challenge_id: reg.body.challenge_id, code: wrong } });
    // Even the correct code no longer works.
    const r = await api(srv.url, 'POST', '/api/auth/verify-otp', { body: { challenge_id: reg.body.challenge_id, code } });
    expect(r.status).toBe(400);
  });

  it('is single-use', async () => {
    const phone = nextPhone();
    const reg = await api(srv.url, 'POST', '/api/auth/register', {
      body: { phone_number: phone, name: 'A', password: 'password123' },
    });
    const body = { challenge_id: reg.body.challenge_id, code: await mockOtp(phone), token_transport: 'body' };
    const [a, b] = await Promise.all([
      api(srv.url, 'POST', '/api/auth/verify-otp', { body }),
      api(srv.url, 'POST', '/api/auth/verify-otp', { body }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  it('rate limits OTP requests per phone', async () => {
    const phone = nextPhone();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await api(srv.url, 'POST', '/api/auth/register', {
        body: { phone_number: phone, name: 'A', password: 'password123' },
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('login', () => {
  it('requires password then OTP', async () => {
    const u = await createUser(srv.url);
    const l = await api(srv.url, 'POST', '/api/auth/login', { body: { phone_number: u.phone, password: u.password } });
    expect(l.status).toBe(200);
    expect(l.body.otp_required).toBe(true);
    const v = await api(srv.url, 'POST', '/api/auth/verify-otp', {
      body: { challenge_id: l.body.challenge_id, code: await mockOtp(u.phone), token_transport: 'body' },
    });
    expect(v.status).toBe(200);
    expect(v.body.user.id).toBe(u.id);
    expect(v.body.session_id).not.toBe(u.sessionId);
  });

  it('gives the same error for wrong password and unknown user', async () => {
    const u = await createUser(srv.url);
    const a = await api(srv.url, 'POST', '/api/auth/login', { body: { phone_number: u.phone, password: 'wrong-pass' } });
    const b = await api(srv.url, 'POST', '/api/auth/login', { body: { phone_number: nextPhone(), password: 'wrong-pass' } });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);
  });
});

describe('tokens', () => {
  it('rotates refresh tokens', async () => {
    const u = await createUser(srv.url);
    const r = await api(srv.url, 'POST', '/api/auth/refresh', { body: { refresh_token: u.refreshToken } });
    expect(r.status).toBe(200);
    expect(r.body.refresh_token).not.toBe(u.refreshToken);
    const me = await api(srv.url, 'GET', '/api/auth/sessions', { token: r.body.access_token });
    expect(me.status).toBe(200);
  });

  it('revokes the session when a used refresh token is replayed', async () => {
    const u = await createUser(srv.url);
    const r1 = await api(srv.url, 'POST', '/api/auth/refresh', { body: { refresh_token: u.refreshToken } });
    const replay = await api(srv.url, 'POST', '/api/auth/refresh', { body: { refresh_token: u.refreshToken } });
    expect(replay.status).toBe(401);
    // The legitimately rotated token is dead too, as is any access token for the session.
    const r2 = await api(srv.url, 'POST', '/api/auth/refresh', { body: { refresh_token: r1.body.refresh_token } });
    expect(r2.status).toBe(401);
    const s = await api(srv.url, 'GET', '/api/auth/sessions', { token: r1.body.access_token });
    expect(s.status).toBe(401);
  });

  it('refresh via cookie requires the CSRF header', async () => {
    const phone = nextPhone();
    const reg = await api(srv.url, 'POST', '/api/auth/register', { body: { phone_number: phone, name: 'C', password: 'password123' } });
    const v = await api(srv.url, 'POST', '/api/auth/verify-otp', {
      body: { challenge_id: reg.body.challenge_id, code: await mockOtp(phone) },
    });
    expect(v.body.refresh_token).toBeUndefined(); // cookie transport keeps it away from JS
    const cookie = v.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const cookieHeader = cookie.split(';')[0]!;

    const noCsrf = await api(srv.url, 'POST', '/api/auth/refresh', { headers: { cookie: cookieHeader } });
    expect(noCsrf.status).toBe(403);
    const ok = await api(srv.url, 'POST', '/api/auth/refresh', { headers: { cookie: cookieHeader, 'x-requested-with': 'parley' } });
    expect(ok.status).toBe(200);
  });
});

describe('unauthorized access', () => {
  it('rejects missing, malformed and forged tokens', async () => {
    expect((await api(srv.url, 'GET', '/api/auth/sessions')).status).toBe(401);
    expect((await api(srv.url, 'GET', '/api/auth/sessions', { token: 'garbage' })).status).toBe(401);
    // Correct shape, wrong signature.
    const forged =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJzaWQiOiJ4IiwiZGlkIjoieCJ9.AAAA';
    expect((await api(srv.url, 'GET', '/api/auth/sessions', { token: forged })).status).toBe(401);
  });

  it('logout invalidates the access token immediately', async () => {
    const u = await createUser(srv.url);
    const out = await api(srv.url, 'POST', '/api/auth/logout', { token: u.accessToken });
    expect(out.status).toBe(200);
    expect((await api(srv.url, 'GET', '/api/auth/sessions', { token: u.accessToken })).status).toBe(401);
    expect((await api(srv.url, 'POST', '/api/auth/refresh', { body: { refresh_token: u.refreshToken } })).status).toBe(401);
  });

  it('logout-all keeps only the current session', async () => {
    const u = await createUser(srv.url);
    const l = await api(srv.url, 'POST', '/api/auth/login', { body: { phone_number: u.phone, password: u.password } });
    const v = await api(srv.url, 'POST', '/api/auth/verify-otp', {
      body: { challenge_id: l.body.challenge_id, code: await mockOtp(u.phone), token_transport: 'body' },
    });
    const r = await api(srv.url, 'POST', '/api/auth/logout-all', { token: v.body.access_token });
    expect(r.body.revoked).toBe(1);
    expect((await api(srv.url, 'GET', '/api/auth/sessions', { token: u.accessToken })).status).toBe(401);
    expect((await api(srv.url, 'GET', '/api/auth/sessions', { token: v.body.access_token })).status).toBe(200);
  });
});
