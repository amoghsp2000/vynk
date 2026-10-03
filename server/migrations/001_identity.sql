-- Phase 1: identity, credentials, devices, sessions, privacy, contacts, blocks.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number     text NOT NULL UNIQUE CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  about            text NOT NULL DEFAULT 'Available' CHECK (char_length(about) <= 140),
  profile_photo_id uuid NULL,              -- FK added with media_objects (migration 003)
  online_status    text NOT NULL DEFAULT 'offline' CHECK (online_status IN ('online', 'offline')),
  last_seen        timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX users_name_trgm ON users USING gin (name gin_trgm_ops);

-- Authentication data lives apart from the profile so profile queries never
-- touch password hashes, and other credential types can be added later.
CREATE TABLE user_credentials (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash       text NOT NULL,        -- argon2id encoded string
  password_updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_privacy (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen      text NOT NULL DEFAULT 'everyone' CHECK (last_seen IN ('everyone', 'contacts', 'nobody')),
  online         text NOT NULL DEFAULT 'everyone' CHECK (online IN ('everyone', 'contacts', 'nobody')),
  profile_photo  text NOT NULL DEFAULT 'everyone' CHECK (profile_photo IN ('everyone', 'contacts', 'nobody')),
  about          text NOT NULL DEFAULT 'everyone' CHECK (about IN ('everyone', 'contacts', 'nobody')),
  status         text NOT NULL DEFAULT 'contacts' CHECK (status IN ('everyone', 'contacts', 'nobody')),
  read_receipts  boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_privacy_updated_at BEFORE UPDATE ON user_privacy FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- "Contacts" = people a user has saved. Privacy level 'contacts' means
-- "people *I* have saved", so lookups go owner_id -> contact_id.
CREATE TABLE contacts (
  owner_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text NULL CHECK (char_length(display_name) <= 64),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, contact_id),
  CHECK (owner_id <> contact_id)
);
CREATE INDEX contacts_contact_id ON contacts (contact_id);

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_id ON blocks (blocked_id);

CREATE TABLE devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL DEFAULT 'Unknown device' CHECK (char_length(name) <= 100),
  platform       text NOT NULL DEFAULT 'web' CHECK (platform IN ('web', 'android', 'ios', 'desktop')),
  push_provider  text NULL CHECK (push_provider IN ('webpush', 'fcm', 'apns')),
  push_endpoint  text NULL,
  push_p256dh    text NULL,
  push_auth      text NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_id ON devices (user_id);
CREATE UNIQUE INDEX devices_push_endpoint ON devices (push_endpoint) WHERE push_endpoint IS NOT NULL;

CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ip             inet NULL,
  user_agent     text NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz NULL,
  revoked_reason text NULL
);
CREATE INDEX sessions_user_id ON sessions (user_id);
CREATE INDEX sessions_device_id ON sessions (device_id);

-- Rotating refresh tokens. Only SHA-256 hashes are stored. Presenting a token
-- that was already used means it leaked -> the whole session is revoked.
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz NULL
);
CREATE INDEX refresh_tokens_session_id ON refresh_tokens (session_id);
