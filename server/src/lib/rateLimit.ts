import { redis } from './redis.js';
import { tooManyRequests } from './errors.js';

// Fixed-window counter, atomic via Lua. Cheap and good enough for abuse
// throttling; shared across all API instances through Redis.
const SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}
`;

export interface Limit {
  /** Max events per window. */
  max: number;
  windowMs: number;
}

export async function hit(key: string, limit: Limit): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const [count, ttl] = (await redis.eval(SCRIPT, 1, `rl:${key}`, limit.windowMs)) as [number, number];
  return { allowed: count <= limit.max, retryAfterMs: Math.max(ttl, 0) };
}

/** Throws 429 when the limit is exceeded. */
export async function enforce(key: string, limit: Limit) {
  const r = await hit(key, limit);
  if (!r.allowed) throw tooManyRequests(Math.ceil(r.retryAfterMs / 1000));
}

export const limits = {
  otpPerPhone: { max: 5, windowMs: 15 * 60_000 },
  otpPerIp: { max: 30, windowMs: 15 * 60_000 },
  loginPerIp: { max: 30, windowMs: 15 * 60_000 },
  loginPerPhone: { max: 10, windowMs: 15 * 60_000 },
  refreshPerIp: { max: 120, windowMs: 60_000 },
  apiPerUser: { max: 600, windowMs: 60_000 },
  apiPerIp: { max: 1200, windowMs: 60_000 },
  wsConnectPerIp: { max: 60, windowMs: 60_000 },
  passwordChangePerUser: { max: 5, windowMs: 15 * 60_000 },
  messagesPerUser: { max: 60, windowMs: 10_000 },
  typingPerUser: { max: 40, windowMs: 10_000 },
  wsEventsPerConn: { max: 300, windowMs: 10_000 },
  callsPerUser: { max: 10, windowMs: 60_000 },
  signalingPerUser: { max: 400, windowMs: 10_000 },
  uploadsPerUser: { max: 30, windowMs: 60_000 },
  statusPerUser: { max: 30, windowMs: 60 * 60_000 },
} satisfies Record<string, Limit>;
