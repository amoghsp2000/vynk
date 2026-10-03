import pg from 'pg';

/** Resets the test database schema once per run, then applies all migrations. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://parley:parley_dev_password@localhost:55432/parley_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();

  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  for (const [k, v] of Object.entries({
    REDIS_URL: 'redis://localhost:56379/1',
    JWT_ACCESS_SECRET: 'x'.repeat(40),
    OTP_HMAC_SECRET: 'y'.repeat(40),
    S3_ENDPOINT: 'http://localhost:59000',
    S3_PUBLIC_ENDPOINT: 'http://localhost:59000',
    S3_BUCKET: 'parley-media',
    S3_ACCESS_KEY: 'x',
    S3_SECRET_KEY: 'x',
  })) {
    process.env[k] ??= v;
  }
  const { pool } = await import('../src/database/pool.js');
  const { migrate } = await import('../src/database/migrate.js');
  await migrate(pool);
  await pool.end();
  const { closeRedis } = await import('../src/lib/redis.js');
  await closeRedis();
}
