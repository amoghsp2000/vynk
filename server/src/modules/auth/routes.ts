import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cookieSecure } from '../../config/env.js';
import { parse, phoneNumber, cleanText, uuid } from '../../lib/validation.js';
import { enforce, limits } from '../../lib/rateLimit.js';
import { unauthorized, notFound } from '../../lib/errors.js';
import { redis } from '../../lib/redis.js';
import { authOf, requireAuth, requireCsrfHeader } from '../../middleware/auth.js';
import { mockOtpEnabled } from './otp.js';
import * as auth from './service.js';

const REFRESH_COOKIE = 'parley_rt';

const password = z.string().min(8, 'Password must be at least 8 characters').max(128);
const device = z
  .object({
    device_id: uuid.optional(),
    name: cleanText(100).optional(),
    platform: z.enum(['web', 'android', 'ios', 'desktop']).optional(),
  })
  .optional();
/** 'cookie' (browsers): refresh token only in an httpOnly cookie. 'body': mobile/native clients. */
const tokenTransport = z.enum(['cookie', 'body']).default('cookie');

const ctxOf = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

type Tokens = Awaited<ReturnType<typeof auth.createSession>>;

function sendTokens(reply: FastifyReply, transport: 'cookie' | 'body', tokens: Tokens) {
  if (transport === 'cookie') {
    reply.setCookie(REFRESH_COOKIE, tokens.refresh_token, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: 'strict',
      path: '/api/auth',
      expires: new Date(tokens.refresh_expires_at),
    });
    const { refresh_token: _omit, ...rest } = tokens;
    return rest;
  }
  return tokens;
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/register', async (req) => {
    const body = parse(
      z.object({ phone_number: phoneNumber, name: cleanText(64, 1), password }),
      req.body,
    );
    await enforce(`otp:ip:${req.ip}`, limits.otpPerIp);
    await enforce(`otp:phone:${body.phone_number}`, limits.otpPerPhone);
    return auth.startRegistration(body);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(
      z.object({ phone_number: phoneNumber, password: z.string().min(1).max(128), device, token_transport: tokenTransport }),
      req.body,
    );
    await enforce(`login:ip:${req.ip}`, limits.loginPerIp);
    await enforce(`login:phone:${body.phone_number}`, limits.loginPerPhone);
    const result = await auth.login(body, ctxOf(req));
    if (result.otp_required) {
      await enforce(`otp:phone:${body.phone_number}`, limits.otpPerPhone);
      return result;
    }
    const { otp_required, ...tokens } = result;
    return { otp_required, ...sendTokens(reply, body.token_transport, tokens) };
  });

  app.post('/api/auth/verify-otp', async (req, reply) => {
    const body = parse(
      z.object({
        challenge_id: z.string().min(10).max(64),
        code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
        device,
        token_transport: tokenTransport,
      }),
      req.body,
    );
    await enforce(`otp-verify:ip:${req.ip}`, limits.loginPerIp);
    const tokens = await auth.verifyOtp(body, ctxOf(req));
    return sendTokens(reply, body.token_transport, tokens);
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    const body = parse(z.object({ refresh_token: z.string().min(20).max(200).optional() }).optional(), req.body);
    await enforce(`refresh:ip:${req.ip}`, limits.refreshPerIp);
    const cookieToken = req.cookies[REFRESH_COOKIE];
    // Cookie path is CSRF-guarded; body path is for native clients holding the token themselves.
    if (!body?.refresh_token && cookieToken) await requireCsrfHeader(req);
    const token = body?.refresh_token ?? cookieToken;
    if (!token) throw unauthorized('No refresh token');
    try {
      const tokens = await auth.refresh(token);
      return sendTokens(reply, body?.refresh_token ? 'body' : 'cookie', tokens);
    } catch (err) {
      if (!body?.refresh_token) reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw err;
    }
  });

  // Logout works with either a valid access token or just the refresh cookie,
  // so a user whose access token already expired can still sign out.
  app.post('/api/auth/logout', async (req, reply) => {
    const cookieToken = req.cookies[REFRESH_COOKIE];
    const header = req.headers.authorization;
    if (header) {
      await requireAuth(req, reply);
      const a = authOf(req);
      await auth.revokeSession(a.sessionId, a.userId, 'logout');
    } else if (cookieToken) {
      await requireCsrfHeader(req);
      await auth.revokeByRefreshToken(cookieToken);
    } else {
      throw unauthorized();
    }
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { ok: true };
  });

  app.post('/api/auth/logout-all', { preHandler: requireAuth }, async (req) => {
    const a = authOf(req);
    const revoked = await auth.revokeAllSessions(a.userId, a.sessionId);
    return { ok: true, revoked };
  });

  app.post('/api/auth/password', { preHandler: requireAuth }, async (req) => {
    const a = authOf(req);
    const body = parse(z.object({ current_password: z.string().min(1).max(128), new_password: password }), req.body);
    await enforce(`pwchange:${a.userId}`, limits.passwordChangePerUser);
    return auth.changePassword(a.userId, a.sessionId, body.current_password, body.new_password);
  });

  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (req) => {
    const a = authOf(req);
    return { sessions: await auth.listSessions(a.userId, a.sessionId) };
  });

  app.delete('/api/auth/sessions/:id', { preHandler: requireAuth }, async (req) => {
    const a = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    if (!(await auth.revokeSession(id, a.userId, 'revoked_by_user'))) throw notFound('Session');
    return { ok: true };
  });

  // Development-only helper so the OTP flow is testable without SMS.
  if (mockOtpEnabled) {
    app.get('/api/dev/otp', async (req) => {
      const { phone_number } = parse(z.object({ phone_number: phoneNumber }), req.query);
      const code = await redis.get(`otp:mock:last:${phone_number}`);
      if (!code) throw notFound('OTP');
      return { phone_number, code, note: 'Development mock OTP provider — disabled in production' };
    });
  }
}
