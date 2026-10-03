import { pool } from './pool.js';
import { migrate } from './migrate.js';
import { logger } from '../lib/logger.js';

const applied = await migrate(pool)
  .catch((err) => {
    logger.fatal({ err }, 'migrations failed');
    process.exit(1);
  })
  .finally(() => pool.end());
logger.info({ count: applied.length }, applied.length ? 'migrations complete' : 'database already up to date');
