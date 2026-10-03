# Voice calling (WebRTC)

Audio never touches the application server. Browsers exchange SDP and ICE through the WebSocket signaling server, then send
media **peer-to-peer**. When NAT or a firewall prevents a direct path, media goes through **TURN** (coturn), which relays packets
it cannot decrypt (DTLS-SRTP is end-to-end between the two browsers).

## Flow

```
Caller                       Signaling (API)                        Callee (all devices)
──────                       ───────────────                        ────────────────────
getUserMedia(audio)
call.initiate ─────────────► busy-locks caller+callee (Redis SET NX)
                             calls row: INITIATING → RINGING
◄──── ack {call, ice_servers}                       call.incoming ─► ring (+ push if offline)
createOffer / setLocalDescription
call.offer ────────────────► callee not bound yet: offer stored in Redis
call.ice_candidate (×n) ───► buffered in Redis list
                                                    ◄────────────── call.accept (device D)
                             RINGING → ACCEPTED, binds D's connection
◄──── call.accepted          ack {offer, candidates, ice_servers} ─► D
                             call.answered_elsewhere ─────────────► other devices stop ringing
                                                                    setRemoteDescription(offer)
                                                                    createAnswer
◄──── call.answer ◄───────── ACCEPTED → CONNECTING ◄─────────────── call.answer
setRemoteDescription(answer)
◄═════════════════ trickle ICE both ways (call.ice_candidate) ═════════════════►
ICE connected ─► call.state connected ─► CONNECTED (connected_at set) ─► peer
                         ════════ audio: DTLS-SRTP, P2P or via TURN ════════
call.end ──────────────────► CONNECTED → ENDED, locks released ─────► call.ended (all devices)
```

### State machine (server-authoritative)

| From | To | Trigger |
|---|---|---|
| INITIATING | RINGING | callee lock acquired |
| INITIATING | MISSED (`busy`) | callee already in a call → `call.busy` |
| RINGING | ACCEPTED | `call.accept` (callee) |
| RINGING | REJECTED | `call.reject` / callee `call.end` |
| RINGING | MISSED | ring timeout (`CALL_RING_TIMEOUT_MS`, `no_answer`) or caller cancels (`cancelled`) |
| ACCEPTED | CONNECTING | callee's `call.answer` |
| ACCEPTED/CONNECTING/RECONNECTING | CONNECTED | `call.state connected` (ICE connected) |
| CONNECTED | RECONNECTING | `call.state reconnecting` (ICE disconnected) |
| any active | ENDED | `call.end` (`hangup`) |
| any active | FAILED | `call.fail` (e.g. `ice_failed`), setup timeout (60 s), lost signaling (see below) |

Every transition is a conditional `UPDATE … WHERE status = ANY(allowed)`, so racing events (both sides hanging up, an accept
arriving as the ring times out) resolve to exactly one outcome. Terminal transitions release both busy locks, delete buffered
signaling and notify every device of both users.

## Authorization

Every signaling event is checked:

1. **Participant.** The authenticated user must be a participant of `call_id`, otherwise `not_found`.
2. **Role and state.** Only the callee can accept or reject. The callee can't offer before accepting. Offers, answers and
   candidates are only accepted in states where they make sense (`invalid_call_state`).
3. **Bound connection.** Each participant's signaling is bound to one connection (the caller's is bound on `initiate`, the
   callee's on `accept`). Events from the same user's other devices are rejected (`call_on_other_device`). A reconnecting
   device must `call.resume` before signaling again (`resume_required`).
4. **Server-set identity.** `from` is always set from the connection, and `to` is always the other participant's bound
   connection. Payload `from`/`to` fields are ignored, so nobody can inject a call event as someone else.

SDP is limited to 20 KB and candidates to 1 KB, and signaling is rate-limited per user.

## Reliability

| Situation | Handling |
|---|---|
| Candidates before the callee accepts | Buffered server-side (Redis, capped at 200, 5 min TTL) and returned in the `call.accept` ack. |
| Candidates before `setRemoteDescription` | Buffered client-side and flushed right after the remote description is set. |
| Offer arrives after accept | Callee handles a later `call.offer` event. |
| ICE `disconnected` | UI shows *Reconnecting…*. After 4 s the caller triggers an **ICE restart** (`createOffer({iceRestart:true})`), and the callee answers. |
| ICE `failed` | Immediate ICE restart (caller, max 3); if not connected within 20 s → `call.fail ice_failed`. |
| Signaling (WebSocket) drop mid-call | Peer gets `call.peer_disconnected`. The audio may still be flowing P2P, so a **connected** call is *not* ended. The client reconnects, sends `call.resume` (re-binds the new connection), and the caller restarts ICE if needed. |
| Party never returns | Unless CONNECTED, a participant whose signaling has been gone longer than `CALL_RECONNECT_GRACE_MS` (30 s) ends the call (`connection_lost`, or `cancelled` for a caller who left while ringing). A CONNECTED call where **every** participant lost signaling is ended too. |
| Server restart | Deadlines are columns (`ring_deadline`, `answered_at`, `disconnected_at`), and a sweeper on every instance enforces them every second, so timeouts survive restarts. |
| Page reload while being called | `GET /api/calls/active` restores the incoming-call screen (also used when a push notification opens the app). |
| Glare (both call each other) | The busy lock makes the second `initiate` fail with `busy` or `conflict`. |
| Blocked caller | The caller sees ringing → missed; the callee is never notified (the block isn't revealed). |

## STUN / TURN configuration

The client gets ICE servers from `GET /api/calls/ice-servers` or in `call.initiate` / `call.accept` acks:

```json
[{ "urls": ["stun:turn.example.com:3478"] },
 { "urls": ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp", "turns:turn.example.com:5349?transport=tcp"],
   "username": "1760003600:<userId>", "credential": "base64(HMAC-SHA1(TURN_SECRET, username))" }]
```

This is coturn's **REST-API / `use-auth-secret`** scheme. `TURN_SECRET` is shared only between the API and coturn, and
clients receive credentials that expire after `TURN_CREDENTIAL_TTL_SECONDS` (1 h). No long-lived TURN credential is ever
shipped to clients.

| Env var | Purpose |
|---|---|
| `STUN_URLS` | Comma-separated STUN URLs |
| `TURN_URLS` | Comma-separated TURN URLs (UDP, TCP, TLS) |
| `TURN_SECRET` | Must equal coturn's `--static-auth-secret` |
| `TURN_CREDENTIAL_TTL_SECONDS` | Lifetime of issued credentials |

### Development

`docker-compose.yml` runs coturn with host networking on 3478 and relay ports 49160–49200, with `--allow-loopback-peers`
so two browsers on one machine can relay through it. The browser needs a secure context for the microphone: `http://localhost`
qualifies; another device on your LAN needs HTTPS.

### Production

`docker-compose.prod.yml` runs coturn with:
* `--external-ip` (the public IP), and the full relay range 49152–65535/udp open in the firewall, plus 3478/udp+tcp and 5349/tcp;
* TLS on 5349 (`turns:`) for networks that only allow TLS on 443/5349. Mount the certificate via `TURN_TLS_CERT` / `TURN_TLS_KEY`;
* `--denied-peer-ip` for every private range, so the relay can't be used to reach internal services (TURN SSRF);
* per-user and total quotas, and stale nonces.

### Verifying the relay path

`e2e/tests/turn.spec.ts` forces `iceTransportPolicy: "relay"` (client flag `localStorage['parley.forceRelay'] = '1'`) and asserts
that the selected candidate pair is `relay` and that audio bytes flow both ways. You can use the same flag manually in a browser
to test a deployment's TURN server.

## Client controls

| Control | Implementation |
|---|---|
| Mute | Disables the local audio track (`track.enabled = false`); no renegotiation. |
| Speaker | Browsers have no earpiece/speaker switch. The button cycles audio **output devices** via `HTMLMediaElement.setSinkId` where supported, and is disabled (with an explanation) elsewhere. A native mobile client would route audio properly. |
| Duration | Counted from local ICE-connected time; `duration_ms` in history is server-computed from `connected_at`–`ended_at`. |
| Echo / noise | `getUserMedia` with `echoCancellation`, `noiseSuppression`, `autoGainControl`. |

## Not implemented yet

* Video calls (`type: "video"` exists in the schema and protocol; the client only does audio).
* Group calls (the `call_participants` table supports N participants; signaling is 1:1 and a group call would need an SFU).
* Bandwidth adaptation beyond WebRTC's built-in congestion control.
