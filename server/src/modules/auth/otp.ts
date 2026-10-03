import { env, isProd } from '../../config/env.js';
import { hmacHex, numericCode, randomToken, safeEqualHex } from '../../lib/crypto.js';
import { redis } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { AppError, badRequest } from '../../lib/errors.js';

/** Delivery channel for one-time codes. Swap implementations via OTP_PROVIDER. */
export interface OtpProvider {
  readonly name: string;
  send(phoneNumber: string, code: string): Promise<void>;
}

/**
 * Development provider: nothing is sent. The latest code per phone is kept in
 * Redis so the dev-only endpoint GET /api/dev/otp can show it.
 */
class MockOtpProvider implements OtpProvider {
  readonly name = 'mock';
  async send(phoneNumber: string, code: string) {
    await redis.set(`otp:mock:last:${phoneNumber}`, code, 'EX', env.OTP_TTL_SECONDS);
    logger.info({ phone: maskPhone(phoneNumber) }, 'mock OTP issued (read it via GET /api/dev/otp)');
  }
}

/** INCOMPLETE: placeholder for a real SMS provider. Fails loudly rather than pretending. */
class TwilioOtpProvider implements OtpProvider {
  readonly name = 'twilio';
  async send(): Promise<void> {
    throw new AppError(503, 'otp_unavailable', 'SMS provider is not implemented yet');
  }
}

export const otpProvider: OtpProvider = env.OTP_PROVIDER === 'twilio' ? new TwilioOtpProvider() : new MockOtpProvider();
// The dev endpoint that reveals codes is never exposed in production, even
// when the mock provider is allowed for a staging demo.
export const mockOtpEnabled = otpProvider.name === 'mock' && !isProd;

export const maskPhone = (p: string) => `${p.slice(0, 3)}***${p.slice(-2)}`;

export type OtpPurpose = 'register' | 'login';

export interface OtpChallenge<P = unknown> {
  phoneNumber: string;
  purpose: OtpPurpose;
  codeHash: string;
  attempts: number;
  /** Purpose-specific data carried to verification (e.g. pending registration). */
  payload: P;
}

const challengeKey = (id: string) => `otp:challenge:${id}`;
const hashCode = (challengeId: string, code: string) => hmacHex(env.OTP_HMAC_SECRET, `${challengeId}:${code}`);

export async function createChallenge<P>(phoneNumber: string, purpose: OtpPurpose, payload: P) {
  const challengeId = randomToken(24);
  const code = numericCode(6);
  const challenge: OtpChallenge<P> = {
    phoneNumber,
    purpose,
    codeHash: hashCode(challengeId, code),
    attempts: 0,
    payload,
  };
  await redis.set(challengeKey(challengeId), JSON.stringify(challenge), 'EX', env.OTP_TTL_SECONDS);
  await otpProvider.send(phoneNumber, code);
  return { challengeId, expiresIn: env.OTP_TTL_SECONDS };
}

/**
 * Verifies and consumes a challenge. Wrong codes count toward OTP_MAX_ATTEMPTS,
 * after which the challenge is destroyed.
 */
export async function consumeChallenge<P>(challengeId: string, code: string): Promise<OtpChallenge<P>> {
  const key = challengeKey(challengeId);
  const raw = await redis.get(key);
  if (!raw) throw badRequest('Verification code expired or invalid. Request a new code.');
  const challenge = JSON.parse(raw) as OtpChallenge<P>;

  if (!safeEqualHex(challenge.codeHash, hashCode(challengeId, code))) {
    challenge.attempts += 1;
    if (challenge.attempts >= env.OTP_MAX_ATTEMPTS) {
      await redis.del(key);
      throw badRequest('Too many incorrect attempts. Request a new code.');
    }
    await redis.set(key, JSON.stringify(challenge), 'KEEPTTL');
    throw badRequest('Incorrect verification code');
  }
  // GETDEL-style single use: only the caller that deletes it proceeds.
  if ((await redis.del(key)) !== 1) throw badRequest('Verification code already used');
  return challenge;
}
