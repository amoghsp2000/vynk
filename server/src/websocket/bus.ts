import { randomUUID } from 'node:crypto';
import { redisPub, redisSub } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import type { OutboundEnvelope } from './protocol.js';

/**
 * Cross-instance fan-out over Redis pub/sub. Every API instance subscribes to
 * one channel and delivers to whichever targets it holds locally, so a user
 * connected to instance A receives events produced on instance B.
 *
 * Pub/sub is fire-and-forget: anything that must survive a missed delivery is
 * persisted first and recovered through sync (see docs/SYNC.md).
 */
const CHANNEL = 'rt:bus';

export type BusMessage =
  | { kind: 'event'; users?: string[]; conns?: string[]; exceptConn?: string; envelope: OutboundEnvelope }
  | { kind: 'close-session'; sessionId: string }
  | { kind: 'presence'; userId: string; online: boolean; lastSeen: string | null };

type Handler = (msg: BusMessage) => void;
const handlers = new Set<Handler>();
let subscribed: Promise<unknown> | undefined;

export function onBusMessage(fn: Handler) {
  handlers.add(fn);
  subscribed ??= redisSub.subscribe(CHANNEL).then(() => {
    redisSub.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return;
      let msg: BusMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      for (const h of handlers) {
        try {
          h(msg);
        } catch (err) {
          logger.error({ err, kind: msg.kind }, 'bus handler failed');
        }
      }
    });
  });
  return subscribed;
}

export async function publish(msg: BusMessage) {
  await redisPub.publish(CHANNEL, JSON.stringify(msg));
}

export function envelope<P>(type: string, payload: P, from?: string): OutboundEnvelope<P> {
  return { id: randomUUID(), type, ts: Date.now(), ...(from ? { from } : {}), payload };
}

/** Sends one event to every connection of the given users (optionally skipping one connection). */
export async function sendToUsers<P>(
  userIds: string[],
  type: string,
  payload: P,
  opts: { from?: string; exceptConn?: string } = {},
) {
  if (!userIds.length) return;
  await publish({
    kind: 'event',
    users: [...new Set(userIds)],
    ...(opts.exceptConn ? { exceptConn: opts.exceptConn } : {}),
    envelope: envelope(type, payload, opts.from),
  });
}

/** Sends to specific connections (e.g. the one device bound to a call). */
export async function sendToConnections<P>(connIds: string[], type: string, payload: P, opts: { from?: string } = {}) {
  if (!connIds.length) return;
  await publish({ kind: 'event', conns: connIds, envelope: envelope(type, payload, opts.from) });
}
