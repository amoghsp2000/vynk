import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../lib/validation.js';
import { notFound } from '../../lib/errors.js';
import { authOf, requireAuth } from '../../middleware/auth.js';
import { webPushPublicKey } from './providers.js';
import { clearDevicePush, setDevicePush } from './service.js';

export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/notifications/config', async () => {
    const key = webPushPublicKey();
    return { webpush: { enabled: Boolean(key), public_key: key } };
  });

  // The device is the one bound to the caller's session (from the token).
  app.put('/api/devices/current/push', async (req) => {
    const a = authOf(req);
    const body = parse(
      z.discriminatedUnion('provider', [
        z.object({
          provider: z.literal('webpush'),
          // Push services are always HTTPS; refuse anything else (no SSRF to internal hosts).
          endpoint: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'endpoint must be https'),
          keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
        }),
        z.object({ provider: z.enum(['fcm', 'apns']), endpoint: z.string().min(10).max(4096) }),
      ]),
      req.body,
    );
    const ok = await setDevicePush(a.userId, a.deviceId, {
      provider: body.provider,
      endpoint: body.endpoint,
      ...('keys' in body ? { p256dh: body.keys.p256dh, auth: body.keys.auth } : {}),
    });
    if (!ok) throw notFound('Device');
    return { ok: true };
  });

  app.delete('/api/devices/current/push', async (req) => {
    const a = authOf(req);
    await clearDevicePush(a.userId, a.deviceId);
    return { ok: true };
  });
}
