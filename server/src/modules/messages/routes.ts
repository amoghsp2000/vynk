import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, uuid } from '../../lib/validation.js';
import { enforce, limits } from '../../lib/rateLimit.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import * as messages from './service.js';
import { deliveredSchema, historySchema, searchSchema, sendSchema, syncSchema } from './schemas.js';

/** REST equivalents of the realtime operations, for clients without a socket. */
export async function messageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/conversations/:id/messages', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const q = parse(historySchema, req.query);
    return messages.history(authOf(req).userId, id, q);
  });

  app.post('/api/messages', async (req, reply) => {
    const a = authOf(req);
    const body = parse(sendSchema, req.body);
    await enforce(`msg:${a.userId}`, limits.messagesPerUser);
    const r = await messages.sendMessage(a.userId, body);
    reply.status(r.duplicate ? 200 : 201);
    return r;
  });

  app.delete('/api/messages/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { scope } = parse(z.object({ scope: z.enum(['me', 'everyone']).default('me') }), req.query);
    return messages.deleteMessage(authOf(req).userId, id, scope);
  });

  app.post('/api/messages/delivered', async (req) => {
    const { message_ids } = parse(deliveredSchema, req.body);
    return messages.markDelivered(authOf(req).userId, message_ids);
  });

  app.post('/api/messages/delivered-all', async (req) => messages.markAllDelivered(authOf(req).userId));

  app.post('/api/conversations/:id/read', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { up_to_seq } = parse(z.object({ up_to_seq: z.number().int().nonnegative() }), req.body);
    return messages.markRead(authOf(req).userId, id, up_to_seq);
  });

  app.get('/api/messages/search', async (req) => {
    const q = parse(searchSchema, req.query);
    return messages.search(authOf(req).userId, q.q, q.conversation_id, q.limit);
  });

  app.get('/api/sync/head', async () => messages.syncHead());

  app.get('/api/sync', async (req) => {
    const { cursor } = parse(syncSchema, req.query);
    return messages.sync(authOf(req).userId, cursor);
  });
}
