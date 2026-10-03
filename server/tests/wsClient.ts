import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { waitFor } from './helpers.js';

export interface Envelope {
  id: string;
  type: string;
  ts: number;
  from?: string;
  payload: any;
}

/** Minimal protocol client for tests: auth handshake, request/ack, event capture. */
export class TestSocket {
  events: Envelope[] = [];
  closeCode: number | undefined;
  authOk: any;
  private acks = new Map<string, (e: Envelope) => void>();

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const e = JSON.parse(raw.toString()) as Envelope;
      if (e.type === 'ack' && this.acks.has(e.payload.ref)) {
        this.acks.get(e.payload.ref)!(e);
        this.acks.delete(e.payload.ref);
      }
      this.events.push(e);
    });
    ws.on('close', (code) => (this.closeCode = code));
  }

  static async connect(url: string, token: string, opts: { origin?: string } = {}): Promise<TestSocket> {
    const ws = new WebSocket(url, opts.origin ? { origin: opts.origin } : {});
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    const s = new TestSocket(ws);
    const id = randomUUID();
    ws.send(JSON.stringify({ id, type: 'auth', ts: Date.now(), payload: { access_token: token } }));
    s.authOk = await waitFor(() => s.events.find((e) => e.type === 'auth.ok') ?? (s.closeCode ? { failed: s.closeCode } : null));
    return s;
  }

  /** Sends a request and resolves with the ack payload. */
  async request(type: string, payload: unknown, id: string = randomUUID()): Promise<any> {
    const p = new Promise<Envelope>((res) => this.acks.set(id, res));
    this.ws.send(JSON.stringify({ id, type, ts: Date.now(), payload }));
    const ack = await Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no ack for ${type}`)), 5000)),
    ]);
    return ack.payload;
  }

  of(type: string) {
    return this.events.filter((e) => e.type === type);
  }

  waitEvent(type: string, pred: (e: Envelope) => boolean = () => true, timeoutMs = 3000) {
    return waitFor(() => this.events.find((e) => e.type === type && pred(e)), timeoutMs);
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((res) => {
      this.ws.once('close', () => res());
      this.ws.close();
      // A paused/half-open socket never completes the close handshake.
      setTimeout(() => this.ws.terminate(), 500).unref();
    });
  }
}
