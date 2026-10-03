import { z } from 'zod';
import { query } from '../../database/pool.js';
import { uuid } from '../../lib/validation.js';
import { enforce, limits } from '../../lib/rateLimit.js';
import { logger } from '../../lib/logger.js';
import { onBusMessage, envelope, sendToUsers } from '../../websocket/bus.js';
import { onConnect, onDisconnect, registerHandler, sendRaw, type Connection } from '../../websocket/gateway.js';
import { canViewerSee, loadRelations, loadRelationsForViewers } from '../users/privacy.js';
import { requireMember, memberIds } from '../conversations/service.js';
import * as presence from './service.js';

// ---- presence subscriptions (local to this instance) ----
// A connection watches the users whose presence it renders (chat list, open
// chat). Changes are pushed only to watchers, filtered by the owner's privacy.
const watchersOf = new Map<string, Set<Connection>>();
const watchedBy = new WeakMap<Connection, Set<string>>();

function unwatchAll(conn: Connection) {
  for (const owner of watchedBy.get(conn) ?? []) {
    const set = watchersOf.get(owner);
    set?.delete(conn);
    if (set && !set.size) watchersOf.delete(owner);
  }
  watchedBy.delete(conn);
}

onConnect((conn) => presence.connectionOpened(conn));
onDisconnect(async (conn) => {
  unwatchAll(conn);
  await presence.connectionClosed(conn);
});

registerHandler(
  'presence.subscribe',
  z.object({ user_ids: z.array(uuid).max(500) }),
  async ({ conn }, p) => {
    unwatchAll(conn);
    const ids = [...new Set(p.user_ids)].filter((id) => id !== conn.userId);
    watchedBy.set(conn, new Set(ids));
    for (const id of ids) {
      let set = watchersOf.get(id);
      if (!set) watchersOf.set(id, (set = new Set()));
      set.add(conn);
    }
    // Snapshot so the client renders correct state immediately.
    const [rels, users] = await Promise.all([
      loadRelations(conn.userId, ids),
      query<{ id: string; online_status: string; last_seen: Date | null }>(
        'SELECT id, online_status, last_seen FROM users WHERE id = ANY($1::uuid[])',
        [ids],
      ),
    ]);
    return {
      presence: users.map((u) => {
        const rel = rels.get(u.id);
        return {
          user_id: u.id,
          online: rel && canViewerSee(rel, 'online') ? u.online_status === 'online' : null,
          last_seen: rel && canViewerSee(rel, 'last_seen') ? u.last_seen : null,
        };
      }),
    };
  },
  { dedupe: false },
);

onBusMessage((msg) => {
  if (msg.kind !== 'presence') return;
  const watchers = watchersOf.get(msg.userId);
  if (!watchers?.size) return;
  void (async () => {
    const rels = await loadRelationsForViewers(msg.userId, [...watchers].map((c) => c.userId));
    // Same event id for all of a viewer's devices.
    const env = new Map<string, ReturnType<typeof envelope>>();
    for (const c of watchers) {
      const rel = rels.get(c.userId);
      if (!rel) continue;
      const showOnline = canViewerSee(rel, 'online');
      const showLastSeen = canViewerSee(rel, 'last_seen');
      if (!showOnline && !showLastSeen) continue;
      let e = env.get(c.userId);
      if (!e) {
        e = envelope('presence', {
          user_id: msg.userId,
          online: showOnline ? msg.online : null,
          last_seen: showLastSeen ? msg.lastSeen : null,
        });
        env.set(c.userId, e);
      }
      sendRaw(c.ws, e);
    }
  })().catch((err) => logger.error({ err }, 'presence: fan-out failed'));
});

// ---- typing indicators: ephemeral, never stored ----
const typingSchema = z.object({ conversation_id: uuid });

async function relayTyping(conn: Connection, conversationId: string, typing: boolean) {
  await enforce(`typing:${conn.userId}`, limits.typingPerUser);
  await requireMember(conn.userId, conversationId);
  const others = (await memberIds(conversationId)).filter((id) => id !== conn.userId);
  const rels = await loadRelationsForViewers(conn.userId, others);
  const targets = others.filter((id) => {
    const r = rels.get(id);
    return r && !r.blockedByOwner && !r.blockedByViewer;
  });
  await sendToUsers(targets, typing ? 'user.typing' : 'user.stopped_typing', {
    conversation_id: conversationId,
    user_id: conn.userId,
  }, { from: conn.userId });
  return null;
}

registerHandler('typing.start', typingSchema, ({ conn }, p) => relayTyping(conn, p.conversation_id, true), { dedupe: false });
registerHandler('typing.stop', typingSchema, ({ conn }, p) => relayTyping(conn, p.conversation_id, false), { dedupe: false });
