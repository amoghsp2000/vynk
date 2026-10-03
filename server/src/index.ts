import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { pool } from './database/pool.js';
import { migrate } from './database/migrate.js';
import { closeRedis } from './lib/redis.js';
import { startServer } from './server.js';
import { configureBucketCors, ensureBucket } from './modules/media/storage.js';

// Migrations run on boot under an advisory lock, so several instances starting
// together are safe. Production may instead run `npm run migrate:prod` as a
// release step.
await migrate(pool);
if (env.S3_AUTO_CREATE_BUCKET) {
  await ensureBucket().catch((err) => logger.error({ err }, 'storage: could not verify/create bucket'));
}
if (env.S3_CONFIGURE_CORS) {
  await configureBucketCors().catch((err) => logger.error({ err }, 'storage: could not configure bucket CORS'));
}

const server = await startServer({ host: env.HOST, port: env.PORT });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000).unref();
  try {
    await server.close();
    await pool.end();
    await closeRedis();
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
