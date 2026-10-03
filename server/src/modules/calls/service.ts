import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { query, queryOne, transaction } from '../../database/pool.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { domainEvents } from '../../lib/domainEvents.js';
import { logger } from '../../lib/logger.js';
import { redis } from '../../lib/redis.js';
import { sendToConnections, sendToUsers } from '../../websocket/bus.js';
import { iceServersFor } from '../../webrtc/iceServers.js';
import { directKey } from '../conversations/service.js';
import { getProfiles } from '../users/service.js';
import { isBlockedBetween } from '../users/service.js';

export type CallStatus =
  | 'INITIATING' | 'RINGING' | 'ACCEPTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING'
  | 'ENDED' | 'REJECTED' | 'MISSED' | 'FAILED';

export const ACTIVE: CallStatus[] = ['INITIATING', 'RINGING', 'ACCEPTED', 'CONNECTING', 'CONNECTED', 'RECONNECTING'];
const LIVE: CallStatus[] = ['ACCEPTED', 'CONNECTING', 'CONNECTED', 'RECONNECTING'];
const SETUP_TIMEOUT_MS = 60_000;

interface CallRow {
  id: string;
  type: 'voice' | 'video';
  conversation_id: string | null;
  caller_id: string;
  receiver_id: string | null;
  status: CallStatus;
  end_reason: string | null;
  ended_by: string | null;
  created_at: Date;
  ring_deadline: Date | null;
  answered_at: Date | null;
  connected_at: Date | null;
  ended_at: Date | null;
}

interface ParticipantRow {
  call_id: string;
  user_id: string;
  role: 'caller' | 'callee';
  device_id: string | null;
  conn_id: string | null;
  joined_at: Date | null;
  left_at: Date | null;
  disconnected_at: Date | null;
}

export interface Actor {
  userId: string;
  deviceId: string;
  connId?: string | undefined;
}

export function toCallDto(c: CallRow) {
  const duration = c.connected_at && c.ended_at ? c.ended_at.getTime() - c.connected_at.getTime() : null;
  return {
    id: c.id,
    type: c.type,
    status: c.status,
    end_reason: c.end_reason,
    ended_by: c.ended_by,
    caller_id: c.caller_id,
    receiver_id: c.receiver_id,
    conversation_id: c.conversation_id,
    created_at: c.created_at.toISOString(),
    answered_at: c.answered_at?.toISOString() ?? null,
    connected_at: c.connected_at?.toISOString() ?? null,
    ended_at: c.ended_at?.toISOString() ?? null,
    duration_ms: duration,
  };
}

// ---------------------------------------------------------------------------
// Busy locks: one active call per user, claimed atomically in Redis.
// ---------------------------------------------------------------------------
const lockKey = (userId: string) => `call:active:${userId}`;
const offerKey = (callId: string) => `call:offer:${callId}`;
const iceKey = (callId: string, toUserId: string) => `call:ice:${callId}:${toUserId}`;
const LOCK_TTL = 6 * 3600;

const CAS_SET = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 end return 0`;
const CAS_DEL = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

async function acquireLock(userId: string, callId: string): Promise<boolean> {
  if (await redis.set(lockKey(userId), callId, 'EX', LOCK_TTL, 'NX')) return true;
  const holder = await redis.get(lockKey(userId));
  if (holder === callId) return true;
  if (!holder) return acquireLock(userId, callId);
  // Self-heal: a lock left behind by a call that has already ended is stale.
  const row = await queryOne<{ status: CallStatus }>('SELECT status FROM calls WHERE id = $1', [holder]);
  if (row && ACTIVE.includes(row.status)) return false;
  return (await redis.eval(CAS_SET, 1, lockKey(userId), holder, callId, LOCK_TTL)) === 1;
}

async function releaseLock(userId: string, callId: string) {
  await redis.eval(CAS_DEL, 1, lockKey(userId), callId);
}

// ---------------------------------------------------------------------------
// Loading & authorization
// ---------------------------------------------------------------------------
async function loadCall(callId: string) {
  return queryOne<CallRow>('SELECT * FROM calls WHERE id = $1', [callId]);
}

/** The caller must be a participant; everyone else gets 404. */
async function requireParticipant(userId: string, callId: string) {
  const [rows, call] = await Promise.all([
    query<ParticipantRow>('SELECT * FROM call_participants WHERE call_id = $1', [callId]),
    loadCall(callId),
  ]);
  const me = rows.find((r) => r.user_id === userId);
  if (!me || !call) throw notFound('Call');
  const peer = rows.find((r) => r.user_id !== userId)!;
  return { call, me, peer };
}

function requireState(call: CallRow, allowed: CallStatus[]) {
  if (!allowed.includes(call.status)) {
    throw new AppError(409, 'invalid_call_state', `Call is ${call.status}`, { status: call.status });
  }
}

/**
 * Signaling for a participant must come from the one connection bound to the
 * call; other devices of the same user can't inject events into it.
 */
async function ensureBound(me: ParticipantRow, actor: Actor) {
  if (!actor.connId) throw badRequest('Call signaling requires a realtime connection');
  if (me.conn_id === actor.connId) return;
  if (me.conn_id && me.device_id !== actor.deviceId) {
    throw new AppError(409, 'call_on_other_device', 'This call is active on another device');
  }
  if (me.conn_id && me.device_id === actor.deviceId) {
    // Same device on a new connection must use call.resume explicitly.
    throw new AppError(409, 'resume_required', 'Reconnected device must send call.resume first');
  }
  await query(
    `UPDATE call_participants SET conn_id = $3, device_id = $4, joined_at = COALESCE(joined_at, now())
     WHERE call_id = $1 AND user_id = $2`,
    [me.call_id, me.user_id, actor.connId, actor.deviceId],
  );
  me.conn_id = actor.connId;
  me.device_id = actor.deviceId;
}

/** Conditional transition; returns null if the call had already moved on. */
async function transition(callId: string, from: CallStatus[], to: CallStatus, extra = '') {
  return queryOne<CallRow>(
    `UPDATE calls SET status = $3 ${extra} WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`,
    [callId, from, to],
  );
}

/**
 * Moves a call to a terminal state exactly once, releases busy locks, clears
 * buffered signaling and tells every device of both parties.
 */
async function finalize(callId: string, to: CallStatus, reason: string, endedBy: string | null) {
  const call = await queryOne<CallRow>(
    `UPDATE calls SET status = $2, end_reason = $3, ended_by = $4, ended_at = now()
     WHERE id = $1 AND status = ANY($5::text[]) RETURNING *`,
    [callId, to, reason, endedBy, ACTIVE],
  );
  if (!call) return null;
  await query('UPDATE call_participants SET left_at = now() WHERE call_id = $1 AND left_at IS NULL', [callId]);
  const parties = [call.caller_id, call.receiver_id].filter(Boolean) as string[];
  await Promise.all(parties.map((u) => releaseLock(u, callId)));
  await redis.del(offerKey(callId), ...parties.map((u) => iceKey(callId, u)));
  logger.info({ callId, status: to, reason }, 'call: ended');

  const silent = call.receiver_id ? await isBlockedBetween(call.caller_id, call.receiver_id) : false;
  const dto = toCallDto(call);
  await sendToUsers([call.caller_id], 'call.ended', dto);
  if (call.receiver_id && !silent) {
    await sendToUsers([call.receiver_id], 'call.ended', dto);
    if (to === 'MISSED') {
      await sendToUsers([call.receiver_id], 'call.missed', dto);
      domainEvents.emit('call.missed', { callId, callerId: call.caller_id, calleeId: call.receiver_id });
    }
  }
  return call;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
export async function initiate(actor: Actor, calleeId: string, type: 'voice' | 'video' = 'voice') {
  if (calleeId === actor.userId) throw badRequest('You cannot call yourself');
  const callee = await queryOne('SELECT 1 FROM users WHERE id = $1', [calleeId]);
  if (!callee) throw notFound('User');
  const blocked = await queryOne<{ by_me: boolean }>(
    `SELECT blocker_id = $1 AS by_me FROM blocks
     WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
    [actor.userId, calleeId],
  );
  if (blocked?.by_me) throw new AppError(403, 'blocked', 'You blocked this contact. Unblock to call.');
  // If the callee blocked the caller, the call "rings" for the caller but the
  // callee is never notified (the block isn't revealed).
  const silent = Boolean(blocked);

  const callId = randomUUID();
  if (!(await acquireLock(actor.userId, callId))) throw conflict('You are already in a call');

  const conv = await queryOne<{ id: string }>('SELECT id FROM conversations WHERE direct_key = $1', [
    directKey(actor.userId, calleeId),
  ]);
  await transaction(async (tx) => {
    await query(
      `INSERT INTO calls (id, type, conversation_id, caller_id, receiver_id, status) VALUES ($1, $2, $3, $4, $5, 'INITIATING')`,
      [callId, type, conv?.id ?? null, actor.userId, calleeId],
      tx,
    );
    await query(
      `INSERT INTO call_participants (call_id, user_id, role, device_id, conn_id, joined_at)
       VALUES ($1, $2, 'caller', $3, $4, now()), ($1, $5, 'callee', NULL, NULL, NULL)`,
      [callId, actor.userId, actor.deviceId, actor.connId ?? null, calleeId],
      tx,
    );
  });

  if (!(await acquireLock(calleeId, callId))) {
    logger.info({ callId }, 'call: callee busy');
    const call = await finalize(callId, 'MISSED', 'busy', null);
    await sendToUsers([actor.userId], 'call.busy', { call_id: callId });
    return { call: toCallDto(call!), busy: true, ...iceServersFor(actor.userId) };
  }

  const call = (await transition(
    callId,
    ['INITIATING'],
    'RINGING',
    `, ring_deadline = now() + make_interval(secs => ${Math.ceil(env.CALL_RING_TIMEOUT_MS) / 1000})`,
  ))!;
  logger.info({ callId, callerId: actor.userId, calleeId, type }, 'call: ringing');
  if (!silent) {
    const caller = (await getProfiles(calleeId, [actor.userId])).get(actor.userId);
    await sendToUsers([calleeId], 'call.incoming', { call: toCallDto(call), caller }, { from: actor.userId });
    domainEvents.emit('call.incoming', { callId, callerId: actor.userId, calleeId, type });
  }
  return { call: toCallDto(call), busy: false, ...iceServersFor(actor.userId) };
}

/** SDP offer: initial (from caller, possibly before the callee picks up) or renegotiation / ICE restart. */
export async function offer(actor: Actor, callId: string, sdp: string) {
  const { call, me, peer } = await requireParticipant(actor.userId, callId);
  requireState(call, ['RINGING', ...LIVE]);
  if (call.status === 'RINGING' && me.role !== 'caller') throw new AppError(409, 'invalid_call_state', 'Accept the call first');
  await ensureBound(me, actor);
  if (peer.conn_id) {
    await sendToConnections([peer.conn_id], 'call.offer', { call_id: callId, sdp }, { from: actor.userId });
  } else {
    // Callee hasn't picked a device yet: hand the offer over on accept.
    await redis.set(offerKey(callId), JSON.stringify({ sdp, from: actor.userId }), 'EX', 300);
  }
  return { ok: true };
}

export async function answer(actor: Actor, callId: string, sdp: string) {
  const { call, me, peer } = await requireParticipant(actor.userId, callId);
  requireState(call, LIVE);
  await ensureBound(me, actor);
  if (!peer.conn_id) throw new AppError(409, 'peer_unavailable', 'Peer has no signaling connection');
  if (call.status === 'ACCEPTED') await transition(callId, ['ACCEPTED'], 'CONNECTING');
  await sendToConnections([peer.conn_id], 'call.answer', { call_id: callId, sdp }, { from: actor.userId });
  return { ok: true };
}

export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null | undefined;
  sdpMLineIndex?: number | null | undefined;
  usernameFragment?: string | null | undefined;
}

export async function iceCandidate(actor: Actor, callId: string, candidate: IceCandidate) {
  const { call, me, peer } = await requireParticipant(actor.userId, callId);
  requireState(call, ['RINGING', ...LIVE]);
  await ensureBound(me, actor);
  if (peer.conn_id) {
    await sendToConnections([peer.conn_id], 'call.ice_candidate', { call_id: callId, candidate }, { from: actor.userId });
  } else {
    // Candidates often arrive before the callee accepts: buffer, deliver on accept.
    const key = iceKey(callId, peer.user_id);
    await redis.multi().rpush(key, JSON.stringify(candidate)).ltrim(key, -200, -1).expire(key, 300).exec();
  }
  return { ok: true };
}

export async function accept(actor: Actor, callId: string) {
  const { me, peer } = await requireParticipant(actor.userId, callId);
  if (me.role !== 'callee') throw new AppError(409, 'invalid_call_state', 'Only the callee can accept');
  const call = await transition(callId, ['RINGING'], 'ACCEPTED', ', answered_at = now()');
  if (!call) {
    const current = (await loadCall(callId))!;
    throw new AppError(409, 'invalid_call_state', `Call is ${current.status}`, { status: current.status });
  }
  await ensureBound(me, actor);
  const [offerRaw, candidatesRaw] = await Promise.all([
    redis.get(offerKey(callId)),
    redis.lrange(iceKey(callId, actor.userId), 0, -1),
  ]);
  await redis.del(offerKey(callId), iceKey(callId, actor.userId));
  const dto = toCallDto(call);
  logger.info({ callId }, 'call: accepted');
  if (peer.conn_id) await sendToConnections([peer.conn_id], 'call.accepted', dto, { from: actor.userId });
  // Stop ringing on the callee's other devices.
  await sendToUsers([actor.userId], 'call.answered_elsewhere', { call_id: callId }, actor.connId ? { exceptConn: actor.connId } : {});
  return {
    call: dto,
    offer: offerRaw ? (JSON.parse(offerRaw).sdp as string) : null,
    candidates: candidatesRaw.map((c) => JSON.parse(c) as IceCandidate),
    ...iceServersFor(actor.userId),
  };
}

export async function reject(actor: Actor, callId: string) {
  const { call, me } = await requireParticipant(actor.userId, callId);
  if (me.role !== 'callee') throw new AppError(409, 'invalid_call_state', 'Only the callee can reject');
  requireState(call, ['INITIATING', 'RINGING']);
  const done = await finalize(callId, 'REJECTED', 'rejected', actor.userId);
  if (!done) throw new AppError(409, 'invalid_call_state', 'Call already ended');
  return { call: toCallDto(done) };
}

export async function end(actor: Actor, callId: string) {
  const { call, me } = await requireParticipant(actor.userId, callId);
  if (!ACTIVE.includes(call.status)) return { call: toCallDto(call) }; // idempotent
  let done: CallRow | null;
  if (call.status === 'INITIATING' || call.status === 'RINGING') {
    done =
      me.role === 'caller'
        ? await finalize(callId, 'MISSED', 'cancelled', actor.userId)
        : await finalize(callId, 'REJECTED', 'rejected', actor.userId);
  } else {
    done = await finalize(callId, 'ENDED', 'hangup', actor.userId);
  }
  return { call: toCallDto(done ?? (await loadCall(callId))!) };
}

/** Client-observed ICE state, used for CONNECTED / RECONNECTING transitions. */
export async function reportState(actor: Actor, callId: string, state: 'connected' | 'reconnecting') {
  const { call, me, peer } = await requireParticipant(actor.userId, callId);
  requireState(call, LIVE);
  await ensureBound(me, actor);
  const updated =
    state === 'connected'
      ? await transition(callId, ['ACCEPTED', 'CONNECTING', 'RECONNECTING'], 'CONNECTED', ', connected_at = COALESCE(connected_at, now())')
      : await transition(callId, ['CONNECTED'], 'RECONNECTING');
  if (updated) {
    logger.info({ callId, status: updated.status }, 'call: state');
    if (peer.conn_id) {
      await sendToConnections([peer.conn_id], 'call.state', { call_id: callId, status: updated.status, user_id: actor.userId });
    }
  }
  return { call: toCallDto(updated ?? call) };
}

export async function fail(actor: Actor, callId: string, reason: string) {
  const { call } = await requireParticipant(actor.userId, callId);
  if (!ACTIVE.includes(call.status)) return { call: toCallDto(call) };
  logger.warn({ callId, reason }, 'call: client reported failure');
  const done = await finalize(callId, 'FAILED', reason, actor.userId);
  return { call: toCallDto(done ?? (await loadCall(callId))!) };
}

/**
 * After a signaling reconnect, the same device re-binds its new connection so
 * offers/answers/candidates (e.g. for an ICE restart) reach it again.
 */
export async function resume(actor: Actor, callId: string) {
  const { call, me, peer } = await requireParticipant(actor.userId, callId);
  requireState(call, ACTIVE);
  if (me.device_id && me.device_id !== actor.deviceId) {
    throw new AppError(409, 'call_on_other_device', 'This call is active on another device');
  }
  if (me.device_id) {
    await query(
      `UPDATE call_participants SET conn_id = $3, disconnected_at = NULL WHERE call_id = $1 AND user_id = $2`,
      [callId, actor.userId, actor.connId ?? null],
    );
    if (peer.conn_id) await sendToConnections([peer.conn_id], 'call.peer_resumed', { call_id: callId, user_id: actor.userId });
  }
  return { call: toCallDto(call), role: me.role, ...iceServersFor(actor.userId) };
}

/** Bound signaling connection dropped (network loss, refresh, server restart). */
export async function connectionLost(connId: string) {
  const rows = await query<{ call_id: string; user_id: string }>(
    `UPDATE call_participants p SET disconnected_at = now()
     FROM calls c WHERE c.id = p.call_id AND p.conn_id = $1 AND p.left_at IS NULL AND c.status = ANY($2::text[])
     RETURNING p.call_id, p.user_id`,
    [connId, ACTIVE],
  );
  for (const r of rows) {
    const peer = await queryOne<{ conn_id: string | null }>(
      'SELECT conn_id FROM call_participants WHERE call_id = $1 AND user_id <> $2',
      [r.call_id, r.user_id],
    );
    if (peer?.conn_id) await sendToConnections([peer.conn_id], 'call.peer_disconnected', { call_id: r.call_id, user_id: r.user_id });
  }
}

/** The caller's/callee's view of an active call they're part of (for UIs restoring after reload). */
export async function activeCallFor(userId: string) {
  const row = await queryOne<CallRow & { role: string }>(
    `SELECT c.*, p.role FROM calls c JOIN call_participants p ON p.call_id = c.id AND p.user_id = $1
     WHERE c.status = ANY($2::text[]) ORDER BY c.created_at DESC LIMIT 1`,
    [userId, ACTIVE],
  );
  return row ? { call: toCallDto(row), role: row.role } : null;
}

export async function getCall(userId: string, callId: string) {
  const { call } = await requireParticipant(userId, callId);
  return toCallDto(call);
}

export async function history(userId: string, opts: { before?: string | undefined; limit: number }) {
  const params: unknown[] = [userId, opts.limit + 1];
  let cond = '';
  if (opts.before) {
    const [ts, id] = Buffer.from(opts.before, 'base64url').toString().split('|');
    if (!ts || !id || Number.isNaN(Date.parse(ts))) throw badRequest('Invalid cursor');
    params.push(ts, id);
    cond = 'AND (c.created_at, c.id) < ($3::timestamptz, $4::uuid)';
  }
  // Two index range scans (caller_id / receiver_id) merged by UNION.
  const rows = await query<CallRow>(
    `SELECT * FROM (
       SELECT * FROM calls c WHERE c.caller_id = $1 ${cond}
       UNION ALL
       SELECT * FROM calls c WHERE c.receiver_id = $1 ${cond}
     ) c ORDER BY c.created_at DESC, c.id DESC LIMIT $2`,
    params,
  );
  const page = rows.slice(0, opts.limit);
  const peers = await getProfiles(userId, page.map((c) => (c.caller_id === userId ? c.receiver_id! : c.caller_id)));
  const last = page.at(-1);
  return {
    calls: page.map((c) => {
      const outgoing = c.caller_id === userId;
      return {
        ...toCallDto(c),
        direction: outgoing ? 'outgoing' : 'incoming',
        peer: peers.get(outgoing ? c.receiver_id! : c.caller_id) ?? null,
      };
    }),
    next_cursor:
      rows.length > opts.limit && last ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

/**
 * Timeouts, restart-safe because deadlines live in the database:
 *  - unanswered ring -> MISSED (no_answer)
 *  - accepted but media never connected -> FAILED (setup_timeout)
 *  - a participant's signaling gone past the grace period while the call isn't
 *    established -> MISSED (caller left while ringing) / FAILED (connection_lost)
 *  - an established call where *every* participant lost signaling -> FAILED.
 *    (If only one side's socket drops, peer-to-peer media may be fine, so the
 *    call continues; the clients end it if ICE actually fails.)
 */
export async function sweep() {
  const grace = `${Math.ceil(env.CALL_RECONNECT_GRACE_MS)} milliseconds`;
  const ringing = await query<{ id: string }>(
    `SELECT id FROM calls WHERE status = 'RINGING' AND ring_deadline < now() LIMIT 200`,
  );
  for (const c of ringing) await finalize(c.id, 'MISSED', 'no_answer', null);

  const stuck = await query<{ id: string }>(
    `SELECT id FROM calls WHERE status IN ('ACCEPTED', 'CONNECTING') AND answered_at < now() - interval '${SETUP_TIMEOUT_MS} milliseconds' LIMIT 200`,
  );
  for (const c of stuck) await finalize(c.id, 'FAILED', 'setup_timeout', null);

  const lost = await query<{ id: string; status: CallStatus; role: string }>(
    `SELECT c.id, c.status, p.role FROM call_participants p JOIN calls c ON c.id = p.call_id
     WHERE p.disconnected_at < now() - interval '${grace}' AND p.left_at IS NULL
       AND c.status IN ('INITIATING', 'RINGING', 'ACCEPTED', 'CONNECTING', 'RECONNECTING')
     LIMIT 200`,
  );
  for (const c of lost) {
    if ((c.status === 'RINGING' || c.status === 'INITIATING') && c.role === 'caller') {
      await finalize(c.id, 'MISSED', 'cancelled', null);
    } else {
      await finalize(c.id, 'FAILED', 'connection_lost', null);
    }
  }

  const abandoned = await query<{ id: string }>(
    `SELECT c.id FROM calls c WHERE c.status = 'CONNECTED'
       AND NOT EXISTS (SELECT 1 FROM call_participants p WHERE p.call_id = c.id
                       AND (p.disconnected_at IS NULL OR p.disconnected_at >= now() - interval '${grace}'))
     LIMIT 200`,
  );
  for (const c of abandoned) await finalize(c.id, 'FAILED', 'connection_lost', null);
}
