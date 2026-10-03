# Architecture

```
                         ┌──────────────────────── browser / PWA ────────────────────────┐
                         │ React UI · Zustand stores · RealtimeClient · outbox · CallEngine │
                         │ service worker (Web Push)                                      │
                         └───────┬─────────────────────┬──────────────────────┬───────────┘
                        HTTPS /api│              WSS /ws│   presigned PUT/GET   │   SRTP (P2P or via TURN)
                                 ▼                     ▼                       ▼            ▲
   ┌──────── Caddy (TLS) ──► nginx (SPA, CSP, proxy) ──┐                  ┌──────────┐  ┌──┴─────┐
   │                                                   ▼                  │  MinIO / │  │ coturn │
   │        ┌──────────────── API instance (Node.js, stateless, ×N) ───┐  │    S3    │  │STUN/TURN│
   │        │ Fastify REST          WebSocket gateway                   │  └──────────┘  └────────┘
   │        │  auth users media     auth handshake · acks · dedupe      │
   │        │  conversations        heartbeat · per-conn rate limits    │
   │        │  messages status      handlers: messages, typing,         │
   │        │  calls notifications  presence, call signaling            │
   │        │ jobs: presence reaper, call sweeper, push dispatcher,     │
   │        │       status purge, upload cleanup                         │
   │        └──────┬─────────────────────────────┬──────────────────────┘
   │               │ SQL                          │ pub/sub, presence, locks, rate limits, OTP
   │               ▼                              ▼
   │        ┌────────────┐                 ┌──────────┐            Web Push services
   │        │ PostgreSQL │                 │  Redis   │            (FCM/Mozilla/Apple) ◄── dispatcher
   │        └────────────┘                 └──────────┘
```

## Components

| Component | Role |
|---|---|
| **REST API** (Fastify) | Auth, profiles, contacts, blocks, conversations, history, search, media metadata, status, call history, push registration. |
| **WebSocket gateway** (`ws`, same process/port) | Realtime transport: request/ack protocol, dedupe, heartbeat, fan-out delivery. Modules register handlers. |
| **Signaling** (`modules/calls`) | Call state machine, SDP/ICE relay to bound connections, busy locks, timeouts. `webrtc/iceServers.ts` mints TURN credentials. |
| **PostgreSQL** | System of record: users, devices, sessions, conversations, messages, receipts, statuses, calls, notifications. |
| **Redis** | Cross-instance pub/sub bus, presence registry, offline grace deadlines, rate limits, OTP challenges, session revocation list, call busy locks and buffered signaling, WebSocket ack cache. Everything in Redis is either ephemeral or recoverable. |
| **Object storage** (MinIO / any S3) | Avatars, status media, attachments. Private bucket; presigned POST uploads and GET downloads. |
| **coturn** | STUN plus TURN relay fallback for NAT/firewalled users. |
| **Push dispatcher** (`modules/notifications`) | Outbox table + `SKIP LOCKED` workers, Web Push (VAPID). FCM/APNs providers are stubs. |
| **Client** | React SPA/PWA. Server is the source of truth; local state is a cache rebuilt by REST + sync. |

## Server layout

```
server/src/
├── index.ts / server.ts / app.ts   bootstrap, graceful shutdown, Fastify setup
├── config/env.ts                   validated configuration (zod); refuses insecure prod config
├── database/                       pg pool, migration runner, seed
├── lib/                            logger, errors, validation, redis, rate limiting, jobs, domain events
├── middleware/auth.ts              bearer auth, CSRF guard
├── websocket/                      protocol, gateway, Redis bus, realtime bootstrap
├── webrtc/iceServers.ts            STUN/TURN config + ephemeral credentials
└── modules/
    ├── auth/           register/login/OTP/tokens/sessions/password
    ├── users/          profiles, privacy rules (batch-loaded), contacts, blocks
    ├── media/          upload policy, presigning, magic-byte verification, access checks
    ├── conversations/  1:1 chats, membership (the authz boundary), local delete
    ├── messages/       send, history, receipts, delete, search, sync
    ├── presence/       connection registry, online/offline, typing relay
    ├── status/         24h statuses, views, privacy, replies, expiry purge
    ├── calls/          call state machine + signaling handlers
    └── notifications/  outbox, triggers, providers, dispatcher
```

Each module owns its tables and exposes a service; `routes.ts` (REST) and `realtime.ts` (WebSocket handlers) are thin adapters
over the same service functions. Cross-module side effects go through a small typed **domain event** emitter (e.g.
`message.created` → notifications; `session.revoked` → close sockets), so modules don't import each other's internals.

## Data model

```
users ─1:1─ user_credentials        users ─1:1─ user_privacy
users ─1:N─ devices ─1:N─ sessions ─1:N─ refresh_tokens
users ─N:M─ users  via contacts (owner → contact), blocks (blocker → blocked)
conversations ─1:N─ conversation_members (read marker, cleared, hidden, muted) ─N:1─ users
conversations ─1:N─ messages ─1:N─ message_receipts (per recipient)   messages ─1:N─ message_hides
messages.reply_to_id → messages     messages.media_id → media_objects     messages.status_reply_id → status_updates
users ─1:N─ status_updates ─1:N─ status_views
users ─1:N─ media_objects (metadata only)      users.profile_photo_id → media_objects
calls ─1:N─ call_participants        notifications (outbox) ─N:1─ users
```

Indexes cover every hot path: `messages(conversation_id, order_seq)`, `messages(conversation_id, created_at)`,
`message_receipts(user_id, status)` and `(sender_id, change_seq)`, `conversation_members(user_id)`,
`status_updates(user_id, created_at)` and `(expires_at)`, `calls(caller_id)` and `(receiver_id)`, a trigram GIN index on message
bodies, and partial indexes for pending uploads, active calls and due notifications. All migrations are in `server/migrations`.

## Scaling

* API instances are stateless: any instance can serve any request or socket. Fan-out goes through Redis pub/sub, and
  presence/locks/deadlines live in Redis/Postgres. `docker-compose.prod.yml` runs 2 replicas.
* Background jobs claim work atomically (`ZREM`, `UPDATE … RETURNING`, `FOR UPDATE SKIP LOCKED`), so every instance can run them.
* Known limits and next steps: the single pub/sub channel means every instance sees every event (fine for tens of
  instances; shard by user hash beyond that). Read replicas and table partitioning for `messages` would follow.

## Extensibility

| Future feature | What's already in place |
|---|---|
| Group chats | `conversations.type = 'group'`, `title`, member `role`. Fan-out and receipts are already per-member (status = min over recipients). |
| Media messages | `messages.type`/`media_id`, `attachment` media purpose with access checks; only the client composer is missing. |
| Group / video calls | `calls.type`, `call_participants` (N rows), protocol `type: "video"`. Group calls would add an SFU (e.g. LiveKit/mediasoup) behind the same signaling auth. |
| Native mobile apps | `devices.platform`, `token_transport: body`, push provider interface (FCM/APNs stubs). |
| E2EE | See [SECURITY.md](SECURITY.md#path-to-e2ee-not-implemented). |
| Real SMS | `OtpProvider` interface; implement `send()` for Twilio, Vonage, etc. |
