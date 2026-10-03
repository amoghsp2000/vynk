-- Phase 5: ephemeral status updates (24h) and who viewed them.

CREATE TABLE status_updates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('text', 'image', 'video')),
  -- Text statuses: the text itself. Media statuses: optional caption.
  text        text NULL CHECK (char_length(text) <= 700),
  bg_color    text NULL CHECK (bg_color ~ '^#[0-9a-fA-F]{6}$'),
  font        smallint NULL CHECK (font BETWEEN 0 AND 4),
  media_id    uuid NULL REFERENCES media_objects(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  deleted_at  timestamptz NULL,
  CHECK (
    (type = 'text' AND text IS NOT NULL AND media_id IS NULL)
    OR (type IN ('image', 'video') AND (media_id IS NOT NULL OR deleted_at IS NOT NULL))
  )
);
CREATE INDEX status_updates_user_id ON status_updates (user_id, created_at DESC);
CREATE INDEX status_updates_expires_at ON status_updates (expires_at);

CREATE TABLE status_views (
  status_id  uuid NOT NULL REFERENCES status_updates(id) ON DELETE CASCADE,
  viewer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (status_id, viewer_id)
);
CREATE INDEX status_views_viewer_id ON status_views (viewer_id);

ALTER TABLE messages
  ADD CONSTRAINT messages_status_reply_fk FOREIGN KEY (status_reply_id) REFERENCES status_updates(id) ON DELETE SET NULL;
