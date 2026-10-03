import { afterAll, beforeEach } from 'vitest';
import { pool } from '../src/database/pool.js';
import { redis, closeRedis } from '../src/lib/redis.js';

// Every test starts from empty tables and an empty Redis DB (the test DB index).
beforeEach(async () => {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length) {
    await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
  await redis.flushdb();
});

afterAll(async () => {
  await pool.end();
  await closeRedis();
});
