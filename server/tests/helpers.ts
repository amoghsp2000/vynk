import { afterAll, beforeAll } from 'vitest';
import { redis } from '../src/lib/redis.js';
import { startServer, type RunningServer } from '../src/server.js';

let phoneCounter = 0;
export const nextPhone = () => `+1415${String(Date.now() % 1_000_000).padStart(6, '0')}${phoneCounter++ % 10}`;

/** Starts a real server on an ephemeral port for the current test file. */
export function useServer() {
  const ctx = {} as { server: RunningServer };
  beforeAll(async () => {
    ctx.server = await startServer({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await ctx.server?.close();
  });
  return {
    get url() {
      return ctx.server.url;
    },
    get wsUrl() {
      return ctx.server.url.replace('http', 'ws') + '/ws';
    },
  };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = any>(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

export const mockOtp = async (phone: string) => (await redis.get(`otp:mock:last:${phone}`))!;

export interface TestUser {
  id: string;
  phone: string;
  name: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  sessionId: string;
}

export async function createUser(base: string, name = 'Test User', phone = nextPhone()): Promise<TestUser> {
  const password = 'password123';
  const reg = await api(base, 'POST', '/api/auth/register', { body: { phone_number: phone, name, password } });
  if (reg.status !== 200) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const v = await api(base, 'POST', '/api/auth/verify-otp', {
    body: { challenge_id: reg.body.challenge_id, code: await mockOtp(phone), token_transport: 'body' },
  });
  if (v.status !== 200) throw new Error(`verify failed: ${JSON.stringify(v.body)}`);
  return {
    id: v.body.user.id,
    phone,
    name,
    password,
    accessToken: v.body.access_token,
    refreshToken: v.body.refresh_token,
    deviceId: v.body.device_id,
    sessionId: v.body.session_id,
  };
}

/** Logs the same user in again, producing a second device/session. */
export async function loginAgain(base: string, user: TestUser): Promise<TestUser> {
  const l = await api(base, 'POST', '/api/auth/login', { body: { phone_number: user.phone, password: user.password } });
  const v = await api(base, 'POST', '/api/auth/verify-otp', {
    body: { challenge_id: l.body.challenge_id, code: await mockOtp(user.phone), token_transport: 'body' },
  });
  return {
    ...user,
    accessToken: v.body.access_token,
    refreshToken: v.body.refresh_token,
    deviceId: v.body.device_id,
    sessionId: v.body.session_id,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 3000, stepMs = 25): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(stepMs);
  }
}
