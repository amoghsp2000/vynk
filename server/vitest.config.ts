import { defineConfig } from 'vitest/config';

// Integration tests run against real Postgres + Redis (the docker compose
// services), using a dedicated database and Redis DB index.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://parley:parley_dev_password@localhost:55432/parley_test',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:56379/1',
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789',
      OTP_HMAC_SECRET: 'test-otp-secret-0123456789abcdef0123456789abc',
      OTP_PROVIDER: 'mock',
      LOGIN_REQUIRE_OTP: 'true',
      CORS_ORIGINS: 'http://localhost:5173',
      S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:59000',
      S3_PUBLIC_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:59000',
      S3_BUCKET: 'parley-media',
      S3_ACCESS_KEY: 'parley_minio',
      S3_SECRET_KEY: 'parley_minio_dev_password',
      STUN_URLS: 'stun:localhost:3478',
      TURN_URLS: 'turn:localhost:3478?transport=udp',
      TURN_SECRET: 'test-turn-secret',
      HEARTBEAT_INTERVAL_MS: '1000',
      PRESENCE_GRACE_MS: '300',
      CALL_RING_TIMEOUT_MS: '1500',
      CALL_RECONNECT_GRACE_MS: '800',
      JOBS_ENABLED: 'false',
    },
  },
});
