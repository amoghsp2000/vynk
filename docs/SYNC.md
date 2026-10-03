# Reliability: delivery, sync and reconnection

The rule everything follows: **the database is the source of truth, and every live event is an optimisation.** If a
WebSocket event is lost (disconnect, server restart, pub/sub drop), the client recovers the same facts through sync.

## Sending a message

```
client                         server                                   recipient
──────                         ──────                                   ─────────
outbox.add(client_msg_id) ──┐
UI shows ⏱ pending          │
                            ├─► message.send (request id = client_msg_id)
                            │     BEGIN
                            │       membership + block checks
                            │       INSERT … ON CONFLICT (sender_id, client_msg_id) DO NOTHING
                            │       receipts(status='sent') for each recipient
                            │     COMMIT
                            ◄──── ack {message}                ──────► message.new (Redis pub/sub fan-out)
outbox.remove; UI shows ✓                                               app stores it
                                                               ◄─────── message.delivered
◄──── message.status delivered (✓✓)
```

* **Ack after commit.** The ack means "durably stored", never "socket written".
* **Client-generated ids.** `client_msg_id` is created once and reused for every retry (after a timeout, a reconnect or a page
  reload; the outbox lives in `localStorage`). The unique key `(sender_id, client_msg_id)` makes sends idempotent, including two
  concurrent retries racing each other (tested).
* **Request-id dedupe.** The WebSocket layer replays the stored ack for a repeated request id (see [WEBSOCKET.md](WEBSOCKET.md)).
* **Ordering.** Every message gets an immutable `seq` from a Postgres sequence. History and read markers use it, and clients insert by `seq`.
* **Permanent errors** (blocked, not a member) mark the pending message as failed in the UI with Retry/Discard. Transient ones
  (timeout, `in_progress`, rate limit) keep it queued.

## Message states

`SENT` (stored, receipt row created) → `DELIVERED` (a recipient device acknowledged it with `message.delivered`) → `READ`
(the recipient's `message.read` covered its `seq`). State only moves forward, server-side (conditional `UPDATE … WHERE status …`)
and client-side (rank compare), so events arriving out of order can't regress a tick. With read receipts disabled, the reader's
receipts stop at `DELIVERED`.

## Sync protocol

A single Postgres sequence `sync_seq` stamps every change relevant to a client: new and deleted messages
(`messages.change_seq`), receipt changes (`message_receipts.change_seq`), "delete for me" (`message_hides.change_seq`), and
per-member state such as read marker, cleared and hidden (`conversation_members.change_seq`). A `BEFORE UPDATE` trigger bumps
`change_seq` on every update, so no code path can forget.

`sync(cursor)` returns every change with `change_seq > cursor` visible to the user, at most 500 per stream, plus a new cursor
and `has_more`.

### The commit-order problem and how it's handled

Sequence values are allocated when a row is written, but transactions commit in any order. Suppose transaction T1 takes
seq 10, then T2 takes seq 11 and commits first. A sync that runs between T2's commit and T1's commit sees 11 but not 10. A
naive cursor would jump to 11 and **lose 10 forever**.

Two mechanisms close this gap:

1. **Subscribe before syncing.** A connection is registered for live fan-out *before* the client's first sync request. Fan-out
   happens after commit, so T1's row reaches the client live even though sync missed it.
2. **Hold the cursor behind recent changes.** Every synced row also stores `changed_at = clock_timestamp()`. If a returned row
   changed within the last 10 seconds (`SYNC_SAFETY_MS`), the returned cursor stops just before the oldest such row. Any
   still-open transaction allocated its seq *before* those recent rows, so the next sync looks again. Re-sending recent rows is
   harmless because clients apply every change idempotently (upsert by id, forward-only status).

When a page is full (`has_more`), the cursor advances to the page boundary so a client always makes progress.

### Client startup and reconnect

```
connect ─► authenticate ─► (already receiving live events)
  first connection since page load:
      cursor = sync.head            ← read the head before loading the snapshot
      GET /api/conversations         ← snapshot (last message, unread counts)
      message.delivered_all          ← everything up to here is on this device
  every connection:
      loop sync(cursor) until !has_more   ← catches anything missed while offline
      presence.subscribe(chat peers)
      flush outbox (same client_msg_ids)
      call.resume (if a call is active)
  mark connection online in the UI
```

Messages for an offline recipient simply wait in Postgres. Nothing is ever held only in memory or only in client state.

## Presence

Presence is computed on the server and never trusted from the client:

* Redis hash `presence:conns:{user}` holds the live connection ids and the instance holding each one. A user is online while that hash is non-empty.
* When the last connection closes, a deadline is written to the sorted set `presence:offline_due` (`PRESENCE_GRACE_MS`, default 8 s).
  Reconnecting within the grace period removes it (no online/offline flapping on a network handover or page refresh). Each
  instance's job claims due entries atomically (`ZREM`), re-checks for live connections, then sets `online_status='offline'`
  and `last_seen` in Postgres and publishes the change.
* Each instance heartbeats into `presence:instances`. If an instance dies without cleanup, other instances reap its
  connections after 30 s. On startup, users still marked online without a live connection get a grace period to come back.

## What survives what

| Failure | Behaviour |
|---|---|
| Internet drop / Wi-Fi ↔ mobile switch | Client heartbeat detects the dead socket within ~28 s (or immediately on `offline`/`online` events); backoff reconnect; sync; outbox flush. The server's ping/pong terminates the stale socket and the presence grace period hides the blip. |
| Browser refresh / app restart | In-memory state is rebuilt from REST + sync; pending sends survive in the persisted outbox and are resent with the same ids. |
| Server restart / deploy | Sockets close with 1012; clients reconnect (jitter spreads the herd), possibly to another instance. Presence and call deadlines live in Redis/Postgres, not process memory. Verified by `e2e/tests/restart.spec.ts`. |
| Duplicate delivery | Request-id ack replay, `client_msg_id` unique key, event-id dedupe on the client, idempotent apply. |
| Receiver offline | Stored; delivered by sync on reconnect; push notification if a push subscription exists. |
| Lost `message.delivered` ack | Receipt stays SENT and is re-delivered by the next sync, which triggers another ack. |
| Redis pub/sub drop | Live events lost but data intact; the next sync recovers it. |
