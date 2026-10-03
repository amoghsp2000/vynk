import { z } from 'zod';
import { enforce, limits } from '../../lib/rateLimit.js';
import { registerHandler } from '../../websocket/gateway.js';
import * as messages from './service.js';
import { deleteSchema, deliveredSchema, readSchema, sendSchema, syncSchema } from './schemas.js';

// Identity always comes from the authenticated connection, never the payload.

registerHandler('message.send', sendSchema, async ({ conn }, p) => {
  await enforce(`msg:${conn.userId}`, limits.messagesPerUser);
  // The sending connection gets the message via this ack; other devices via fan-out.
  return messages.sendMessage(conn.userId, p, { exceptConn: conn.id });
});

registerHandler('message.delivered', deliveredSchema, async ({ conn }, p) =>
  messages.markDelivered(conn.userId, p.message_ids),
);

registerHandler('message.delivered_all', z.object({}).passthrough(), async ({ conn }) => messages.markAllDelivered(conn.userId));

registerHandler('message.read', readSchema, async ({ conn }, p) =>
  messages.markRead(conn.userId, p.conversation_id, p.up_to_seq),
);

registerHandler('message.delete', deleteSchema, async ({ conn }, p) =>
  messages.deleteMessage(conn.userId, p.message_id, p.scope),
);

// Sync is a pure read; replaying a cached result for a repeated id would be stale.
registerHandler('sync.head', z.object({}).passthrough(), async () => messages.syncHead(), { dedupe: false });
registerHandler('sync', syncSchema, async ({ conn }, p) => messages.sync(conn.userId, p.cursor), { dedupe: false });
