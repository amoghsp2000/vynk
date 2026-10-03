import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, uuid } from '../../lib/validation.js';
import { enforce, limits } from '../../lib/rateLimit.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { iceServersFor } from '../../webrtc/iceServers.js';
import * as calls from './service.js';

export async function callRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  /**
   * Starts a call over REST. The caller's signaling connection is bound on its
   * first realtime call event (call.offer). Clients with a socket should prefer
   * the `call.initiate` event, which binds immediately.
   */
  app.post('/api/calls', async (req, reply) => {
    const a = authOf(req);
    const body = parse(z.object({ callee_id: uuid, type: z.enum(['voice', 'video']).default('voice') }), req.body);
    await enforce(`call:${a.userId}`, limits.callsPerUser);
    reply.status(201);
    return calls.initiate({ userId: a.userId, deviceId: a.deviceId }, body.callee_id, body.type);
  });

  app.get('/api/calls', async (req) => {
    const q = parse(
      z.object({ before: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }),
      req.query,
    );
    return calls.history(authOf(req).userId, q);
  });

  app.get('/api/calls/active', async (req) => ({ active: await calls.activeCallFor(authOf(req).userId) }));

  app.get('/api/calls/ice-servers', async (req) => iceServersFor(authOf(req).userId));

  app.get('/api/calls/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return calls.getCall(authOf(req).userId, id);
  });

  app.post('/api/calls/:id/end', async (req) => {
    const a = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return calls.end({ userId: a.userId, deviceId: a.deviceId }, id);
  });
}
