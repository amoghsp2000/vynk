# REST API

Base path: `/api`. All bodies are JSON. In Docker and production the API is served same-origin behind the
web client's nginx (`/api/*`, `/ws`); in local development Vite proxies the same paths.

Realtime features (live messages, typing, presence, call signaling) use the WebSocket protocol in
[WEBSOCKET.md](WEBSOCKET.md). Every realtime operation that changes state also has a REST equivalent
unless noted, and both paths call the same service code.

## Conventions

| Topic | Rule |
|---|---|
| Auth | `Authorization: Bearer <access_token>` on everything except `/api/auth/register`, `/login`, `/verify-otp`, `/refresh`, `/logout` and `/api/dev/*`. |
| Identity | The acting user, session and device always come from the token. User ids in bodies identify *targets* (whom to message, block, call), never the actor. |
| Errors | `{"error": {"code": "...", "message": "...", "details"?: ...}}` with the matching HTTP status. Validation errors: `400 bad_request` with `details: [{path, message}]`. |
| Not found vs forbidden | Resources you aren't allowed to see return **404** (not 403), so ids can't be probed. |
| Rate limits | `429 rate_limited` with a `Retry-After` header. |
| Correlation | Send `X-Request-Id` (8–64 chars of `[A-Za-z0-9._-]`) or one is generated; it's echoed in the response and in every server log line for the request. |
| Pagination | Cursor-based. Lists return `next_cursor` (opaque) or `has_more`; pass it back as documented per endpoint. |
| Timestamps | ISO-8601 UTC strings. |

Common error codes: `bad_request`, `unauthorized`, `invalid_credentials`, `forbidden`, `not_found`, `conflict`,
`rate_limited`, `blocked`, `invalid_media`, `invalid_call_state`, `internal`.

---

## Auth

Phone number is the identity. Registration and (by default) login are confirmed with a one-time code.
In development the **mock OTP provider** stores the code in Redis and exposes it via `GET /api/dev/otp`;
that endpoint does not exist when `NODE_ENV=production`.

### `POST /api/auth/register`
Starts registration. The user is created only after the OTP is verified.
```json
{ "phone_number": "+14155550123", "name": "Alice", "password": "at least 8 chars" }
```
→ `200 { "challenge_id": "...", "expires_in": 300 }` · `409 conflict` if the number is registered · rate limited per phone and per IP.

### `POST /api/auth/login`
```json
{ "phone_number": "+14155550123", "password": "...", "device"?: { "device_id"?: "uuid", "name"?: "Chrome on macOS", "platform"?: "web|android|ios|desktop" }, "token_transport"?: "cookie|body" }
```
→ `200 { "otp_required": true, "challenge_id": "...", "expires_in": 300 }` (default, `LOGIN_REQUIRE_OTP=true`)
or tokens as below when OTP is disabled. Wrong password and unknown number return the **same** `401 invalid_credentials` (and the same timing).

### `POST /api/auth/verify-otp`
```json
{ "challenge_id": "...", "code": "123456", "device"?: {...}, "token_transport"?: "cookie|body" }
```
→ tokens:
```json
{ "access_token": "jwt", "expires_in": 900, "refresh_token": "(only with token_transport=body)",
  "refresh_expires_at": "...", "session_id": "uuid", "device_id": "uuid", "user": { ...me } }
```
Codes are single-use and a challenge is destroyed after 5 wrong attempts.

**Token transport.** `cookie` (default, browsers): the refresh token is set as an `httpOnly; SameSite=Strict; Path=/api/auth`
cookie (`Secure` in production) and never exposed to JavaScript. `body`: returned in JSON for native clients that keep it in secure storage.

### `POST /api/auth/refresh`
Body `{ "refresh_token": "..." }` (native) **or** the refresh cookie plus header `X-Requested-With: parley` (browsers; CSRF guard).
Rotates the refresh token. Presenting an already-used refresh token revokes the whole session (token-theft detection).
→ tokens · `401` when the session is gone · `403` when the CSRF header is missing.

### `POST /api/auth/logout`
With a bearer token, or with the refresh cookie + `X-Requested-With: parley`. Revokes the session immediately:
existing access tokens stop working and its WebSockets are closed (code 4003).

### `POST /api/auth/logout-all` 🔒
Revokes every other session of the user → `{ ok, revoked }`.

### `GET /api/auth/sessions` 🔒 · `DELETE /api/auth/sessions/:id` 🔒
Lists active sessions (`device_name`, `platform`, `last_used_at`, `current`) / revokes one of *your* sessions.

### `POST /api/auth/password` 🔒
`{ "current_password": "...", "new_password": "..." }` → `{ ok, revoked_sessions }`. Signs out all other sessions.

### `GET /api/dev/otp?phone_number=...` (development only)
→ `{ "phone_number": "...", "code": "123456" }`.

---

## Users, profiles, privacy

### `GET /api/users/me` 🔒
```json
{ "id", "phone_number", "name", "about", "profile_photo_id", "created_at", "updated_at",
  "privacy": { "last_seen", "online", "profile_photo", "about", "status": "everyone|contacts|nobody", "read_receipts": true } }
```

### `PATCH /api/users/me` 🔒
Any of `{ "name": "1–64 chars", "about": "≤140 chars", "profile_photo_id": "uuid|null" }`. Unknown fields are rejected.
`profile_photo_id` must be your own, completed `avatar` upload (see Media).

### `GET /api/users/me/privacy` 🔒 · `PATCH /api/users/me/privacy` 🔒
Fields as in `privacy` above. `contacts` means *people you saved* as contacts.
`read_receipts: false` hides your read receipts and status views from others.

### `GET /api/users/:id` 🔒
Privacy-filtered public profile. Hidden fields are `null`:
```json
{ "id", "phone_number", "name", "contact_name", "about", "profile_photo_id",
  "online": true|false|null, "last_seen": "...|null", "is_contact": false, "blocked_by_me": false }
```
Blocking in either direction hides photo, about, online, last seen and statuses.

### `GET /api/users/lookup?phone_number=...` 🔒
Find a user by phone (to start a chat). Throttled (60/hour/user) against number scraping. `404` if unknown.

### Contacts 🔒
`GET /api/contacts` · `POST /api/contacts { "user_id" | "phone_number", "display_name"? }` · `DELETE /api/contacts/:userId`

### Blocks 🔒
`GET /api/blocks` · `POST /api/blocks { "user_id" }` · `DELETE /api/blocks/:userId`

Effects: the blocker can't message or call the blocked user (`403 blocked`). Messages and calls *from* a blocked user are
accepted but never delivered or rung, and the block is not revealed to them.

---

## Media (object storage)

Files never pass through the API or the database. Flow: request an upload → upload directly to object storage
with the presigned POST → ask the API to verify.

### `POST /api/media/uploads` 🔒
```json
{ "purpose": "avatar|status|attachment", "mime_type": "image/png", "size_bytes": 12345, "filename": "me.png" }
```
→ `{ "media_id", "upload": { "url", "fields": {...} }, "expires_in": 300, "max_bytes" }`

Then `POST` a `multipart/form-data` body to `upload.url` containing every field from `upload.fields` followed by `file`.
The storage service itself enforces the signed size range and content type.

| purpose | allowed types | max |
|---|---|---|
| avatar | jpeg, png, webp | 5 MB |
| status | jpeg, png, webp, gif / mp4, webm | 10 MB / 30 MB |
| attachment | jpeg, png, webp, gif | 16 MB |

The extension must match the type.

### `POST /api/media/:id/complete` 🔒
The server reads the object's first bytes and checks the **magic bytes** against the declared type and the size against
the limit. Mismatch → object deleted, `422 invalid_media`. → `{ id, purpose, mime_type, size_bytes, state: "ready" }`

### `GET /api/media/:id/url` 🔒
→ `{ "url": "<presigned GET, 5 min>", "mime_type", "expires_in": 300 }` if you may see it: your own media; a user's *current*
avatar if their `profile_photo` privacy allows you; status media while the status is live and visible to you; attachments in a
conversation you belong to. Otherwise `404`.

---

## Conversations

### `GET /api/conversations?q=&before=&limit=30` 🔒
Your chats, newest activity first. `q` filters by peer name, saved contact name or phone. Cursor: `before=<next_cursor>`.
```json
{ "conversations": [{
    "id", "type": "direct",
    "peer": { ...public profile },
    "last_message": { "id", "sender_id", "type", "body", "deleted", "created_at", "seq", "status": "sent|delivered|read" } | null,
    "unread_count": 2, "last_read_seq": 41, "cleared_before_seq": 0, "muted_until": null,
    "last_activity_at", "created_at" }],
  "next_cursor": "..." | null }
```
Single query with lateral joins for the last message and unread count; peer profiles loaded in one batch (no N+1).

### `POST /api/conversations` 🔒
`{ "user_id" }` or `{ "phone_number" }` → the unique 1:1 conversation (created if needed, idempotent from either side).
For the peer it stays hidden until the first message.

### `GET /api/conversations/:id` 🔒 · `DELETE /api/conversations/:id` 🔒
Delete is **local**: the chat is hidden and its history cleared *for you only*. A new message makes it reappear.

### `GET /api/conversations/:id/messages?before_seq=&after_seq=&limit=50` 🔒
Cursor pagination over the immutable per-message `seq`. Returns oldest→newest within the page plus `has_more`.
Pass the smallest `seq` you have as `before_seq` to page back.

### `POST /api/conversations/:id/read` 🔒
`{ "up_to_seq": 57 }` — marks everything up to that message read (moves receipts to READ unless your read receipts are off).

---

## Messages

`MessageDto`:
```json
{ "id", "conversation_id", "sender_id", "client_msg_id", "seq": 57, "type": "text|image|system",
  "body": "…" | null, "media_id": null, "reply_to": { "id", "sender_id", "type", "body", "deleted" } | null,
  "status_reply_id": null, "created_at", "deleted": false,
  "status": "sent|delivered|read" | null,   // sender's view (min over recipients)
  "change_seq": 123 }
```

### `POST /api/messages` 🔒
```json
{ "conversation_id", "client_msg_id": "uuid generated by the client", "type": "text", "body": "hi 👋", "reply_to_id"?: "uuid" }
```
→ `201 { "message", "duplicate": false }`. **Idempotent** on `(sender, client_msg_id)`: a retry returns `200` with the
original message and `duplicate: true`. Body ≤ 4096 chars. 60 messages / 10 s / user.

### `DELETE /api/messages/:id?scope=me|everyone` 🔒
`me`: hide for yourself (synced to your other devices). `everyone`: sender only, within 48 h; body and media are wiped server-side.

### `POST /api/messages/delivered` 🔒
`{ "message_ids": [...] }` — the recipient device confirms it has the messages. This (not `WebSocket.send`) is what moves a message to DELIVERED.

### `POST /api/messages/delivered-all` 🔒
Marks every still-undelivered message addressed to you as delivered (used by a client that just loaded fresh state).

### `GET /api/messages/search?q=&conversation_id=&limit=50` 🔒
Case-insensitive substring search over **your visible** messages (trigram index). `%` and `_` are literal.

---

## Sync

See [SYNC.md](SYNC.md) for the algorithm.

### `GET /api/sync/head` 🔒 → `{ "cursor": "123" }`
### `GET /api/sync?cursor=N` 🔒
```json
{ "messages": [MessageDto],                         // new / edited / deleted, visible to you
  "receipts": [{ "message_id", "conversation_id", "user_id", "status", "delivered_at", "read_at" }], // for messages you sent
  "hidden":   [{ "message_id", "conversation_id" }], // "delete for me" from your other devices
  "conversations": [{ "conversation_id", "last_read_seq", "cleared_before_seq", "hidden" }],
  "cursor": "456", "has_more": false }
```
Repeat with the returned cursor while `has_more`.

---

## Status updates

`StatusDto`: `{ id, user_id, type: "text|image|video", text, bg_color, font, media_id, media_mime, created_at, expires_at, viewed?, view_count? }`

| Endpoint | |
|---|---|
| `POST /api/status` 🔒 | `{ "type": "text", "text", "bg_color": "#336699", "font"?: 0-4 }` or `{ "type": "image|video", "media_id", "text"?: caption }` → 201. Expires after 24 h. |
| `GET /api/status` 🔒 | `{ "mine": [StatusDto + view_count], "updates": [{ "user", "statuses", "latest_at", "all_viewed" }] }` — unseen groups first, newest first. Only people you know (contacts / chat partners) whose `status` privacy allows you. |
| `GET /api/status/:id` 🔒 | One live, visible status (else 404). |
| `POST /api/status/:id/view` 🔒 | Records a view (idempotent); notifies the owner unless your read receipts are off. |
| `GET /api/status/:id/viewers` 🔒 | Owner only: `{ viewers: [{ user, viewed_at }] }`. |
| `DELETE /api/status/:id` 🔒 | Owner only; deletes the media object too. |
| `POST /api/status/:id/reply` 🔒 | `{ "client_msg_id", "body" }` → sends a 1:1 message with `status_reply_id`. |

Expired statuses disappear immediately from every endpoint; a background job hard-deletes them (and their media) an hour later.

---

## Calls

`CallDto`: `{ id, type: "voice", status, end_reason, ended_by, caller_id, receiver_id, conversation_id, created_at, answered_at, connected_at, ended_at, duration_ms }`

Statuses: `INITIATING → RINGING → ACCEPTED → CONNECTING → CONNECTED ⇄ RECONNECTING → ENDED | REJECTED | MISSED | FAILED`.

| Endpoint | |
|---|---|
| `GET /api/calls/ice-servers` 🔒 | `{ ice_servers: [{ urls }, { urls, username, credential }], ttl }` — STUN plus short-lived TURN credentials. |
| `POST /api/calls` 🔒 | `{ "callee_id", "type"?: "voice" }` → `{ call, busy, ice_servers }`. Prefer the `call.initiate` WebSocket event, which also binds your connection for signaling. |
| `GET /api/calls?before=&limit=` 🔒 | History with `direction` and `peer`. |
| `GET /api/calls/active` 🔒 | `{ active: { call, role } | null }` (restore UI after reload / push). |
| `GET /api/calls/:id` 🔒 | Participants only. |
| `POST /api/calls/:id/end` 🔒 | Hang up / cancel / decline from REST. |

SDP and ICE exchange happen over the WebSocket — see [WEBRTC.md](WEBRTC.md).

---

## Notifications

| Endpoint | |
|---|---|
| `GET /api/notifications/config` 🔒 | `{ webpush: { enabled, public_key } }` (VAPID public key). |
| `PUT /api/devices/current/push` 🔒 | `{ "provider": "webpush", "endpoint": "https://…", "keys": { "p256dh", "auth" } }` — attaches a push subscription to the device of the current session. Non-HTTPS endpoints are rejected. |
| `DELETE /api/devices/current/push` 🔒 | Removes it. |

---

## Health

`GET /health/live` (process up) · `GET /health/ready` (Postgres + Redis reachable; 503 otherwise).
