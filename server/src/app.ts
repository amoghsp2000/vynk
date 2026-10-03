import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { env } from './config/env.js';
import { loggerOptions } from './lib/logger.js';
import { registerStaticClient } from './static.js';
import { AppError } from './lib/errors.js';
import { enforce, limits } from './lib/rateLimit.js';
import { pool } from './database/pool.js';
import { redis } from './lib/redis.js';
import { authRoutes } from './modules/auth/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { conversationRoutes } from './modules/conversations/routes.js';
import { messageRoutes } from './modules/messages/routes.js';
import { statusRoutes } from './modules/status/routes.js';
import { callRoutes } from './modules/calls/routes.js';
import { notificationRoutes } from './modules/notifications/routes.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export async function buildApp() {
  const app = Fastify({
    logger: loggerOptions,
    // A hop count trusts exactly that many proxies in front of us.
    trustProxy:
      typeof env.TRUST_PROXY === 'number'
        ? (_addr: string, hop: number) => hop < (env.TRUST_PROXY as number)
        : env.TRUST_PROXY,
    bodyLimit: 256 * 1024, // JSON only; media goes straight to object storage
    // Correlation id: honour a well-formed incoming X-Request-Id, else mint one.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    },
  });

  // Bodyless POSTs that still send `content-type: application/json` are common
  // (e.g. "mark viewed"); treat them as no body. Everything else goes through
  // Fastify's default parser, which guards against prototype poisoning.
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '') return done(null, undefined);
    defaultJson(req, body as string, done);
  });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    // Coarse per-IP ceiling for every API call (authenticated or not); finer
    // per-user/per-action limits apply inside the modules.
    if (req.url.startsWith('/api/')) await enforce(`ip:${req.ip}`, limits.apiPerIp);
  });

  await app.register(helmet, {
    // API serves JSON only; the SPA sets its own CSP via the web server.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  await app.register(cookie);

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      if (err.status === 429) {
        const retry = (err.details as { retry_after?: number } | undefined)?.retry_after;
        if (retry) reply.header('retry-after', String(retry));
      }
      if (err.status >= 500) req.log.error({ err }, 'request failed');
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const fe = err as FastifyError;
    if (fe.validation || (fe.statusCode && fe.statusCode < 500)) {
      return reply
        .status(fe.statusCode ?? 400)
        .send({ error: { code: fe.code ?? 'bad_request', message: fe.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error', request_id: req.id } });
  });

  const spa = env.STATIC_DIR ? await registerStaticClient(app, env.STATIC_DIR) : null;
  app.setNotFoundHandler(async (req, reply) => {
    if (spa && (await spa.serveIndex(req, reply))) return reply;
    return reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url} not found` } });
  });

  // Probed every few seconds by orchestrators: keep them out of the request log.
  app.get('/health/live', { logLevel: 'silent' }, async () => ({ ok: true }));
  app.get('/health/ready', { logLevel: 'silent' }, async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      await redis.ping();
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(mediaRoutes);
  await app.register(conversationRoutes);
  await app.register(messageRoutes);
  await app.register(statusRoutes);
  await app.register(callRoutes);
  await app.register(notificationRoutes);

  return app;
}
