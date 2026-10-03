import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger, type Logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { AppError } from '../lib/errors.js';
import { hit, limits } from '../lib/rateLimit.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { onBusMessage, envelope } from './bus.js';
import { CloseCode, PROTOCOL_VERSION, inboundEnvelope, type AckPayload, type OutboundEnvelope } from './protocol.js';

/** Identifies this process in the presence registry and logs. */
export const instanceId = env.INSTANCE_ID ?? randomUUID();

export interface Connection {
  id: string;
  userId: string;
  sessionId: string;
  deviceId: string;
  ws: WebSocket;
  ip: string;
  connectedAt: number;
  alive: boolean;
  log: Logger;
}

export interface HandlerContext {
  conn: Connection;
  requestId: string;
  log: Logger;
}

interface Handler {
  schema: z.ZodType;
  handle: (ctx: HandlerContext, payload: any) => Promise<unknown>;
  /** Replay the stored ack for a repeated request id instead of re-running. */
  dedupe: boolean;
}

const handlers = new Map<string, Handler>();

/** Modules register their inbound event types here (messages, typing, calls...). */
export function registerHandler<S extends z.ZodType>(
  type: string,
  schema: S,
  handle: (ctx: HandlerContext, payload: z.infer<S>) => Promise<unknown>,
  opts: { dedupe?: boolean } = {},
) {
  if (handlers.has(type)) throw new Error(`duplicate ws handler ${type}`);
  handlers.set(type, { schema, handle, dedupe: opts.dedupe ?? true });
}

type Hook = (conn: Connection) => Promise<void> | void;
const connectHooks: Hook[] = [];
const disconnectHooks: Hook[] = [];
/** Runs after authentication, before `auth.ok` is sent (e.g. presence registration). */
export const onConnect = (fn: Hook) => connectHooks.push(fn);
export const onDisconnect = (fn: Hook) => disconnectHooks.push(fn);

// ---- local connection registry ----
const connections = new Map<string, Connection>();
const byUser = new Map<string, Set<Connection>>();

export const localConnections = (userId: string) => [...(byUser.get(userId) ?? [])];
export const getLocalConnection = (connId: string) => connections.get(connId);
export const localConnectionCount = () => connections.size;

function register(conn: Connection) {
  connections.set(conn.id, conn);
  let set = byUser.get(conn.userId);
  if (!set) byUser.set(conn.userId, (set = new Set()));
  set.add(conn);
}
function unregister(conn: Connection) {
  connections.delete(conn.id);
  const set = byUser.get(conn.userId);
  set?.delete(conn);
  if (set && !set.size) byUser.delete(conn.userId);
}

const MAX_BUFFERED = 1024 * 1024;
/** Per instance; a user rarely needs more than a handful of tabs/devices. */
const MAX_CONNECTIONS_PER_USER = 20;

export function sendRaw(ws: WebSocket, env: OutboundEnvelope) {
  if (ws.readyState !== ws.OPEN) return false;
  // A client that stops reading must not make us buffer unboundedly.
  if (ws.bufferedAmount > MAX_BUFFERED) {
    ws.terminate();
    return false;
  }
  ws.send(JSON.stringify(env));
  return true;
}

function deliverLocal(env: OutboundEnvelope, users?: string[], conns?: string[], exceptConn?: string) {
  if (users) {
    for (const u of users) {
      for (const c of byUser.get(u) ?? []) if (c.id !== exceptConn) sendRaw(c.ws, env);
    }
  }
  if (conns) {
    for (const id of conns) {
      const c = connections.get(id);
      if (c) sendRaw(c.ws, env);
    }
  }
}

const ackKey = (userId: string, reqId: string) => `ws:ack:${userId}:${reqId}`;

async function dispatch(conn: Connection, raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return conn.ws.close(CloseCode.ProtocolError, 'invalid json');
  }
  const env0 = inboundEnvelope.safeParse(parsed);
  if (!env0.success) return conn.ws.close(CloseCode.ProtocolError, 'invalid envelope');
  const req = env0.data;
  const log = conn.log.child({ requestId: req.id, event: req.type });
  const ack = (p: Omit<AckPayload, 'ref'>) => sendRaw(conn.ws, envelope('ack', { ref: req.id, ...p }));

  const rl = await hit(`ws:${conn.id}`, limits.wsEventsPerConn);
  if (!rl.allowed) {
    log.warn('ws: connection rate limited');
    return ack({ ok: false, error: { code: 'rate_limited', message: 'Too many events', details: { retry_after_ms: rl.retryAfterMs } } });
  }

  const handler = handlers.get(req.type);
  if (!handler) return ack({ ok: false, error: { code: 'unknown_event', message: `Unknown event ${req.type}` } });

  const payload = handler.schema.safeParse(req.payload ?? {});
  if (!payload.success) {
    return ack({
      ok: false,
      error: {
        code: 'bad_request',
        message: 'Invalid payload',
        details: payload.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  if (handler.dedupe) {
    const key = ackKey(conn.userId, req.id);
    const claimed = await redis.set(key, 'pending', 'EX', 300, 'NX');
    if (!claimed) {
      const prior = await redis.get(key);
      log.debug('ws: duplicate request id');
      if (prior && prior !== 'pending') return ack(JSON.parse(prior));
      return ack({ ok: false, error: { code: 'in_progress', message: 'Request already being processed; retry shortly' } });
    }
  }

  let result: Omit<AckPayload, 'ref'>;
  try {
    result = { ok: true, result: (await handler.handle({ conn, requestId: req.id, log }, payload.data)) ?? null };
  } catch (err) {
    if (err instanceof AppError) {
      result = { ok: false, error: { code: err.code, message: err.message, details: err.details } };
      if (err.status >= 500) log.error({ err }, 'ws: handler failed');
    } else {
      log.error({ err }, 'ws: handler crashed');
      result = { ok: false, error: { code: 'internal', message: 'Internal error' } };
    }
  }
  if (handler.dedupe) {
    // Only successes and client errors are final; internal errors may be retried.
    if (result.ok || result.error?.code !== 'internal') {
      await redis.set(ackKey(conn.userId, req.id), JSON.stringify(result), 'EX', 300);
    } else {
      await redis.del(ackKey(conn.userId, req.id));
    }
  }
  ack(result);
}

/** Same rules as Fastify's trustProxy: X-Forwarded-For is only honoured behind trusted proxies. */
function clientIp(req: IncomingMessage) {
  const socketIp = req.socket.remoteAddress || '';
  if (env.TRUST_PROXY === false) return socketIp;
  const chain = ((req.headers['x-forwarded-for'] as string | undefined) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!chain.length) return socketIp;
  // N hops: the address the outermost trusted proxy saw; `true`: leftmost entry.
  return (env.TRUST_PROXY === true ? chain[0] : chain[chain.length - env.TRUST_PROXY]) ?? socketIp;
}

function originAllowed(req: IncomingMessage) {
  const origin = req.headers.origin;
  // Native clients send no Origin. Browsers always do; reject foreign sites
  // (cross-site WebSocket hijacking), though they'd still need a token.
  return !origin || env.CORS_ORIGINS.includes(origin);
}

export function attachGateway(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const reject = (socket: Duplex, status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws') return socket.destroy();
      if (!originAllowed(req)) {
        logger.warn({ origin: req.headers.origin }, 'ws: rejected origin');
        return reject(socket, '403 Forbidden');
      }
      // Connection floods are cut off before any per-socket state exists.
      const ip = clientIp(req);
      if (!(await hit(`wsconn:${ip}`, limits.wsConnectPerIp)).allowed) {
        logger.warn({ ip }, 'ws: connection rate limited');
        return reject(socket, '429 Too Many Requests');
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (err) {
      logger.error({ err }, 'ws: upgrade failed');
      reject(socket, '503 Service Unavailable');
    }
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const connId = randomUUID();
    const ip = clientIp(req);
    let conn: Connection | undefined;
    let closed = false;
    const log0 = logger.child({ connId });

    // The token travels in the first frame, never in the URL (URLs end up in logs).
    const authTimer = setTimeout(() => ws.close(CloseCode.AuthTimeout, 'auth timeout'), 10_000);

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return ws.close(CloseCode.ProtocolError, 'binary not supported');
      const raw = data.toString();
      if (!conn) {
        await authenticate(raw);
        return;
      }
      try {
        await dispatch(conn, raw);
      } catch (err) {
        conn.log.error({ err }, 'ws: dispatch failed');
      }
    });

    async function authenticate(raw: string) {
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return ws.close(CloseCode.ProtocolError, 'invalid json');
      }
      if (msg?.type !== 'auth' || typeof msg?.payload?.access_token !== 'string') {
        return ws.close(CloseCode.AuthFailed, 'first frame must be auth');
      }
      const claims = await verifyAccessToken(msg.payload.access_token);
      if (!claims) {
        log0.info({ ip }, 'ws: authentication failed');
        sendRaw(ws, envelope('ack', { ref: String(msg.id ?? ''), ok: false, error: { code: 'unauthorized', message: 'Invalid or expired token' } }));
        return ws.close(CloseCode.AuthFailed, 'unauthorized');
      }
      if (closed) return;
      clearTimeout(authTimer);
      if ((byUser.get(claims.userId)?.size ?? 0) >= MAX_CONNECTIONS_PER_USER) {
        log0.warn({ userId: claims.userId }, 'ws: too many connections for user');
        return ws.close(CloseCode.RateLimited, 'too many connections');
      }
      const c: Connection = {
        id: connId,
        userId: claims.userId,
        sessionId: claims.sessionId,
        deviceId: claims.deviceId,
        ws,
        ip,
        connectedAt: Date.now(),
        alive: true,
        log: log0.child({ userId: claims.userId, deviceId: claims.deviceId }),
      };
      // Registered (and therefore receiving live events) before the client
      // syncs, so nothing committed between sync and subscription is lost.
      register(c);
      conn = c;
      try {
        for (const h of connectHooks) await h(c);
      } catch (err) {
        c.log.error({ err }, 'ws: connect hook failed');
      }
      c.log.info({ ip }, 'ws: connected');
      sendRaw(ws, envelope('auth.ok', {
        ref: String(msg.id ?? ''),
        conn_id: connId,
        user_id: c.userId,
        device_id: c.deviceId,
        protocol: PROTOCOL_VERSION,
        server_time: Date.now(),
        heartbeat_interval_ms: env.HEARTBEAT_INTERVAL_MS,
      }));
    }

    ws.on('pong', () => {
      if (conn) conn.alive = true;
    });

    ws.on('close', async (code) => {
      closed = true;
      clearTimeout(authTimer);
      if (!conn) return;
      unregister(conn);
      conn.log.info({ code, durationMs: Date.now() - conn.connectedAt }, 'ws: disconnected');
      for (const h of disconnectHooks) {
        try {
          await h(conn);
        } catch (err) {
          conn.log.error({ err }, 'ws: disconnect hook failed');
        }
      }
    });

    ws.on('error', (err) => log0.warn({ err }, 'ws: socket error'));
  });

  // Heartbeat: a connection that misses a full interval of pongs is stale
  // (half-open TCP, sleeping laptop) and is terminated, which triggers the
  // normal disconnect path and presence grace period.
  const heartbeat = setInterval(() => {
    for (const c of connections.values()) {
      if (!c.alive) {
        c.log.info('ws: heartbeat timeout, terminating');
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, env.HEARTBEAT_INTERVAL_MS);

  const busReady = onBusMessage((msg) => {
    if (msg.kind === 'event') deliverLocal(msg.envelope, msg.users, msg.conns, msg.exceptConn);
    else if (msg.kind === 'close-session') {
      for (const c of connections.values()) {
        if (c.sessionId === msg.sessionId) c.ws.close(CloseCode.SessionRevoked, 'session revoked');
      }
    }
  });

  return {
    ready: busReady,
    async close() {
      clearInterval(heartbeat);
      for (const c of connections.values()) c.ws.close(CloseCode.ServerShutdown, 'server restarting');
      // Give close frames a moment to flush, then run disconnect hooks.
      await new Promise((r) => setTimeout(r, 100));
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

// App-level heartbeat for browsers, which can't observe protocol ping frames.
registerHandler('ping', z.object({}).passthrough(), async () => ({ server_time: Date.now() }), {
  dedupe: false,
});
