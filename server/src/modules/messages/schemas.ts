import { z } from 'zod';
import { cleanText, uuid } from '../../lib/validation.js';

export const sendSchema = z.object({
  conversation_id: uuid,
  client_msg_id: uuid,
  type: z.enum(['text', 'image']).default('text'),
  // Leading/trailing whitespace kept as typed except fully blank bodies; 4096 char cap.
  body: z
    .string()
    .max(4096)
    .transform((v) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''))
    .optional(),
  media_id: uuid.optional(),
  reply_to_id: uuid.optional(),
  status_reply_id: uuid.optional(),
});

export const deliveredSchema = z.object({ message_ids: z.array(uuid).min(1).max(500) });
export const readSchema = z.object({ conversation_id: uuid, up_to_seq: z.coerce.number().int().nonnegative() });
export const deleteSchema = z.object({ message_id: uuid, scope: z.enum(['me', 'everyone']) });
export const syncSchema = z.object({ cursor: z.coerce.number().int().nonnegative().default(0) });
export const searchSchema = z.object({
  q: cleanText(100, 1),
  conversation_id: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const historySchema = z.object({
  before_seq: z.coerce.number().int().positive().optional(),
  after_seq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
