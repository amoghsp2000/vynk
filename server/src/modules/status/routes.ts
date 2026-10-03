import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, uuid, cleanText } from '../../lib/validation.js';
import { enforce, limits } from '../../lib/rateLimit.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import * as status from './service.js';

export async function statusRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/status', async (req, reply) => {
    const a = authOf(req);
    const body = parse(
      z.object({
        type: z.enum(['text', 'image', 'video']),
        text: cleanText(700).optional(),
        bg_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        font: z.number().int().min(0).max(4).optional(),
        media_id: uuid.optional(),
      }),
      req.body,
    );
    await enforce(`status:${a.userId}`, limits.statusPerUser);
    reply.status(201);
    return status.createStatus(a.userId, body);
  });

  app.get('/api/status', async (req) => status.feed(authOf(req).userId));

  app.get('/api/status/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return status.getStatus(authOf(req).userId, id);
  });

  app.post('/api/status/:id/view', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return status.markViewed(authOf(req).userId, id);
  });

  app.get('/api/status/:id/viewers', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return status.viewers(authOf(req).userId, id);
  });

  app.delete('/api/status/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return status.deleteStatus(authOf(req).userId, id);
  });

  app.post('/api/status/:id/reply', async (req) => {
    const a = authOf(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ client_msg_id: uuid, body: cleanText(4096, 1) }), req.body);
    await enforce(`msg:${a.userId}`, limits.messagesPerUser);
    return status.reply(a.userId, id, body);
  });
}
