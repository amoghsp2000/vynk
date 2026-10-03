-- Phase 8: push notification outbox. Rows are written when an event needs a
-- push (recipient has no live connection); a dispatcher claims them with
-- FOR UPDATE SKIP LOCKED, so any number of instances can process the queue.

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('message', 'call.incoming', 'call.missed', 'status')),
  -- Minimal payload: ids and the sender's display name. Never message text.
  payload       jsonb NOT NULL,
  -- Coalesces bursts (e.g. many messages in one chat) into one pending push.
  collapse_key  text NULL,
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed', 'skipped')),
  attempts      int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error    text NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz NULL
);
CREATE INDEX notifications_due ON notifications (next_attempt_at) WHERE state = 'pending';
CREATE INDEX notifications_user_id ON notifications (user_id, created_at DESC);
CREATE UNIQUE INDEX notifications_collapse ON notifications (user_id, collapse_key) WHERE state = 'pending' AND collapse_key IS NOT NULL;
