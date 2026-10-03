import { z } from 'zod';
import { uuid } from '../../lib/validation.js';
import { enforce, limits } from '../../lib/rateLimit.js';
import { onDisconnect, registerHandler, type Connection } from '../../websocket/gateway.js';
import * as calls from './service.js';

/**
 * Call signaling over the realtime connection. `from` and the acting user are
 * always taken from the authenticated connection; payloads carry only the
 * call id and SDP/ICE data, so nobody can speak for someone else.
 */
const actor = (conn: Connection): calls.Actor => ({ userId: conn.userId, deviceId: conn.deviceId, connId: conn.id });
const callId = z.object({ call_id: uuid });
// Generous but bounded: real SDPs are a few KB.
const sdp = z.string().min(10).max(20_000);

const signaling = async (conn: Connection) => enforce(`sig:${conn.userId}`, limits.signalingPerUser);

registerHandler('call.initiate', z.object({ callee_id: uuid, type: z.enum(['voice', 'video']).default('voice') }), async ({ conn }, p) => {
  await enforce(`call:${conn.userId}`, limits.callsPerUser);
  return calls.initiate(actor(conn), p.callee_id, p.type);
});

registerHandler('call.offer', callId.extend({ sdp }), async ({ conn }, p) => {
  await signaling(conn);
  return calls.offer(actor(conn), p.call_id, p.sdp);
});

registerHandler('call.answer', callId.extend({ sdp }), async ({ conn }, p) => {
  await signaling(conn);
  return calls.answer(actor(conn), p.call_id, p.sdp);
});

registerHandler(
  'call.ice_candidate',
  callId.extend({
    candidate: z.object({
      candidate: z.string().max(1000),
      sdpMid: z.string().max(64).nullish(),
      sdpMLineIndex: z.number().int().min(0).max(64).nullish(),
      usernameFragment: z.string().max(256).nullish(),
    }),
  }),
  async ({ conn }, p) => {
    await signaling(conn);
    return calls.iceCandidate(actor(conn), p.call_id, p.candidate);
  },
  // Each candidate is unique; dedupe bookkeeping would only add Redis load.
  { dedupe: false },
);

registerHandler('call.accept', callId, async ({ conn }, p) => calls.accept(actor(conn), p.call_id));
registerHandler('call.reject', callId, async ({ conn }, p) => calls.reject(actor(conn), p.call_id));
registerHandler('call.end', callId, async ({ conn }, p) => calls.end(actor(conn), p.call_id));
registerHandler('call.state', callId.extend({ state: z.enum(['connected', 'reconnecting']) }), async ({ conn }, p) =>
  calls.reportState(actor(conn), p.call_id, p.state),
);
registerHandler(
  'call.fail',
  callId.extend({ reason: z.string().regex(/^[a-z_]{1,48}$/).default('client_error') }),
  async ({ conn }, p) => calls.fail(actor(conn), p.call_id, p.reason),
);
registerHandler('call.resume', callId, async ({ conn }, p) => calls.resume(actor(conn), p.call_id));

onDisconnect((conn) => calls.connectionLost(conn.id));
