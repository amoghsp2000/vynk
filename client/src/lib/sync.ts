import { ApiError } from './api';
import { realtime, TimeoutError } from './realtime';
import type { Message, PendingMessage } from './types';
import { useChat } from '../store/chat';

/**
 * Keeps local state convergent with the server:
 *
 *   connect -> authenticate -> (first time) read sync head + load chats
 *           -> sync from cursor until caught up -> subscribe presence
 *           -> flush outbox -> resume calls
 *
 * Live events and sync results are both applied idempotently, so seeing a
 * change twice is harmless. Pending sends live in a persisted outbox and are
 * retried with the same client_msg_id until the server acks them.
 */

let cursor: string | null = null;
let userKey = 'anon';
const outboxKey = () => `parley.outbox.${userKey}`;

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------
function readOutbox(): PendingMessage[] {
  try {
    return JSON.parse(localStorage.getItem(outboxKey()) ?? '[]');
  } catch {
    return [];
  }
}
function writeOutbox(list: PendingMessage[]) {
  localStorage.setItem(outboxKey(), JSON.stringify(list));
  useChat.getState().setPending(list);
}

export function sendText(conversationId: string, body: string, replyToId?: string) {
  const p: PendingMessage = {
    client_msg_id: crypto.randomUUID(),
    conversation_id: conversationId,
    body,
    ...(replyToId ? { reply_to_id: replyToId } : {}),
    created_at: new Date().toISOString(),
    state: 'pending',
  };
  writeOutbox([...readOutbox(), p]);
  void flushOutbox();
}

export function retryPending(clientMsgId: string) {
  writeOutbox(readOutbox().map((p) => (p.client_msg_id === clientMsgId ? { ...p, state: 'pending', error: undefined } : p)) as PendingMessage[]);
  void flushOutbox();
}

export function discardPending(clientMsgId: string) {
  writeOutbox(readOutbox().filter((p) => p.client_msg_id !== clientMsgId));
}

let flushing = false;
export async function flushOutbox() {
  if (flushing || realtime.state !== 'online') return;
  flushing = true;
  try {
    // Sequential: preserves the order the user typed messages in.
    for (const p of readOutbox().filter((x) => x.state === 'pending')) {
      try {
        const r = await realtime.request<{ message: Message }>(
          'message.send',
          { conversation_id: p.conversation_id, client_msg_id: p.client_msg_id, type: 'text', body: p.body, reply_to_id: p.reply_to_id },
          // Request id = client_msg_id: a retry after a lost ack replays the original ack.
          { id: p.client_msg_id, timeoutMs: 15_000 },
        );
        writeOutbox(readOutbox().filter((x) => x.client_msg_id !== p.client_msg_id));
        useChat.getState().applyMessage(r.message);
      } catch (err) {
        if (err instanceof TimeoutError) break; // connection trouble: retry on reconnect
        if (err instanceof ApiError && (err.code === 'in_progress' || err.code === 'rate_limited' || err.code === 'internal')) {
          setTimeout(() => void flushOutbox(), 2000);
          break;
        }
        // Permanent rejection (blocked, not a member, invalid): surface it.
        writeOutbox(
          readOutbox().map((x) =>
            x.client_msg_id === p.client_msg_id ? { ...x, state: 'failed', error: (err as Error).message } : x,
          ),
        );
      }
    }
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------------
// Delivery / read acknowledgements (batched)
// ---------------------------------------------------------------------------
const toAck = new Set<string>();
let ackTimer: ReturnType<typeof setTimeout> | undefined;

function queueDelivered(m: Message) {
  const me = useChat.getState().me;
  if (m.sender_id === me || m.deleted) return;
  toAck.add(m.id);
  clearTimeout(ackTimer);
  ackTimer = setTimeout(async () => {
    const ids = [...toAck];
    toAck.clear();
    for (let i = 0; i < ids.length; i += 500) {
      await realtime.request('message.delivered', { message_ids: ids.slice(i, i + 500) }).catch(() => {
        // Unacked receipts stay 'sent' server-side; the next sync re-delivers them and we ack again.
      });
    }
  }, 250);
}

const readTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Marks a conversation read up to `seq` (debounced per conversation). */
export function markRead(conversationId: string, seq: number) {
  const conv = useChat.getState().conversations[conversationId];
  if (!conv || seq <= conv.last_read_seq) return;
  useChat.getState().applyMemberState({
    conversation_id: conversationId,
    last_read_seq: seq,
    cleared_before_seq: conv.cleared_before_seq,
    hidden: false,
  });
  clearTimeout(readTimers.get(conversationId));
  readTimers.set(
    conversationId,
    setTimeout(() => {
      void realtime.request('message.read', { conversation_id: conversationId, up_to_seq: seq }).catch(() => undefined);
    }, 300),
  );
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
interface SyncResult {
  messages: Message[];
  receipts: { message_id: string; status: 'sent' | 'delivered' | 'read' }[];
  hidden: { message_id: string; conversation_id: string }[];
  conversations: { conversation_id: string; last_read_seq: number; cleared_before_seq: number; hidden: boolean }[];
  cursor: string;
  has_more: boolean;
}

async function runSync() {
  const chat = useChat.getState();
  for (;;) {
    const r = await realtime.request<SyncResult>('sync', { cursor: Number(cursor ?? 0) }, { timeoutMs: 20_000 });
    for (const c of r.conversations) chat.applyMemberState(c);
    for (const m of r.messages) {
      chat.applyMessage(m);
      queueDelivered(m);
    }
    for (const h of r.hidden) chat.applyHidden(h.conversation_id, h.message_id);
    const byStatus = { delivered: [] as string[], read: [] as string[] };
    for (const rc of r.receipts) if (rc.status !== 'sent') byStatus[rc.status].push(rc.message_id);
    if (byStatus.delivered.length) chat.applyStatus(byStatus.delivered, 'delivered');
    if (byStatus.read.length) chat.applyStatus(byStatus.read, 'read');
    cursor = r.cursor;
    if (!r.has_more) break;
  }
}

export async function subscribePresence() {
  const peers = Object.values(useChat.getState().conversations)
    .map((c) => c.peer?.id)
    .filter(Boolean)
    .slice(0, 500) as string[];
  if (!peers.length) return;
  const r = await realtime.request<{ presence: { user_id: string; online: boolean | null; last_seen: string | null }[] }>(
    'presence.subscribe',
    { user_ids: peers },
  );
  for (const p of r.presence) useChat.getState().setPresence(p.user_id, { online: p.online, last_seen: p.last_seen });
}

let wired = false;
export function startSync(meId: string) {
  userKey = meId;
  cursor = null;
  useChat.getState().reset(meId);
  useChat.getState().setPending(readOutbox());
  if (wired) return;
  wired = true;

  realtime.onOpen(async () => {
    if (cursor === null) {
      // Fresh start: socket is already live (later commits arrive as events),
      // so: read head, load snapshot via REST, then sync from the head.
      const head = await realtime.request<{ cursor: string }>('sync.head');
      await useChat.getState().loadConversations();
      cursor = head.cursor;
      // Everything up to the head is now on this device.
      void realtime.request('message.delivered_all').catch(() => undefined);
    }
    await runSync();
    await subscribePresence().catch(() => undefined);
    void flushOutbox();
  });

  // New chat partners (new conversation, first message) need presence updates too.
  let peerKey = '';
  let presenceTimer: ReturnType<typeof setTimeout> | undefined;
  useChat.subscribe((st) => {
    const key = Object.values(st.conversations)
      .map((c) => c.peer?.id)
      .filter(Boolean)
      .sort()
      .join(',');
    if (key === peerKey) return;
    peerKey = key;
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => {
      if (realtime.state === 'online') void subscribePresence().catch(() => undefined);
    }, 300);
  });

  realtime.on('message.new', (e) => {
    useChat.getState().applyMessage(e.payload);
    queueDelivered(e.payload);
  });
  realtime.on('message.status', (e) => useChat.getState().applyStatus(e.payload.message_ids, e.payload.status));
  realtime.on('message.deleted', (e) => useChat.getState().applyDeleted(e.payload.conversation_id, e.payload.message_id));
  realtime.on('message.hidden', (e) => useChat.getState().applyHidden(e.payload.conversation_id, e.payload.message_id));
  realtime.on('conversation.read', (e) => {
    const conv = useChat.getState().conversations[e.payload.conversation_id];
    if (conv) {
      useChat.getState().applyMemberState({
        conversation_id: conv.id,
        last_read_seq: e.payload.last_read_seq,
        cleared_before_seq: conv.cleared_before_seq,
        hidden: false,
      });
    }
  });
  realtime.on('user.typing', (e) => useChat.getState().setTyping(e.payload.conversation_id, e.payload.user_id, true));
  realtime.on('user.stopped_typing', (e) => useChat.getState().setTyping(e.payload.conversation_id, e.payload.user_id, false));
  realtime.on('presence', (e) =>
    useChat.getState().setPresence(e.payload.user_id, { online: e.payload.online, last_seen: e.payload.last_seen }),
  );
}

// ---------------------------------------------------------------------------
// Typing (throttled): at most one start per 3s while typing, stop after 4s idle.
// ---------------------------------------------------------------------------
let typingConv: string | null = null;
let lastStart = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

export function userTyping(conversationId: string) {
  const now = Date.now();
  if (typingConv !== conversationId || now - lastStart > 3000) {
    if (typingConv && typingConv !== conversationId) stopTyping();
    typingConv = conversationId;
    lastStart = now;
    void realtime.request('typing.start', { conversation_id: conversationId }, { timeoutMs: 3000 }).catch(() => undefined);
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopTyping, 4000);
}

export function stopTyping() {
  clearTimeout(idleTimer);
  if (!typingConv) return;
  const c = typingConv;
  typingConv = null;
  lastStart = 0;
  if (realtime.state === 'online') void realtime.request('typing.stop', { conversation_id: c }, { timeoutMs: 3000 }).catch(() => undefined);
}
