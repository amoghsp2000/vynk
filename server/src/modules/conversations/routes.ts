import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, uuid, phoneNumber, cleanText } from '../../lib/validation.js';
import { enforce } from '../../lib/rateLimit.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { findByPhone } from '../users/service.js';
import * as conversations from './service.js';

export async function conversationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/conversations', async (req) => {
    const q = parse(
      z.object({
        q: cleanText(64).optional(),
        before: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
      req.query,
    );
    return conversations.listConversations(authOf(req).userId, { q: q.q || undefined, before: q.before, limit: q.limit });
  });

  app.post('/api/conversations', async (req) => {
    const a = authOf(req);
    const body = parse(
      z
        .object({ user_id: uuid.optional(), phone_number: phoneNumber.optional() })
        .refine((b) => b.user_id || b.phone_number, 'user_id or phone_number is required'),
      req.body,
    );
    let peerId = body.user_id;
    if (!peerId) {
      await enforce(`lookup:${a.userId}`, { max: 60, windowMs: 60 * 60_000 });
      peerId = (await findByPhone(a.userId, body.phone_number!)).id;
    }
    return conversations.getOrCreateDirect(a.userId, peerId);
  });

  app.get('/api/conversations/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return conversations.getConversation(authOf(req).userId, id);
  });

  app.delete('/api/conversations/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await conversations.deleteLocally(authOf(req).userId, id);
    return { ok: true };
  });
}
