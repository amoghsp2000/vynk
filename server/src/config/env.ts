import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** pretty = human-readable (needs the pino-pretty dev dependency); json = structured, for containers. */
  LOG_FORMAT: z.enum(['pretty', 'json']).optional(),
  TRUST_PROXY: bool.default(false),
  INSTANCE_ID: z.string().optional(),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  REDIS_URL: z.string().url(),

  CORS_ORIGINS: csv,
  COOKIE_SECURE: bool.optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  OTP_PROVIDER: z.enum(['mock', 'twilio']).default('mock'),
  OTP_HMAC_SECRET: z.string().min(32, 'OTP_HMAC_SECRET must be at least 32 chars'),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_REQUIRE_OTP: bool.default(true),
  /** Staging/demo only: lets NODE_ENV=production run with the mock OTP provider. */
  ALLOW_MOCK_OTP_IN_PRODUCTION: bool.default(false),

  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default(true),

  STUN_URLS: csv,
  TURN_URLS: csv,
  TURN_SECRET: z.string().default(''),
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),

  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(25_000),
  PRESENCE_GRACE_MS: z.coerce.number().int().nonnegative().default(8_000),
  CALL_RING_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  CALL_RECONNECT_GRACE_MS: z.coerce.number().int().positive().default(30_000),
  JOBS_ENABLED: bool.default(true),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    // Printed before the logger exists; contains names of variables only, never values.
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (env.JWT_ACCESS_SECRET.startsWith('dev-only')) problems.push('JWT_ACCESS_SECRET');
    if (env.OTP_HMAC_SECRET.startsWith('dev-only')) problems.push('OTP_HMAC_SECRET');
    if (env.TURN_SECRET.startsWith('dev-only')) problems.push('TURN_SECRET');
    if (env.OTP_PROVIDER === 'mock' && !env.ALLOW_MOCK_OTP_IN_PRODUCTION) {
      problems.push('OTP_PROVIDER (mock is not allowed in production; set ALLOW_MOCK_OTP_IN_PRODUCTION=true for a staging demo)');
    }
    if (problems.length) {
      console.error(`Refusing to start in production with insecure settings: ${problems.join(', ')}`);
      process.exit(1);
    }
  }
  return env;
}

export const env = load();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const cookieSecure = env.COOKIE_SECURE ?? isProd;
