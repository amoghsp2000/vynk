import { query, queryOne } from '../../database/pool.js';
import { domainEvents } from '../../lib/domainEvents.js';
import { logger } from '../../lib/logger.js';
import { isOnline, onlineAmong } from '../presence/service.js';
import { providerFor, type PushMessage, type PushTarget } from './providers.js';

/**
 *   event (message / call) --> recipient offline? --> notifications outbox
 *   dispatcher --> claim due rows (SKIP LOCKED) --> provider per device --> mark sent/retry/failed
 *
 * Payloads carry ids and the sender's display name only, never message text.
 */
export type NotificationType = 'message' | 'call.incoming' | 'call.missed' | 'status';

const MAX_ATTEMPTS = 5;

export async function enqueue(userId: string, type: NotificationType, payload: Record<string, unknown>, collapseKey?: string) {
  // A pending push for the same chat is updated (count++) instead of duplicated.
  await query(
    `INSERT INTO notifications (user_id, type, payload, collapse_key) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, collapse_key) WHERE state = 'pending' AND collapse_key IS NOT NULL
     DO UPDATE SET payload = jsonb_set(EXCLUDED.payload, '{count}',
                     to_jsonb(COALESCE((notifications.payload->>'count')::int, 1) + 1)),
                   next_attempt_at = LEAST(notifications.next_attempt_at, now())`,
    [userId, type, JSON.stringify({ count: 1, ...payload }), collapseKey ?? null],
  );
}

/** Name to show the recipient: what they saved the sender as, else the sender's own name. */
async function nameFor(recipientId: string, senderId: string) {
  const r = await queryOne<{ name: string }>(
    `SELECT COALESCE(c.display_name, u.name) AS name FROM users u
     LEFT JOIN contacts c ON c.owner_id = $1 AND c.contact_id = u.id WHERE u.id = $2`,
    [recipientId, senderId],
  );
  return r?.name ?? 'Someone';
}

let triggersRegistered = false;
export function registerNotificationTriggers() {
  if (triggersRegistered) return;
  triggersRegistered = true;
  domainEvents.on('message.created', async ({ message, recipientIds }) => {
    const online = await onlineAmong(recipientIds);
    for (const uid of recipientIds) {
      if (online.has(uid)) continue; // they get it live
      const muted = await queryOne(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND muted_until > now()',
        [message.conversation_id, uid],
      );
      if (muted) continue;
      await enqueue(
        uid,
        'message',
        { conversation_id: message.conversation_id, message_id: message.id, sender_name: await nameFor(uid, message.sender_id) },
        `conv:${message.conversation_id}`,
      );
    }
  });

  domainEvents.on('call.incoming', async ({ callId, callerId, calleeId }) => {
    if (await isOnline(calleeId)) return;
    await enqueue(calleeId, 'call.incoming', { call_id: callId, sender_name: await nameFor(calleeId, callerId) });
  });

  domainEvents.on('call.missed', async ({ callId, callerId, calleeId }) => {
    if (await isOnline(calleeId)) return;
    await enqueue(calleeId, 'call.missed', { call_id: callId, sender_name: await nameFor(calleeId, callerId) });
  });
}

interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date;
}

const delivery = (type: NotificationType): Pick<PushMessage, 'ttl' | 'urgency'> =>
  type === 'call.incoming' ? { ttl: 45, urgency: 'high' } : type === 'message' ? { ttl: 86_400, urgency: 'high' } : { ttl: 86_400, urgency: 'normal' };

async function finish(id: string, state: 'sent' | 'failed' | 'skipped', error: string | null) {
  await query(
    `UPDATE notifications SET state = $2, last_error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1`,
    [id, state, error],
  );
}

/** Claims and sends due notifications. Safe to run concurrently on many instances. */
export async function dispatchDue(batch = 50) {
  // Claiming pushes next_attempt_at forward (a lease): if this process dies
  // mid-send, the row becomes due again after a minute.
  const rows = await query<NotificationRow>(
    `UPDATE notifications SET attempts = attempts + 1, next_attempt_at = now() + interval '60 seconds'
     WHERE id IN (
       SELECT id FROM notifications WHERE state = 'pending' AND next_attempt_at <= now()
       ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id, user_id, type, payload, attempts, created_at`,
    [batch],
  );
  for (const n of rows) {
    try {
      await deliver(n);
    } catch (err) {
      logger.error({ err, notificationId: n.id }, 'notification: dispatch crashed');
    }
  }
  return rows.length;
}

async function deliver(n: NotificationRow) {
  const log = logger.child({ notificationId: n.id, userId: n.user_id, type: n.type });
  const { ttl, urgency } = delivery(n.type);
  if (n.type === 'call.incoming' && Date.now() - n.created_at.getTime() > ttl * 1000) {
    return finish(n.id, 'skipped', 'expired');
  }
  if (n.type === 'message' && (await isOnline(n.user_id))) {
    return finish(n.id, 'skipped', 'user_online'); // came back before we got to it
  }

  const devices = await query<{ id: string; push_provider: PushTarget['provider']; push_endpoint: string; push_p256dh: string | null; push_auth: string | null }>(
    `SELECT id, push_provider, push_endpoint, push_p256dh, push_auth FROM devices
     WHERE user_id = $1 AND push_endpoint IS NOT NULL
       AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = devices.id AND s.revoked_at IS NULL AND s.expires_at > now())`,
    [n.user_id],
  );
  if (!devices.length) return finish(n.id, 'skipped', 'no_push_devices');

  let delivered = 0;
  let retryable: string | null = null;
  let permanent: string | null = null;
  for (const d of devices) {
    const provider = providerFor(d.push_provider);
    if (!provider.enabled) {
      permanent = `${d.push_provider} provider disabled`;
      continue;
    }
    const r = await provider.send(
      { deviceId: d.id, provider: d.push_provider, endpoint: d.push_endpoint, p256dh: d.push_p256dh, auth: d.push_auth },
      { type: n.type, payload: n.payload, ttl, urgency },
    );
    if (r === 'ok') delivered++;
    else if (r === 'gone') {
      log.info({ deviceId: d.id }, 'notification: subscription gone, removing');
      await query(
        `UPDATE devices SET push_provider = NULL, push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL WHERE id = $1`,
        [d.id],
      );
    } else if (r.retryable) retryable = r.error;
    else permanent = r.error;
  }

  if (delivered) {
    log.info({ devices: delivered }, 'notification: sent');
    return finish(n.id, 'sent', null);
  }
  if (retryable && n.attempts < MAX_ATTEMPTS) {
    const backoffSec = Math.min(3600, 15 * 2 ** (n.attempts - 1));
    log.warn({ error: retryable, attempt: n.attempts, backoffSec }, 'notification: send failed, will retry');
    await query(
      `UPDATE notifications SET last_error = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`,
      [n.id, retryable, backoffSec],
    );
    return;
  }
  const reason = retryable ?? permanent ?? 'all subscriptions gone';
  log.warn({ error: reason }, 'notification: failed');
  return finish(n.id, devices.length && !retryable && !permanent ? 'skipped' : 'failed', reason);
}

// ---- device push registration ----

export async function setDevicePush(
  userId: string,
  deviceId: string,
  sub: { provider: PushTarget['provider']; endpoint: string; p256dh?: string | undefined; auth?: string | undefined },
) {
  // A browser that logs in again gets a new device row but keeps its push
  // endpoint: move the endpoint rather than failing on the unique index.
  await query(
    `UPDATE devices SET push_provider = NULL, push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL
     WHERE push_endpoint = $1 AND id <> $2`,
    [sub.endpoint, deviceId],
  );
  const row = await queryOne(
    `UPDATE devices SET push_provider = $3, push_endpoint = $4, push_p256dh = $5, push_auth = $6, last_active_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [deviceId, userId, sub.provider, sub.endpoint, sub.p256dh ?? null, sub.auth ?? null],
  );
  return Boolean(row);
}

export async function clearDevicePush(userId: string, deviceId: string) {
  await query(
    `UPDATE devices SET push_provider = NULL, push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL
     WHERE id = $1 AND user_id = $2`,
    [deviceId, userId],
  );
}
