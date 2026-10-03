-- Phase 2/3: media metadata, conversations, messages, receipts.

-- Metadata only. File bytes live in object storage under object_key.
CREATE TABLE media_objects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       text NOT NULL CHECK (purpose IN ('avatar', 'status', 'attachment')),
  object_key    text NOT NULL UNIQUE,
  declared_mime text NOT NULL,
  detected_mime text NULL,             -- from magic-byte sniffing after upload
  size_bytes    bigint NULL,
  original_name text NULL CHECK (char_length(original_name) <= 255),
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'rejected', 'deleted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz NULL
);
CREATE INDEX media_objects_owner_id ON media_objects (owner_id);
CREATE INDEX media_objects_pending ON media_objects (created_at) WHERE state = 'pending';

ALTER TABLE users
  ADD CONSTRAINT users_profile_photo_fk FOREIGN KEY (profile_photo_id) REFERENCES media_objects(id) ON DELETE SET NULL;

-- One global sequence orders every syncable change (messages, receipts,
-- per-user hides, per-member state). Clients sync with "give me changes after
-- cursor N". changed_at uses clock_timestamp() so the sync endpoint can hold
-- the cursor back behind recently allocated values whose transactions may not
-- have committed yet (see docs/SYNC.md).
CREATE SEQUENCE sync_seq;
-- Immutable ordering of messages, used for history pagination and read markers.
CREATE SEQUENCE message_order_seq;

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN ('direct', 'group')),
  -- For direct chats: "<smaller uuid>:<larger uuid>" guarantees one chat per pair.
  direct_key       text NULL UNIQUE,
  title            text NULL CHECK (char_length(title) <= 100),   -- groups (future)
  created_by       uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_message_at  timestamptz NULL,
  CHECK ((type = 'direct') = (direct_key IS NOT NULL))
);

CREATE TABLE conversation_members (
  conversation_id    uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at          timestamptz NOT NULL DEFAULT now(),
  -- "Delete chat" is local: hide the chat and every message up to this point.
  cleared_before_seq bigint NOT NULL DEFAULT 0,
  hidden             boolean NOT NULL DEFAULT false,
  last_read_seq      bigint NOT NULL DEFAULT 0,       -- message_order_seq read up to
  muted_until        timestamptz NULL,
  change_seq         bigint NOT NULL DEFAULT nextval('sync_seq'),
  changed_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_id ON conversation_members (user_id);
CREATE INDEX conversation_members_change_seq ON conversation_members (user_id, change_seq);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Client-generated id: retries of the same send are recognised and deduplicated.
  client_msg_id    uuid NOT NULL,
  order_seq        bigint NOT NULL UNIQUE DEFAULT nextval('message_order_seq'),
  type             text NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'image', 'system')),
  body             text NULL CHECK (char_length(body) <= 4096),
  media_id         uuid NULL REFERENCES media_objects(id) ON DELETE SET NULL,
  reply_to_id      uuid NULL REFERENCES messages(id) ON DELETE SET NULL,
  status_reply_id  uuid NULL,        -- FK added with status_updates (migration 003)
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz NULL, -- "delete for everyone": body/media wiped
  change_seq       bigint NOT NULL DEFAULT nextval('sync_seq'),
  changed_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (sender_id, client_msg_id)
);
CREATE INDEX messages_conversation_order ON messages (conversation_id, order_seq DESC);
CREATE INDEX messages_conversation_created ON messages (conversation_id, created_at);
CREATE INDEX messages_created_at ON messages (created_at);
CREATE INDEX messages_change_seq ON messages (conversation_id, change_seq);
CREATE INDEX messages_body_trgm ON messages USING gin (body gin_trgm_ops) WHERE deleted_at IS NULL;

-- Per-recipient delivery state. The sender's view of a message is the minimum
-- over all recipients (1:1 = the single peer).
CREATE TABLE message_receipts (
  message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Denormalised from messages so a sender can sync status changes of their
  -- own messages with a single index range scan.
  sender_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read')),
  delivered_at  timestamptz NULL,
  read_at       timestamptz NULL,
  change_seq    bigint NOT NULL DEFAULT nextval('sync_seq'),
  changed_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_receipts_user_id ON message_receipts (user_id, status);
CREATE INDEX message_receipts_sender_change ON message_receipts (sender_id, change_seq);

-- "Delete for me".
CREATE TABLE message_hides (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  change_seq bigint NOT NULL DEFAULT nextval('sync_seq'),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX message_hides_change_seq ON message_hides (user_id, change_seq);

-- Any update to a synced row moves it to the head of the change stream, so no
-- code path can forget to bump the cursor.
CREATE OR REPLACE FUNCTION bump_change_seq() RETURNS trigger AS $$
BEGIN
  NEW.change_seq = nextval('sync_seq');
  NEW.changed_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversation_members_bump BEFORE UPDATE ON conversation_members
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();
CREATE TRIGGER messages_bump BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();
CREATE TRIGGER message_receipts_bump BEFORE UPDATE ON message_receipts
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();
