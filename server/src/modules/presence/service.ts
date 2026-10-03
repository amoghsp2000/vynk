import { env } from '../../config/env.js';
import { query, queryOne } from '../../database/pool.js';
import { redis } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { publish } from '../../websocket/bus.js';
import { instanceId, type Connection } from '../../websocket/gateway.js';

/**
 * Server-owned presence. Redis layout:
 *   presence:conns:{userId}        HASH  connId -> instanceId      (live sockets)
 *   presence:instance:{instanceId} SET   "userId|connId"           (for crash reaping)
 *   presence:instances             ZSET  instanceId -> last beat ms
 *   presence:offline_due           ZSET  userId -> grace deadline ms
 *
 * A user is ONLINE while they have >= 1 live connection on any instance. When
 * the last one goes away they get a grace period (network blips, Wi-Fi ->
 * mobile handover, page refresh) before being marked OFFLINE and last_seen set.
 * Deadlines live in Redis, not in process timers, so they survive restarts.
 */
const connsKey = (userId: string) => `presence:conns:${userId}`;
const instanceKey = (id: string) => `presence:instance:${id}`;
const INSTANCES = 'presence:instances';
const OFFLINE_DUE = 'presence:offline_due';
const INSTANCE_DEAD_AFTER_MS = 30_000;

export async function connectionOpened(conn: Connection) {
  await redis
    .multi()
    .hset(connsKey(conn.userId), conn.id, instanceId)
    .sadd(instanceKey(instanceId), `${conn.userId}|${conn.id}`)
    .zrem(OFFLINE_DUE, conn.userId) // reconnect inside the grace period: no flap
    .exec();
  await markOnline(conn.userId);
}

export async function connectionClosed(conn: Connection) {
  const [, , remaining] = (await redis
    .multi()
    .hdel(connsKey(conn.userId), conn.id)
    .srem(instanceKey(instanceId), `${conn.userId}|${conn.id}`)
    .hlen(connsKey(conn.userId))
    .exec())!.map(([, v]) => v) as [number, number, number];
  if (remaining === 0) await scheduleOffline(conn.userId, env.PRESENCE_GRACE_MS);
}

async function scheduleOffline(userId: string, inMs: number) {
  await redis.zadd(OFFLINE_DUE, Date.now() + inMs, userId);
}

export async function isOnline(userId: string) {
  return (await redis.hlen(connsKey(userId))) > 0;
}

/** Users among `userIds` with at least one live connection. */
export async function onlineAmong(userIds: string[]) {
  if (!userIds.length) return new Set<string>();
  const p = redis.pipeline();
  for (const id of userIds) p.hlen(connsKey(id));
  const res = (await p.exec())!;
  return new Set(userIds.filter((_, i) => (res[i]![1] as number) > 0));
}

async function markOnline(userId: string) {
  const row = await queryOne(
    `UPDATE users SET online_status = 'online' WHERE id = $1 AND online_status = 'offline' RETURNING id`,
    [userId],
  );
  if (row) {
    logger.debug({ userId }, 'presence: online');
    await publish({ kind: 'presence', userId, online: true, lastSeen: null });
  }
}

async function markOffline(userId: string) {
  const row = await queryOne<{ last_seen: Date }>(
    `UPDATE users SET online_status = 'offline', last_seen = now()
     WHERE id = $1 AND online_status = 'online' RETURNING last_seen`,
    [userId],
  );
  if (row) {
    logger.debug({ userId }, 'presence: offline');
    await publish({ kind: 'presence', userId, online: false, lastSeen: row.last_seen.toISOString() });
  }
}

/** Processes expired grace periods. Safe to run on every instance concurrently. */
export async function processOfflineDue() {
  const due = await redis.zrangebyscore(OFFLINE_DUE, '-inf', Date.now(), 'LIMIT', 0, 500);
  for (const userId of due) {
    // ZREM is the claim: exactly one instance proceeds per deadline.
    if ((await redis.zrem(OFFLINE_DUE, userId)) !== 1) continue;
    if ((await redis.hlen(connsKey(userId))) > 0) continue; // came back
    await markOffline(userId);
  }
}

/** Removes connections left behind by instances that died without cleanup. */
export async function reapDeadInstances() {
  await redis.zadd(INSTANCES, Date.now(), instanceId);
  const dead = await redis.zrangebyscore(INSTANCES, '-inf', Date.now() - INSTANCE_DEAD_AFTER_MS);
  for (const id of dead) {
    if ((await redis.zrem(INSTANCES, id)) !== 1) continue;
    const entries = await redis.smembers(instanceKey(id));
    logger.warn({ instance: id, connections: entries.length }, 'presence: reaping dead instance');
    for (const e of entries) {
      const [userId, connId] = e.split('|') as [string, string];
      await redis.hdel(connsKey(userId), connId);
      if ((await redis.hlen(connsKey(userId))) === 0) await scheduleOffline(userId, 0);
    }
    await redis.del(instanceKey(id));
  }
}

/**
 * After a full restart nothing may be connected yet users are still 'online'
 * in the DB. Anyone marked online without a live connection gets a grace
 * period to reconnect, then goes offline.
 */
export async function reconcileStaleOnline() {
  const rows = await query<{ id: string }>(`SELECT id FROM users WHERE online_status = 'online'`);
  if (!rows.length) return;
  const live = await onlineAmong(rows.map((r) => r.id));
  for (const r of rows) if (!live.has(r.id)) await redis.zadd(OFFLINE_DUE, 'NX', Date.now() + env.PRESENCE_GRACE_MS, r.id);
}

export async function unregisterInstance() {
  await redis.multi().zrem(INSTANCES, instanceId).del(instanceKey(instanceId)).exec();
}
