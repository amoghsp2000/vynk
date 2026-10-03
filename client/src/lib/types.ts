export type MsgStatus = 'pending' | 'failed' | 'sent' | 'delivered' | 'read';

export interface Profile {
  id: string;
  phone_number: string;
  name: string;
  contact_name: string | null;
  about: string | null;
  profile_photo_id: string | null;
  online: boolean | null;
  last_seen: string | null;
  is_contact: boolean;
  blocked_by_me: boolean;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_msg_id: string;
  seq: number;
  type: 'text' | 'image' | 'system';
  body: string | null;
  media_id: string | null;
  reply_to: { id: string; sender_id: string; type: string; body: string | null; deleted: boolean } | null;
  status_reply_id: string | null;
  created_at: string;
  deleted: boolean;
  status: 'sent' | 'delivered' | 'read' | null;
}

/** A message that exists only locally until the server acks it. */
export interface PendingMessage {
  client_msg_id: string;
  conversation_id: string;
  body: string;
  reply_to_id?: string;
  created_at: string;
  state: 'pending' | 'failed';
  error?: string;
}

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  peer: Profile | null;
  last_message: {
    id: string;
    sender_id: string;
    type: string;
    body: string | null;
    deleted: boolean;
    created_at: string;
    seq: number;
    status: string | null;
  } | null;
  unread_count: number;
  last_read_seq: number;
  cleared_before_seq: number;
  last_activity_at: string;
  created_at: string;
}

export interface StatusItem {
  id: string;
  user_id: string;
  type: 'text' | 'image' | 'video';
  text: string | null;
  bg_color: string | null;
  font: number | null;
  media_id: string | null;
  media_mime: string | null;
  created_at: string;
  expires_at: string;
  viewed?: boolean;
  view_count?: number;
}

export interface CallDto {
  id: string;
  type: 'voice' | 'video';
  status:
    | 'INITIATING' | 'RINGING' | 'ACCEPTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING'
    | 'ENDED' | 'REJECTED' | 'MISSED' | 'FAILED';
  end_reason: string | null;
  caller_id: string;
  receiver_id: string | null;
  created_at: string;
  connected_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
}

export const statusRank = { pending: 0, failed: 0, sent: 1, delivered: 2, read: 3 } as const;
