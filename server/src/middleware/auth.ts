import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../lib/errors.js';
import { enforce, limits } from '../lib/rateLimit.js';
import { verifyAccessToken, type AccessClaims } from '../modules/auth/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AccessClaims | null;
  }
}

export function bearerToken(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return undefined;
  return h.slice(7).trim() || undefined;
}

/** preHandler: requires a valid, non-revoked access token. Identity comes only from the token. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  const token = bearerToken(req);
  if (!token) throw unauthorized();
  const claims = await verifyAccessToken(token);
  if (!claims) {
    req.log.info({ reason: 'invalid_or_expired_token' }, 'auth: rejected access token');
    throw unauthorized('Invalid or expired access token');
  }
  req.auth = claims;
  req.log = req.log.child({ userId: claims.userId });
  await enforce(`api:${claims.userId}`, limits.apiPerUser);
}

/** Helper for handlers behind requireAuth. */
export function authOf(req: FastifyRequest): AccessClaims {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/**
 * CSRF guard for endpoints that accept the refresh-token cookie. Browsers cannot
 * attach a custom header cross-site without a CORS preflight, which our CORS
 * policy only grants to configured origins. Combined with SameSite=Strict.
 */
export async function requireCsrfHeader(req: FastifyRequest) {
  if (req.headers['x-requested-with'] !== 'parley') throw forbidden('Missing CSRF header');
}
