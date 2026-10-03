import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

// Return BIGINT (int8) as string to avoid precision loss; callers convert when safe.
pg.types.setTypeParser(20, (v) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function query<R extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<R[]> {
  try {
    const res = await db.query<R>(text, params);
    return res.rows;
  } catch (err) {
    // Log the statement shape, never the parameter values (they may hold private data).
    logger.error({ err, sql: text.slice(0, 200) }, 'database query failed');
    throw err;
  }
}

export async function queryOne<R extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<R | undefined> {
  const rows = await query<R>(text, params, db);
  return rows[0];
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
