# Parley

A real-time messaging platform: 1:1 chat with delivery and read receipts, presence and typing indicators,
24-hour status updates, and **1:1 internet voice calls over WebRTC**. It's a complete working system, not a UI mock:
web client, REST API, WebSocket realtime layer, WebRTC signaling, PostgreSQL, Redis, S3-compatible object storage,
STUN/TURN and Web Push.

> **Encryption:** traffic is encrypted in transit (TLS; DTLS-SRTP for call audio), but **messages are stored on the
> server unencrypted. Parley is not end-to-end encrypted.** See [docs/SECURITY.md](docs/SECURITY.md) for the path to E2EE.

**Live demo:** https://server-production-5b78.up.railway.app (Railway, demo mode: the verification code is shown on screen, and there's no TURN relay; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#railway-current-live-deployment)).

## Quick start

Requires Docker with Compose v2.

```bash
git clone <repo> parley && cd parley
./scripts/setup-env.sh        # optional: random secrets + VAPID keys into .env (enables Web Push)
docker compose up --build
```

Open **http://localhost:8080**, register with any phone number in international format (e.g. `+14155550123`) and press
**Fill** on the verification screen. In development, SMS is mocked and the code is shown to you. Open a second browser (or a
private window) as another user to chat and call.

Demo data (optional): `docker compose exec server node dist/database/seed.js` creates `+15550000001` (Alice), `…0002` (Bob)
and `…0003` (Carol), all with password `password123`, plus some chats and a status.

Calls between two windows on the same machine work out of the box. To call from another device you need HTTPS, since
browsers only allow the microphone on secure origins (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

### Ports (development)

| Service | Port |
|---|---|
| Web app (nginx → API) | 8080 |
| Vite dev server (if running the client locally) | 5173 |
| API (when run on the host with `npm run dev`) | 4000 |
| PostgreSQL / Redis | 55432 / 56379 |
| MinIO API / console | 59000 / 59001 |
| coturn (host network) | 3478, relay 49160–49200 |

## Local development (hot reload)

```bash
docker compose up -d postgres redis minio minio-init coturn   # infrastructure only
./scripts/setup-env.sh                                       # creates .env for host-run processes
(cd server && npm install && npm run dev)                    # API + WebSocket on :4000 (migrations run on start)
(cd client && npm install && npm run dev)                    # http://localhost:5173 (proxies /api and /ws)
(cd server && npm run seed)                                  # optional demo data
```

## Tests

```bash
cd server && npm test        # 132 integration tests against real Postgres + Redis + MinIO (uses the parley_test DB)
cd e2e && npm install && npx playwright install chromium
npx playwright test          # browser E2E against http://localhost:5173 (or E2E_BASE_URL=http://localhost:8080)
E2E_DOCKER_RESTART=1 E2E_BASE_URL=http://localhost:8080 npx playwright test restart   # restarts the API container mid-session
```

| Area | Covered by |
|---|---|
| Auth: registration, login, OTP (wrong code, single use, attempt limit, rate limit), refresh rotation and reuse detection, CSRF on cookie refresh, logout, unauthorized access, password change | `server/tests/auth.test.ts`, `security.test.ts` |
| Messaging: send/receive, other devices, offline recipient, sync, delivered/read, duplicate request ids, `client_msg_id` idempotency (incl. concurrent), replies, delete (me/everyone), local chat delete, search, blocking, rate limits | `messaging.test.ts` |
| Presence: online/offline with grace, multiple devices, reconnect without flapping, heartbeat-killed stale sockets, crashed-instance reaping, server restart, privacy | `presence.test.ts` |
| Typing: relay, no storage, non-members, blocks, throttling | `presence.test.ts` |
| Status: create (text, real image upload), view, viewers, read-receipt privacy, ordering, contacts/nobody/everyone privacy, blocking, expiry + purge, delete, reply | `status.test.ts` |
| Calls: ICE credentials, full offer/answer/ICE flow, buffered candidates, multi-device ringing, accept/reject/end/cancel/missed/busy/failed, authorization (non-participants, roles, other devices, spoofed fields), reconnect + resume + ICE restart, lost signaling | `calls.test.ts` |
| Media: direct-to-storage upload, magic-byte rejection, size/type/extension policy, avatar privacy | `media.test.ts` |
| Notifications: offline-only push, collapsing, no message content, incoming/missed calls, retry/backoff, dead subscriptions, concurrent dispatchers | `notifications.test.ts` |
| Security: SQL metacharacters, stored markup, IDOR, cross-user session revocation, connection floods, oversized frames, per-IP limits | `security.test.ts` |
| **Browser E2E**: register via OTP, chat, ticks, typing, presence, reply, offline outbox + reconnect, reload, **voice call with real RTP audio both ways**, decline, call history, status post/view/reply/viewers; **TURN-only call**; API server restart | `e2e/tests/*.spec.ts` |

## Technology choices

| Choice | Why |
|---|---|
| **Node.js + TypeScript (Fastify)** | One language end to end; non-blocking I/O suits thousands of mostly idle sockets; Fastify is fast with structured logging (pino) built in. |
| **`ws` on the same server, Redis pub/sub between instances** | Plain, standards-based WebSockets with an explicit request/ack protocol (no library-specific magic). API instances stay stateless and horizontally scalable. |
| **PostgreSQL** | Relational integrity (FKs everywhere), transactions for idempotent sends, sequences for ordering and sync cursors, `pg_trgm` for search, `SKIP LOCKED` for the push queue. Raw parameterised SQL keeps queries visible (no hidden N+1). |
| **Redis** | Presence registry, cross-instance fan-out, rate limits, OTP challenges, call busy locks, ack cache. Everything there is ephemeral or recoverable. |
| **MinIO (S3 API)** | Files never touch the database or the API; presigned uploads keep large bodies off the app servers. Swappable for AWS S3, R2 or GCS. |
| **WebRTC + coturn** | Peer-to-peer audio with standard DTLS-SRTP; TURN with short-lived HMAC credentials for NAT/firewall fallback. |
| **Web Push (VAPID)** | Works for the web/PWA client today; the provider interface leaves room for FCM/APNs. |
| **React + Vite + Zustand** | Small, fast SPA; Zustand stores map cleanly onto the realtime event stream. |
| **Vitest + Playwright** | Integration tests against real services; browser tests verify actual WebRTC media. |

## Project structure

```
.
├── client/                React PWA (screens, stores, realtime client, call engine, service worker, nginx config)
├── server/
│   ├── src/modules/       auth · users · media · conversations · messages · presence · status · calls · notifications
│   ├── src/websocket/     gateway, protocol, Redis bus
│   ├── src/webrtc/        ICE server / TURN credential config
│   ├── src/{config,database,lib,middleware}
│   ├── migrations/        SQL migrations (run automatically)
│   └── tests/             integration tests
├── e2e/                   Playwright browser tests
├── infrastructure/        postgres init, Caddy config
├── docs/                  API, WebSocket, sync/reliability, WebRTC, security, architecture, deployment
├── docker-compose.yml     development stack (docker compose up)
├── docker-compose.prod.yml production stack (TLS via Caddy, secrets required)
└── .env.example
```

## Documentation

* [Architecture](docs/ARCHITECTURE.md): components, data model, scaling, extensibility
* [REST API](docs/API.md)
* [WebSocket protocol](docs/WEBSOCKET.md)
* [Reliability, sync & presence](docs/SYNC.md)
* [WebRTC calling & STUN/TURN setup](docs/WEBRTC.md)
* [Security & encryption](docs/SECURITY.md)
* [Deployment & configuration](docs/DEPLOYMENT.md)

## Feature status

| Feature | Status |
|---|---|
| Phone + password auth, OTP verification, sessions, refresh rotation, logout (all devices), password change | ✅ |
| Mock OTP provider for development | ✅ |
| **Real SMS provider** | ❌ **Incomplete.** `twilio` is a stub that fails closed; production needs an implementation. |
| Profiles (photo, name, about), view others, last seen, block/unblock, contacts | ✅ |
| Privacy: last seen, online, photo, about, status (everyone/contacts/nobody), read receipts | ✅ |
| 1:1 chat: real-time send/receive, history pagination, emoji, replies, timestamps, delete (me/everyone), local chat delete, chat + message search | ✅ |
| SENT / DELIVERED / READ, typing indicators, online/offline + last seen, multiple devices | ✅ |
| Reconnect with backoff, heartbeat, sync after offline, persisted outbox, idempotent sends, server-restart recovery | ✅ |
| Status: text + image (+ video upload/playback), 24 h expiry, views/viewers, delete, reply, privacy | ✅ |
| 1:1 voice calls: ring/accept/reject/end/missed/busy/failed, mute, timer, reconnect with ICE restart, TURN fallback | ✅ |
| Speaker control | ⚠️ Limited on web: cycles audio output devices where `setSinkId` exists; disabled elsewhere. |
| Push notifications (new message, incoming call, missed call) | ✅ server pipeline + Web Push + service worker. ⚠️ Final delivery through a real browser push service was not verified in automated tests (headless Chromium denies notification permission); verify manually in a normal browser. |
| FCM / APNs (native apps) | ❌ Provider stubs only. |
| Image attachments in chat | ⚠️ Backend complete (upload, authz, `type: "image"`); the web composer only sends text. |
| Group chats, video calls, group calls | ❌ Not built; the schema and protocol are designed to allow them (see Architecture). |
| End-to-end encryption | ❌ Not implemented; design notes in SECURITY.md. |
| Mute chats | ⚠️ Backend honours `muted_until` for push; no API/UI to set it yet. |

## License

No license file is included yet; add one before distributing.
