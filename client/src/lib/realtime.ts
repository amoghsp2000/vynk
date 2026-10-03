import { auth, refreshSession, ApiError } from './api';

/**
 * Realtime connection with the guarantees the app relies on:
 *  - never assumes the socket is permanent: exponential backoff + jitter,
 *    immediate retry on `online`/tab-visible, and an app-level heartbeat that
 *    detects silently dead connections (e.g. Wi-Fi -> mobile data switch);
 *  - every request gets an ack or times out; WebSocket.send() is never treated
 *    as delivery;
 *  - server events are deduplicated by envelope id.
 */

export interface Envelope<P = any> {
  id: string;
  type: string;
  ts: number;
  from?: string;
  payload: P;
}

export type ConnState = 'offline' | 'connecting' | 'online';

type Handler = (e: Envelope) => void;
interface Pending {
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TimeoutError extends Error {
  constructor(type: string) {
    super(`No acknowledgement for ${type}`);
  }
}

const uuid = () => crypto.randomUUID();
const HEARTBEAT_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;

class RealtimeClient {
  state: ConnState = 'offline';
  connId: string | null = null;
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private stateListeners = new Set<(s: ConnState) => void>();
  private openHooks = new Set<(firstSinceLoad: boolean) => Promise<void> | void>();
  private pending = new Map<string, Pending>();
  private waiters: (() => void)[] = [];
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private attempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private stableTimer?: ReturnType<typeof setTimeout>;
  private enabled = false;
  private openedOnce = false;
  /** Abandons the current socket immediately (a dead TCP connection may never fire onclose). */
  private forceClose: (() => void) | null = null;

  constructor() {
    window.addEventListener('online', () => this.kick());
    window.addEventListener('offline', () => this.forceClose?.());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.kick();
    });
  }

  start() {
    this.enabled = true;
    this.kick();
  }

  stop() {
    this.enabled = false;
    this.openedOnce = false;
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    this.forceClose = null;
    ws?.close(1000, 'logout');
    this.setState('offline');
  }

  on(type: string, fn: Handler) {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => void set!.delete(fn);
  }

  onState(fn: (s: ConnState) => void) {
    this.stateListeners.add(fn);
    return () => void this.stateListeners.delete(fn);
  }

  /** Runs after every successful (re)authentication, before queued requests resume. */
  onOpen(fn: (firstSinceLoad: boolean) => Promise<void> | void) {
    this.openHooks.add(fn);
    return () => void this.openHooks.delete(fn);
  }

  /**
   * Sends a request and resolves with the server's ack result. Waits for the
   * connection (up to the timeout) if currently offline.
   */
  async request<T = any>(type: string, payload: unknown = {}, opts: { id?: string; timeoutMs?: number } = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    if (this.state !== 'online') await this.waitOnline(timeoutMs);
    const id = opts.id ?? uuid();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(type));
      }, Math.max(1000, deadline - Date.now()));
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, type, ts: Date.now(), payload }));
    });
  }

  private waitOnline(timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(new TimeoutError('connection'));
      }, timeoutMs);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  /** Reconnect now if we aren't connected (network came back, tab visible, ...). */
  kick() {
    if (!this.enabled || this.state !== 'offline') return;
    clearTimeout(this.reconnectTimer);
    this.attempts = 0;
    void this.connect();
  }

  private setState(s: ConnState) {
    if (this.state === s) return;
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }

  private async connect() {
    if (!this.enabled) return;
    this.setState('connecting');
    if (!auth.token && !(await refreshSession().catch(() => false))) {
      if (!auth.token) return this.scheduleReconnect();
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    let authed = false;

    ws.onopen = () => {
      // Token goes in the first frame, never the URL.
      ws.send(JSON.stringify({ id: uuid(), type: 'auth', ts: Date.now(), payload: { access_token: auth.token } }));
    };

    ws.onmessage = async (msg) => {
      const env = JSON.parse(msg.data) as Envelope;
      if (env.type === 'auth.ok') {
        authed = true;
        this.connId = env.payload.conn_id;
        const first = !this.openedOnce;
        this.openedOnce = true;
        this.setState('online');
        this.startHeartbeat();
        // Only reset backoff once the connection proved stable.
        this.stableTimer = setTimeout(() => (this.attempts = 0), 10_000);
        for (const h of this.openHooks) {
          try {
            await h(first);
          } catch (err) {
            console.warn('realtime open hook failed', err);
          }
        }
        const ws = this.waiters.splice(0);
        ws.forEach((w) => w());
        return;
      }
      if (env.type === 'ack') {
        const p = this.pending.get(env.payload.ref);
        if (!p) return;
        this.pending.delete(env.payload.ref);
        clearTimeout(p.timer);
        if (env.payload.ok) p.resolve(env.payload.result);
        else {
          const e = env.payload.error ?? {};
          p.reject(new ApiError(0, e.code ?? 'error', e.message ?? 'Request failed', e.details));
        }
        return;
      }
      if (this.seen.has(env.id)) return; // duplicate delivery
      this.seen.add(env.id);
      this.seenOrder.push(env.id);
      if (this.seenOrder.length > 2000) this.seen.delete(this.seenOrder.shift()!);
      for (const h of this.handlers.get(env.type) ?? []) {
        try {
          h(env);
        } catch (err) {
          console.error('realtime handler failed', env.type, err);
        }
      }
    };

    const onClosed = async (code: number) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.forceClose = null;
      this.connId = null;
      clearInterval(this.heartbeatTimer);
      clearTimeout(this.stableTimer);
      this.setState('offline');
      // Requests in flight on this socket can't be acked anymore.
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new TimeoutError('connection lost'));
        this.pending.delete(id);
      }
      if (code === 4003) {
        // Session revoked (logged out elsewhere / token theft detected).
        auth.set(null);
        return;
      }
      if (code === 4002 || (!authed && code === 1006)) {
        // Token rejected: refresh before retrying.
        const ok = await refreshSession().catch(() => true);
        if (!ok) return;
      }
      this.scheduleReconnect();
    };
    ws.onclose = (ev) => void onClosed(ev.code);
    ws.onerror = () => undefined; // onclose follows
    this.forceClose = () => {
      ws.onclose = null;
      try {
        ws.close(4000, 'abandoned');
      } catch {
        /* already closing */
      }
      void onClosed(4000);
    };
  }

  private scheduleReconnect() {
    if (!this.enabled) return;
    const base = Math.min(30_000, 500 * 2 ** this.attempts);
    const delay = base / 2 + Math.random() * (base / 2); // jitter avoids thundering herds after a server restart
    this.attempts++;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.request('ping', {}, { timeoutMs: HEARTBEAT_TIMEOUT_MS }).catch(() => {
        // No pong: the socket is dead even if the browser hasn't noticed.
        this.forceClose?.();
      });
    }, HEARTBEAT_MS);
  }
}

export const realtime = new RealtimeClient();
