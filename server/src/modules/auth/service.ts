import type pg from 'pg';
import { env } from '../../config/env.js';
import { query, queryOne, transaction } from '../../database/pool.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError, conflict, unauthorized } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { domainEvents } from '../../lib/domainEvents.js';
import { getDummyHash, hashPassword, verifyPassword } from './password.js';
import { markSessionRevoked, signAccessToken } from './tokens.js';
import { consumeChallenge, createChallenge, maskPhone } from './otp.js';
import { getMe } from '../users/service.js';

export interface DeviceInfo {
  device_id?: string | undefined;
  name?: string | undefined;
  platform?: 'web' | 'android' | 'ios' | 'desktop' | undefined;
}

export interface ClientContext {
  ip: string;
  userAgent: string | undefined;
}

interface RegisterPayload {
  name: string;
  passwordHash: string;
}
interface LoginPayload {
  userId: string;
}

export async function startRegistration(input: { phone_number: string; name: string; password: string }) {
  const existing = await queryOne('SELECT 1 FROM users WHERE phone_number = $1', [input.phone_number]);
  if (existing) throw conflict('An account with this phone number already exists. Log in instead.');
  const passwordHash = await hashPassword(input.password);
  const { challengeId, expiresIn } = await createChallenge<RegisterPayload>(input.phone_number, 'register', {
    name: input.name,
    passwordHash,
  });
  return { challenge_id: challengeId, expires_in: expiresIn };
}

export async function login(input: { phone_number: string; password: string; device?: DeviceInfo }, ctx: ClientContext) {
  const row = await queryOne<{ id: string; password_hash: string }>(
    `SELECT u.id, c.password_hash FROM users u JOIN user_credentials c ON c.user_id = u.id WHERE u.phone_number = $1`,
    [input.phone_number],
  );
  const ok = await verifyPassword(row?.password_hash ?? (await getDummyHash()), input.password);
  if (!row || !ok) {
    logger.warn({ phone: maskPhone(input.phone_number), ip: ctx.ip }, 'auth: login failed');
    throw new AppError(401, 'invalid_credentials', 'Incorrect phone number or password');
  }
  if (env.LOGIN_REQUIRE_OTP) {
    const { challengeId, expiresIn } = await createChallenge<LoginPayload>(input.phone_number, 'login', {
      userId: row.id,
    });
    return { otp_required: true as const, challenge_id: challengeId, expires_in: expiresIn };
  }
  return { otp_required: false as const, ...(await createSession(row.id, input.device, ctx)) };
}

export async function verifyOtp(
  input: { challenge_id: string; code: string; device?: DeviceInfo },
  ctx: ClientContext,
) {
  const challenge = await consumeChallenge<RegisterPayload | LoginPayload>(input.challenge_id, input.code);
  let userId: string;
  if (challenge.purpose === 'register') {
    const p = challenge.payload as RegisterPayload;
    userId = await transaction(async (tx) => {
      const user = await queryOne<{ id: string }>(
        `INSERT INTO users (phone_number, name) VALUES ($1, $2)
         ON CONFLICT (phone_number) DO NOTHING RETURNING id`,
        [challenge.phoneNumber, p.name],
        tx,
      );
      if (!user) throw conflict('An account with this phone number already exists. Log in instead.');
      await query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [user.id, p.passwordHash], tx);
      await query('INSERT INTO user_privacy (user_id) VALUES ($1)', [user.id], tx);
      return user.id;
    });
    logger.info({ userId }, 'auth: user registered');
  } else {
    userId = (challenge.payload as LoginPayload).userId;
    const exists = await queryOne('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!exists) throw unauthorized('Account no longer exists');
  }
  return createSession(userId, input.device, ctx);
}

async function issueRefreshToken(sessionId: string, db: pg.PoolClient) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await query('INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    sessionId,
    sha256(token),
    expiresAt,
  ], db);
  return { token, expiresAt };
}

export async function createSession(userId: string, device: DeviceInfo | undefined, ctx: ClientContext) {
  const result = await transaction(async (tx) => {
    let deviceId: string | undefined;
    if (device?.device_id) {
      // Reuse only a device the user actually owns; a foreign id is ignored.
      const d = await queryOne<{ id: string }>(
        `UPDATE devices SET last_active_at = now(), name = COALESCE($3, name)
         WHERE id = $1 AND user_id = $2 RETURNING id`,
        [device.device_id, userId, device.name ?? null],
        tx,
      );
      deviceId = d?.id;
    }
    if (!deviceId) {
      const d = await queryOne<{ id: string }>(
        `INSERT INTO devices (user_id, name, platform) VALUES ($1, $2, $3) RETURNING id`,
        [userId, device?.name ?? 'Unknown device', device?.platform ?? 'web'],
        tx,
      );
      deviceId = d!.id;
    }
    const session = await queryOne<{ id: string }>(
      `INSERT INTO sessions (user_id, device_id, ip, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id`,
      [userId, deviceId, ctx.ip, ctx.userAgent?.slice(0, 300) ?? null, env.REFRESH_TOKEN_TTL_DAYS],
      tx,
    );
    const refresh = await issueRefreshToken(session!.id, tx);
    return { sessionId: session!.id, deviceId, refresh };
  });
  const accessToken = await signAccessToken({ userId, sessionId: result.sessionId, deviceId: result.deviceId });
  logger.info({ userId, sessionId: result.sessionId, deviceId: result.deviceId }, 'auth: session created');
  return {
    access_token: accessToken,
    expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: result.refresh.token,
    refresh_expires_at: result.refresh.expiresAt.toISOString(),
    session_id: result.sessionId,
    device_id: result.deviceId,
    user: await getMe(userId),
  };
}

export async function refresh(token: string) {
  const outcome = await transaction(async (tx) => {
    const row = await queryOne<{
      id: string;
      used_at: Date | null;
      expires_at: Date;
      session_id: string;
      user_id: string;
      device_id: string;
      revoked_at: Date | null;
      session_expires_at: Date;
    }>(
      `SELECT rt.id, rt.used_at, rt.expires_at, s.id AS session_id, s.user_id, s.device_id,
              s.revoked_at, s.expires_at AS session_expires_at
       FROM refresh_tokens rt JOIN sessions s ON s.id = rt.session_id
       WHERE rt.token_hash = $1
       FOR UPDATE OF rt, s`,
      [sha256(token)],
      tx,
    );
    if (!row) return { kind: 'invalid' as const };
    if (row.used_at) {
      // A rotated-out token was replayed: assume theft and kill the session.
      await query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'refresh_token_reuse'
         WHERE id = $1 AND revoked_at IS NULL`,
        [row.session_id],
        tx,
      );
      return { kind: 'reuse' as const, sessionId: row.session_id, userId: row.user_id };
    }
    const now = Date.now();
    if (row.revoked_at || row.expires_at.getTime() < now || row.session_expires_at.getTime() < now) {
      return { kind: 'invalid' as const };
    }
    await query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [row.id], tx);
    await query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [row.session_id], tx);
    const next = await issueRefreshToken(row.session_id, tx);
    return { kind: 'ok' as const, row, next };
  });

  if (outcome.kind === 'reuse') {
    logger.warn({ sessionId: outcome.sessionId, userId: outcome.userId }, 'auth: refresh token reuse detected, session revoked');
    await markSessionRevoked(outcome.sessionId);
    domainEvents.emit('session.revoked', { sessionId: outcome.sessionId, userId: outcome.userId });
    throw unauthorized('Session expired, please log in again');
  }
  if (outcome.kind === 'invalid') throw unauthorized('Session expired, please log in again');

  const { row, next } = outcome;
  const accessToken = await signAccessToken({ userId: row.user_id, sessionId: row.session_id, deviceId: row.device_id });
  return {
    access_token: accessToken,
    expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: next.token,
    refresh_expires_at: next.expiresAt.toISOString(),
    session_id: row.session_id,
    device_id: row.device_id,
    user: await getMe(row.user_id),
  };
}

export async function revokeSession(sessionId: string, userId: string, reason: string) {
  const row = await queryOne(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $3
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [sessionId, userId, reason],
  );
  // Only act on sessions the caller owns; otherwise anyone who learned a
  // session id could sign its owner out.
  if (!row) return false;
  await markSessionRevoked(sessionId);
  domainEvents.emit('session.revoked', { sessionId, userId });
  return true;
}

/** Revokes the session a presented refresh token belongs to (cookie-only logout). */
export async function revokeByRefreshToken(token: string) {
  const row = await queryOne<{ session_id: string; user_id: string }>(
    `SELECT s.id AS session_id, s.user_id FROM refresh_tokens rt JOIN sessions s ON s.id = rt.session_id
     WHERE rt.token_hash = $1`,
    [sha256(token)],
  );
  if (row) await revokeSession(row.session_id, row.user_id, 'logout');
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  const rows = await query<{ id: string }>(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout_all'
     WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2) RETURNING id`,
    [userId, exceptSessionId ?? null],
  );
  for (const r of rows) {
    await markSessionRevoked(r.id);
    domainEvents.emit('session.revoked', { sessionId: r.id, userId });
  }
  return rows.length;
}

export async function listSessions(userId: string, currentSessionId: string) {
  const rows = await query(
    `SELECT s.id, s.created_at, s.last_used_at, s.user_agent, d.id AS device_id, d.name AS device_name, d.platform
     FROM sessions s JOIN devices d ON d.id = s.device_id
     WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
     ORDER BY s.last_used_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
}

/** Changing the password signs out every other session (they may belong to whoever knew the old one). */
export async function changePassword(userId: string, sessionId: string, current: string, next: string) {
  const row = await queryOne<{ password_hash: string }>('SELECT password_hash FROM user_credentials WHERE user_id = $1', [userId]);
  if (!row || !(await verifyPassword(row.password_hash, current))) {
    logger.warn({ userId }, 'auth: password change with wrong current password');
    throw new AppError(401, 'invalid_credentials', 'Current password is incorrect');
  }
  await query('UPDATE user_credentials SET password_hash = $2, password_updated_at = now() WHERE user_id = $1', [
    userId,
    await hashPassword(next),
  ]);
  const revoked = await revokeAllSessions(userId, sessionId);
  logger.info({ userId, revoked }, 'auth: password changed');
  return { ok: true, revoked_sessions: revoked };
}
