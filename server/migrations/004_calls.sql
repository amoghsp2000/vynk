-- Phase 6/7: call records. Media never touches the server (peer-to-peer WebRTC,
-- TURN relay as fallback); these tables hold signaling state and call history.

CREATE TABLE calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text NOT NULL DEFAULT 'voice' CHECK (type IN ('voice', 'video')),
  conversation_id uuid NULL REFERENCES conversations(id) ON DELETE SET NULL,
  caller_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 1:1 convenience column; future group calls use call_participants only.
  receiver_id     uuid NULL REFERENCES users(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN (
                    'INITIATING', 'RINGING', 'ACCEPTED', 'CONNECTING', 'CONNECTED', 'RECONNECTING',
                    'ENDED', 'REJECTED', 'MISSED', 'FAILED')),
  end_reason      text NULL,  -- hangup | cancelled | no_answer | busy | rejected | connection_lost | setup_timeout | <client reason>
  ended_by        uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  ring_deadline   timestamptz NULL,
  answered_at     timestamptz NULL,
  connected_at    timestamptz NULL,
  ended_at        timestamptz NULL
);
CREATE INDEX calls_caller_id ON calls (caller_id, created_at DESC);
CREATE INDEX calls_receiver_id ON calls (receiver_id, created_at DESC);
CREATE INDEX calls_active ON calls (status, ring_deadline)
  WHERE status IN ('INITIATING', 'RINGING', 'ACCEPTED', 'CONNECTING', 'CONNECTED', 'RECONNECTING');

CREATE TABLE call_participants (
  call_id         uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('caller', 'callee')),
  -- The one device/connection that carries this participant's media + signaling.
  device_id       uuid NULL REFERENCES devices(id) ON DELETE SET NULL,
  conn_id         text NULL,
  joined_at       timestamptz NULL,
  left_at         timestamptz NULL,
  -- Set when the bound signaling connection drops; cleared on call.resume.
  disconnected_at timestamptz NULL,
  PRIMARY KEY (call_id, user_id)
);
CREATE INDEX call_participants_user_id ON call_participants (user_id);
CREATE INDEX call_participants_conn_id ON call_participants (conn_id) WHERE conn_id IS NOT NULL;
