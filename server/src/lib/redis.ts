import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

function create(name: string) {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    connectionName: `parley-${name}`,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  client.on('error', (err) => logger.error({ err, client: name }, 'redis error'));
  return client;
}

/** Commands. */
export const redis = create('cmd');
/** Pub/sub requires dedicated connections. */
export const redisSub = create('sub');
export const redisPub = create('pub');

export async function closeRedis() {
  await Promise.allSettled([redis.quit(), redisSub.quit(), redisPub.quit()]);
}
