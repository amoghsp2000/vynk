import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { env } from './config/env.js';

/**
 * Optional: serve the built web client from the API process (STATIC_DIR).
 * Used on single-service hosts (e.g. Railway's free plan) instead of the
 * nginx container; sends the same headers nginx does.
 */

/** Origin browsers use for presigned media URLs (virtual-host style puts the bucket in the host). */
export function mediaOrigin() {
  const u = new URL(env.S3_PUBLIC_ENDPOINT);
  return env.S3_FORCE_PATH_STYLE ? u.origin : `${u.protocol}//${env.S3_BUCKET}.${u.host}`;
}

const isApiPath = (url: string) => url.startsWith('/api/') || url.startsWith('/health/') || url === '/ws';

export async function registerStaticClient(app: FastifyInstance, dir: string) {
  const media = mediaOrigin();
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // React style attributes
    `img-src 'self' data: blob: ${media}`,
    `media-src 'self' blob: ${media}`,
    `connect-src 'self' ws: wss: ${media}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  await app.register(fastifyStatic, {
    root: path.resolve(dir),
    wildcard: false, // one route per built file; unknown paths fall through to the SPA handler
    index: false,
    setHeaders(res, filePath) {
      // Hashed bundles never change; everything else (index.html, sw.js) must revalidate.
      res.header('cache-control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  // The API's helmet CSP is "default-src 'none'" (JSON only); pages get the SPA policy.
  app.addHook('onSend', async (req, reply) => {
    if (isApiPath(req.url)) return;
    reply.header('content-security-policy', csp);
    reply.header('permissions-policy', 'microphone=(self), camera=(), geolocation=()');
  });

  return {
    /** SPA fallback for client-side routes such as /chat/:id. */
    async serveIndex(req: { method: string; url: string }, reply: any) {
      if (req.method !== 'GET' || isApiPath(req.url)) return false;
      reply.header('cache-control', 'no-cache');
      await reply.sendFile('index.html');
      return true;
    },
  };
}
