import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, uuid, phoneNumber, cleanText } from '../../lib/validation.js';
import { enforce } from '../../lib/rateLimit.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import * as users from './service.js';

const visibility = z.enum(['everyone', 'contacts', 'nobody']);

export async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/users/me', async (req) => users.getMe(authOf(req).userId));

  app.patch('/api/users/me', async (req) => {
    const body = parse(
      z
        .object({
          name: cleanText(64, 1).optional(),
          about: cleanText(140).optional(),
          profile_photo_id: uuid.nullable().optional(),
        })
        .strict(),
      req.body,
    );
    return users.updateMe(authOf(req).userId, body);
  });

  app.get('/api/users/me/privacy', async (req) => (await users.getMe(authOf(req).userId)).privacy);

  app.patch('/api/users/me/privacy', async (req) => {
    const body = parse(
      z
        .object({
          last_seen: visibility.optional(),
          online: visibility.optional(),
          profile_photo: visibility.optional(),
          about: visibility.optional(),
          status: visibility.optional(),
          read_receipts: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    return users.updatePrivacy(authOf(req).userId, body);
  });

  // Phone lookup is how chats are started; throttled to stop number scraping.
  app.get('/api/users/lookup', async (req) => {
    const a = authOf(req);
    const { phone_number } = parse(z.object({ phone_number: phoneNumber }), req.query);
    await enforce(`lookup:${a.userId}`, { max: 60, windowMs: 60 * 60_000 });
    return users.findByPhone(a.userId, phone_number);
  });

  app.get('/api/users/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    return users.getProfile(authOf(req).userId, id);
  });

  // ---- contacts ----
  app.get('/api/contacts', async (req) => ({ contacts: await users.listContacts(authOf(req).userId) }));

  app.post('/api/contacts', async (req) => {
    const a = authOf(req);
    const body = parse(
      z
        .object({ user_id: uuid.optional(), phone_number: phoneNumber.optional(), display_name: cleanText(64, 1).optional() })
        .refine((b) => b.user_id || b.phone_number, 'user_id or phone_number is required'),
      req.body,
    );
    let userId = body.user_id;
    if (!userId) {
      await enforce(`lookup:${a.userId}`, { max: 60, windowMs: 60 * 60_000 });
      userId = (await users.findByPhone(a.userId, body.phone_number!)).id;
    }
    return users.addContact(a.userId, userId, body.display_name ?? null);
  });

  app.delete('/api/contacts/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await users.removeContact(authOf(req).userId, id);
    return { ok: true };
  });

  // ---- blocks ----
  app.get('/api/blocks', async (req) => ({ blocked: await users.listBlocked(authOf(req).userId) }));

  app.post('/api/blocks', async (req) => {
    const { user_id } = parse(z.object({ user_id: uuid }), req.body);
    await users.block(authOf(req).userId, user_id);
    return { ok: true };
  });

  app.delete('/api/blocks/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    await users.unblock(authOf(req).userId, id);
    return { ok: true };
  });
}
