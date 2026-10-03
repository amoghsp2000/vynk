/**
 * Message shape shared by REST, WebSocket and sync. `status` is the sender's
 * aggregate view (min over recipients) and is only meaningful for own messages.
 */
export interface MessageDto {
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
  change_seq: number;
}

/**
 * SELECT list producing every MessageDto column from alias `m`. Reply previews
 * and receipt aggregation are correlated subqueries over indexed keys.
 */
export const MESSAGE_COLUMNS = `
  m.id, m.conversation_id, m.sender_id, m.client_msg_id, m.order_seq, m.type,
  CASE WHEN m.deleted_at IS NULL THEN m.body END AS body,
  CASE WHEN m.deleted_at IS NULL THEN m.media_id END AS media_id,
  m.status_reply_id, m.created_at, m.deleted_at, m.change_seq,
  (SELECT json_build_object('id', r.id, 'sender_id', r.sender_id, 'type', r.type,
            'body', CASE WHEN r.deleted_at IS NULL THEN left(r.body, 200) END,
            'deleted', r.deleted_at IS NOT NULL)
     FROM messages r WHERE r.id = m.reply_to_id) AS reply_to,
  (SELECT CASE WHEN count(*) = 0 THEN NULL
               WHEN bool_and(mr.status = 'read') THEN 'read'
               WHEN bool_and(mr.status IN ('delivered', 'read')) THEN 'delivered'
               ELSE 'sent' END
     FROM message_receipts mr WHERE mr.message_id = m.id) AS agg_status`;

export function toMessageDto(r: any): MessageDto {
  return {
    id: r.id,
    conversation_id: r.conversation_id,
    sender_id: r.sender_id,
    client_msg_id: r.client_msg_id,
    seq: Number(r.order_seq),
    type: r.type,
    body: r.body,
    media_id: r.media_id,
    reply_to: r.reply_to ?? null,
    status_reply_id: r.status_reply_id,
    created_at: new Date(r.created_at).toISOString(),
    deleted: r.deleted_at !== null,
    status: r.agg_status ?? null,
    change_seq: Number(r.change_seq),
  };
}
