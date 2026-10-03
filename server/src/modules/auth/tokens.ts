import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';
import { redis } from '../../lib/redis.js';

const key = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const ISSUER = 'parley';
const AUDIENCE = 'parley-api';

export interface AccessClaims {
  userId: string;
  sessionId: string;
  deviceId: string;
}

export async function signAccessToken(c: AccessClaims) {
  return new SignJWT({ sid: c.sessionId, did: c.deviceId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key);
}

/** Returns null for any invalid, expired or revoked token. */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || typeof payload.did !== 'string') {
      return null;
    }
    if (await isSessionRevoked(payload.sid)) return null;
    return { userId: payload.sub, sessionId: payload.sid, deviceId: payload.did };
  } catch {
    return null;
  }
}

// Access tokens are stateless, so a revoked session is remembered in Redis for
// as long as any token minted for it could still be valid.
const revokedKey = (sid: string) => `session:revoked:${sid}`;

export async function markSessionRevoked(sessionId: string) {
  await redis.set(revokedKey(sessionId), '1', 'EX', env.ACCESS_TOKEN_TTL_SECONDS + 60);
}

export async function isSessionRevoked(sessionId: string) {
  return (await redis.exists(revokedKey(sessionId))) === 1;
}
