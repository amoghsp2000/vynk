import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest();
export const hmacHex = (secret: string, value: string) => createHmac('sha256', secret).update(value).digest('hex');

export function safeEqualHex(a: string, b: string) {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const numericCode = (digits = 6) => randomInt(0, 10 ** digits).toString().padStart(digits, '0');
