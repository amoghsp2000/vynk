import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, uuid } from '../../lib/validation.js';
import { enforce, limits } from '../../lib/rateLimit.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import * as media from './service.js';

export async function mediaRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/media/uploads', async (req) => {
    const a = authOf(req);
    const body = parse(
      z.object({
        purpose: z.enum(['avatar', 'status', 'attachment']),
        mime_type: z.string().max(100),
        size_bytes: z.number().int().positive(),
        filename: z.string().min(1).max(255),
      }),
      req.body,
    );
    await enforce(`upload:${a.userId}`, limits.uploadsPerUser);
    return media.createUpload(a.userId, body);
  });

  app.post('/api/media/:id/complete', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return media.completeUpload(authOf(req).userId, id);
  });

  app.get('/api/media/:id/url', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return media.getViewUrl(authOf(req).userId, id);
  });
}
