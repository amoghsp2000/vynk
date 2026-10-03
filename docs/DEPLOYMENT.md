# Deployment

## Production with Docker Compose

Requirements: a Linux host with a public IP, Docker, DNS records for `DOMAIN`, `media.DOMAIN` and a TURN host name
(can be the same machine), and firewall rules:

| Port | Purpose |
|---|---|
| 80, 443 (tcp, udp) | Caddy (HTTPS, ACME) |
| 3478 tcp+udp, 5349 tcp | STUN/TURN (`turns:` on 5349) |
| 49152–65535 udp | TURN relay range |

1. Create `.env.prod` with real values (all required):

   ```
   DOMAIN=chat.example.com
   ACME_EMAIL=ops@example.com
   POSTGRES_PASSWORD=<random>
   REDIS_PASSWORD=<random>
   MINIO_ROOT_USER=<random>
   MINIO_ROOT_PASSWORD=<random>
   JWT_ACCESS_SECRET=<openssl rand -base64 48>
   OTP_HMAC_SECRET=<openssl rand -base64 48>
   TURN_SECRET=<openssl rand -base64 48>
   TURN_HOST=turn.example.com
   TURN_EXTERNAL_IP=203.0.113.10
   TURN_TLS_CERT=/etc/letsencrypt/live/turn.example.com/fullchain.pem
   TURN_TLS_KEY=/etc/letsencrypt/live/turn.example.com/privkey.pem
   VAPID_PUBLIC_KEY=...      # cd server && npm run vapid
   VAPID_PRIVATE_KEY=...
   VAPID_SUBJECT=mailto:ops@example.com
   ```

2. **SMS.** No real SMS provider is implemented yet (INCOMPLETE). Production refuses the mock provider. For a closed staging
   demo you may set `OTP_PROVIDER=mock` and `ALLOW_MOCK_OTP_IN_PRODUCTION=true`. Codes are then only visible in Redis
   (`otp:mock:last:<phone>`), not over HTTP. For real use, implement `OtpProvider.send()` in `server/src/modules/auth/otp.ts`.

3. Start:
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
   ```

Migrations run automatically on server start, under a Postgres advisory lock (safe with replicas).

## Operations

| Task | How |
|---|---|
| Logs | `docker compose -f docker-compose.prod.yml logs -f server` (JSON; ship to Loki/ELK). Filter by `reqId`, `requestId`, `connId`, `userId`, `callId`. |
| Health | `/health/live`, `/health/ready` (Postgres + Redis). |
| Scale API | `deploy.replicas` on `server`. Instances coordinate through Redis; no sticky sessions needed. |
| Backups | `pg_dump` the `pgdata` volume's database, and back up the MinIO bucket (`mc mirror`). Redis holds only recoverable/ephemeral state. |
| Rotate `JWT_ACCESS_SECRET` | Restart with the new value; access tokens fail and clients refresh transparently (refresh tokens are unaffected). |
| Rotate `TURN_SECRET` | Update both coturn and the API together; active calls keep working, new credentials use the new secret. |
| Disable background jobs on an instance | `JOBS_ENABLED=false` (presence and call timeouts always run). |

## Configuration reference

All server settings are environment variables validated at startup (`server/src/config/env.ts`). See `.env.example` for the
full list with comments. Notable ones:

| Variable | Default | |
|---|---|---|
| `LOGIN_REQUIRE_OTP` | `true` | Ask for an OTP on every login (not just registration). |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_DAYS` | 900 / 30 | |
| `PRESENCE_GRACE_MS` | 8000 | Delay before a disconnected user is shown offline. |
| `HEARTBEAT_INTERVAL_MS` | 25000 | Server ping interval; also tells the client. |
| `CALL_RING_TIMEOUT_MS` / `CALL_RECONNECT_GRACE_MS` | 45000 / 30000 | |
| `TRUST_PROXY` | `false` | Honour `X-Forwarded-For` (only behind a trusted proxy). |
| `CORS_ORIGINS` | – | Allowed browser origins for CORS and WebSocket `Origin`. |
| `LOG_FORMAT` | pretty in dev, json otherwise | |
