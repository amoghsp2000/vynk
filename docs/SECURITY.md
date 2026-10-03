# Security

## Encryption: what is and isn't protected

**Parley is not end-to-end encrypted.** Read this before describing it to anyone.

| Data | Protection today |
|---|---|
| Messages in transit | TLS (HTTPS / WSS, terminated by Caddy in production). |
| Messages at rest | Stored **in plaintext** in PostgreSQL. Anyone with database access (operators, a database breach) can read them. Use disk/volume encryption and restricted DB access. |
| Call audio | DTLS-SRTP, negotiated directly between the two browsers. The signaling server never sees media keys, and a TURN relay only forwards encrypted packets. Note that the signaling server *could* tamper with SDP fingerprints (MITM), which true E2EE would prevent with identity verification. |
| Media files | Private bucket; access only through 5-minute presigned URLs issued after an authorization check. Not encrypted end-to-end. |
| Passwords | argon2id (19 MiB, t=2, p=1), never logged. |
| Refresh tokens / OTP codes | Only hashes are stored (SHA-256 / HMAC-SHA256). |

The UI says "encrypted in transit" and "not end-to-end encrypted yet" in Settings and on the empty chat screen.

### Path to E2EE (not implemented)

The design keeps this possible without rewriting the core:
* Message bodies are opaque strings handled only by the messages module; the server never parses them. An E2EE client would
  put a ciphertext envelope in `body` (plus a `type`, e.g. `ciphertext`).
* Every device is already a first-class row (`devices`), which is what per-device key bundles hang off.
* Delivery, receipts, sync and push don't depend on message content (push payloads already omit it).
* Use an **established protocol** (Signal Protocol: X3DH/PQXDH + Double Ratchet; or MLS for groups) via a vetted
  library such as libsignal. **Do not invent cryptography.** You'd add: a key-distribution API (identity key, signed
  prekey, one-time prekeys per device), fan-out of one ciphertext per recipient device, safety-number verification UI, and
  server-side search would go away (search becomes client-side).

## Authentication & sessions

* Phone identity verified with 6-digit OTPs: HMAC-hashed, single-use (atomic delete), 5-minute TTL, destroyed after 5 wrong
  attempts, and request rate limited per phone and per IP. The mock provider is refused in production unless
  `ALLOW_MOCK_OTP_IN_PRODUCTION=true` is explicitly set, and the code-revealing dev endpoint never exists in production.
* Login returns the same error and the same timing for an unknown number and a wrong password (a dummy hash is verified).
* Access tokens: HS256 JWTs (15 min) carrying user, session and device ids. Each request also checks a Redis revocation list,
  so logout takes effect immediately rather than when the token expires.
* Refresh tokens rotate on every use. **Reuse detection**: presenting an already-used token revokes the whole session.
* Browser refresh tokens live in an `httpOnly; SameSite=Strict; Secure` cookie scoped to `/api/auth`. Cookie-authenticated
  endpoints also require `X-Requested-With: parley`, which a cross-site request can't send without a CORS preflight that
  the server only grants to configured origins (CSRF defence in depth). Every other endpoint uses bearer tokens, so CSRF doesn't apply.
* Changing the password revokes all other sessions. Revoked sessions also lose their open WebSockets (close code 4003).

## Authorization

The server never trusts `user_id`, `conversation_id`, message ownership or call ownership from the client:
* The actor is always taken from the token or the authenticated socket.
* Conversation membership is checked on every conversation-scoped read and write. Non-members get **404**.
* Only the sender can delete a message for everyone. Only an owner can delete a status or see its viewers. Sessions can only be
  revoked by their owner (a test caught and fixed a bug here; see `tests/security.test.ts`).
* Delivery and read receipts update only rows where the caller is the recipient.
* Call signaling: participant + role + state + bound-connection checks, with server-set `from` (see [WEBRTC.md](WEBRTC.md)).
* Media: every download goes through an authorization check before a short-lived presigned URL is issued.
* Blocking is enforced server-side for messages, calls, typing, presence, profile fields and statuses.

## Input handling

* Every REST body, query, path parameter and WebSocket payload is validated with zod (strict shapes, length caps,
  UUID/E.164 formats). Display text has control characters stripped.
* **SQL injection:** all queries are parameterised. The only dynamic SQL fragments are column names taken from fixed,
  schema-validated keys and numeric config values. `LIKE` searches escape `%`, `_` and `\`.
* **XSS:** React escapes all rendered text, and there is no `dangerouslySetInnerHTML`. nginx sends a strict CSP (`script-src
  'self'`, `object-src 'none'`, `frame-ancestors 'none'`), plus `nosniff`, `Referrer-Policy: no-referrer` and a
  `Permissions-Policy` that only allows the microphone.
* JSON bodies go through Fastify's prototype-poisoning-safe parser (256 KB limit). WebSocket frames are capped at 64 KB.
* **Uploads:** per-purpose MIME allow-list and size caps, extension must match, and the storage service enforces size and
  content type through the presigned-POST policy. After upload, magic bytes are checked against the declared type and
  mismatches are deleted. Object keys contain no user-supplied text, and downloads force the detected content type. SVG
  (scriptable) is not accepted.
* Push subscription endpoints must be `https://` (no SSRF to internal hosts). TURN denies relaying to private ranges in production.

## Abuse prevention (Redis fixed-window limits)

| Scope | Limit |
|---|---|
| Any `/api/*` request per IP | 1200 / min |
| Authenticated API per user | 600 / min |
| OTP requests | 5 / 15 min per phone, 30 / 15 min per IP |
| Login attempts | 10 / 15 min per phone, 30 / 15 min per IP |
| Phone-number lookups | 60 / hour per user |
| Messages | 60 / 10 s per user |
| Typing events | 40 / 10 s per user |
| WebSocket frames | 300 / 10 s per connection |
| WebSocket connects | 60 / min per IP; 20 live connections per user per instance |
| Call starts / signaling | 10 / min, 400 frames / 10 s per user |
| Uploads / status posts | 30 / min, 30 / hour per user |

Client IPs come from `X-Forwarded-For` only when `TRUST_PROXY=true`, and nginx only trusts that header from the reverse-proxy network (`REAL_IP_FROM`).

## Logging & privacy

Structured JSON logs (pino) with a correlation id per HTTP request (`X-Request-Id`), per WebSocket connection (`connId`)
and per WebSocket request (`requestId`). Logged: authentication failures, session creation/revocation, token reuse,
WebSocket connect/disconnect, message stored (ids and counts only), message failures, call state changes and failures,
notification send/failure, database errors (statement shape only, never parameters).

**Never logged**, enforced by pino redaction paths plus code review: passwords, password hashes, access/refresh tokens,
cookies and Authorization headers, OTP codes, message bodies and status text, SDP, ICE candidates, TURN credentials, and
push subscription endpoints. Phone numbers in logs are masked.

## Secrets

No secrets are hard-coded. Development defaults in `docker-compose.yml` are labelled dev-only and only protect a local
throwaway stack. In production the server refuses to start if any secret still has a `dev-only` default, and
`docker-compose.prod.yml` requires every secret (`${VAR:?}`). `scripts/setup-env.sh` generates random secrets and VAPID keys
into `.env`, which is git-ignored.

## Known gaps

* No end-to-end encryption (see above).
* No real SMS provider (the `twilio` provider is a stub that fails closed).
* No account deletion or data export endpoint yet.
* Rate limits are fixed-window and per instance for live socket counts; a determined distributed attacker needs upstream
  protection (WAF/CDN).
* No automated malware scanning of uploaded files (magic-byte checks only).
