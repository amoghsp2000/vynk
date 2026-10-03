import { z } from 'zod';

/**
 * Wire format (see docs/WEBSOCKET.md). Every frame is one JSON envelope:
 *
 *   { "id": "<uuid>", "type": "<event>", "ts": <epoch ms>, "payload": { ... } }
 *
 * Client -> server frames are requests: the server answers each with an `ack`
 * whose payload.ref is the request id. A repeated request id gets the original
 * ack replayed instead of being processed twice.
 *
 * Server -> client frames carry a server-generated id (identical across all of
 * a user's devices for the same fact) and a server-set `from`. Clients dedupe
 * on id. The server never trusts sender/user ids inside payloads.
 */
export const PROTOCOL_VERSION = 1;

export const inboundEnvelope = z.object({
  id: z.string().min(8).max(64),
  type: z.string().min(1).max(64),
  ts: z.number().optional(),
  payload: z.unknown().optional(),
});
export type InboundEnvelope = z.infer<typeof inboundEnvelope>;

export interface OutboundEnvelope<P = unknown> {
  id: string;
  type: string;
  ts: number;
  from?: string;
  payload: P;
}

export interface AckPayload {
  ref: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

/** Close codes (4000-4999 are application-defined). */
export const CloseCode = {
  AuthTimeout: 4001,
  AuthFailed: 4002,
  SessionRevoked: 4003,
  ProtocolError: 4004,
  RateLimited: 4008,
  ServerShutdown: 1012, // "service restart": clients should reconnect
} as const;
