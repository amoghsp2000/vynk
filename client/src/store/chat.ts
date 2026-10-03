import { create } from 'zustand';
import { api } from '../lib/api';
import type { Conversation, Message, PendingMessage, Profile } from '../lib/types';
import { statusRank } from '../lib/types';

interface Thread {
  byId: Record<string, Message>;
  /** Message ids ordered by seq. */
  order: string[];
  hasMore: boolean;
  loaded: boolean;
}

interface Presence {
  online: boolean | null;
  last_seen: string | null;
}

interface ChatState {
  me: string | null;
  conversations: Record<string, Conversation>;
  threads: Record<string, Thread>;
  pending: Record<string, PendingMessage[]>;
  /** conversationId -> userId -> expiry (ms epoch) */
  typing: Record<string, Record<string, number>>;
  presence: Record<string, Presence>;
  openConversationId: string | null;

  reset(me: string | null): void;
  setOpen(id: string | null): void;
  loadConversations(): Promise<void>;
  upsertConversation(c: Conversation): void;
  ensureConversation(id: string): Promise<void>;
  removeConversation(id: string): void;
  loadHistory(conversationId: string, older?: boolean): Promise<void>;
  applyMessage(m: Message): void;
  applyStatus(ids: string[], status: 'delivered' | 'read'): void;
  applyDeleted(conversationId: string, messageId: string): void;
  applyHidden(conversationId: string, messageId: string): void;
  applyMemberState(s: { conversation_id: string; last_read_seq: number; cleared_before_seq: number; hidden: boolean }): void;
  setPending(list: PendingMessage[]): void;
  setTyping(conversationId: string, userId: string, typing: boolean): void;
  setPresence(userId: string, p: Presence): void;
  setPeer(p: Profile): void;
}

const emptyThread = (): Thread => ({ byId: {}, order: [], hasMore: true, loaded: false });

function insertOrdered(t: Thread, m: Message): Thread {
  const existing = t.byId[m.id];
  const merged: Message = existing
    ? {
        ...existing,
        ...m,
        // Status only moves forward (events can arrive out of order).
        status:
          existing.status && m.status && statusRank[existing.status] > statusRank[m.status] ? existing.status : m.status ?? existing.status,
      }
    : m;
  const byId = { ...t.byId, [m.id]: merged };
  if (existing) return { ...t, byId };
  const order = [...t.order];
  let i = order.length;
  while (i > 0 && byId[order[i - 1]!]!.seq > m.seq) i--;
  order.splice(i, 0, m.id);
  return { ...t, byId, order };
}

export const useChat = create<ChatState>((set, get) => ({
  me: null,
  conversations: {},
  threads: {},
  pending: {},
  typing: {},
  presence: {},
  openConversationId: null,

  reset(me) {
    set({ me, conversations: {}, threads: {}, pending: {}, typing: {}, presence: {}, openConversationId: null });
  },

  setOpen(id) {
    set({ openConversationId: id });
  },

  async loadConversations() {
    const all: Conversation[] = [];
    let cursor: string | null = null;
    do {
      const page: { conversations: Conversation[]; next_cursor: string | null } = await api(
        'GET',
        `/api/conversations?limit=100${cursor ? `&before=${cursor}` : ''}`,
      );
      all.push(...page.conversations);
      cursor = page.next_cursor;
    } while (cursor);
    const presence = { ...get().presence };
    for (const c of all) if (c.peer) presence[c.peer.id] ??= { online: c.peer.online, last_seen: c.peer.last_seen };
    set({ conversations: Object.fromEntries(all.map((c) => [c.id, c])), presence });
  },

  upsertConversation(c) {
    set((s) => ({
      conversations: { ...s.conversations, [c.id]: c },
      presence: c.peer && !s.presence[c.peer.id] ? { ...s.presence, [c.peer.id]: { online: c.peer.online, last_seen: c.peer.last_seen } } : s.presence,
    }));
  },

  async ensureConversation(id) {
    if (get().conversations[id]) return;
    try {
      get().upsertConversation(await api<Conversation>('GET', `/api/conversations/${id}`));
    } catch {
      /* not a member any more */
    }
  },

  removeConversation(id) {
    set((s) => {
      const { [id]: _c, ...conversations } = s.conversations;
      const { [id]: _t, ...threads } = s.threads;
      return { conversations, threads };
    });
  },

  async loadHistory(conversationId, older = false) {
    const t = get().threads[conversationId] ?? emptyThread();
    if (older && !t.hasMore) return;
    const first = t.order[0] ? t.byId[t.order[0]] : undefined;
    const q = older && first ? `?limit=40&before_seq=${first.seq}` : '?limit=40';
    const r = await api<{ messages: Message[]; has_more: boolean }>('GET', `/api/conversations/${conversationId}/messages${q}`);
    set((s) => {
      let thread = s.threads[conversationId] ?? emptyThread();
      for (const m of r.messages) thread = insertOrdered(thread, m);
      thread = { ...thread, loaded: true, hasMore: older || !t.loaded ? r.has_more : thread.hasMore };
      return { threads: { ...s.threads, [conversationId]: thread } };
    });
  },

  applyMessage(m) {
    const s = get();
    const conv = s.conversations[m.conversation_id];
    if (!conv) {
      // First message in a chat we haven't loaded: fetch it, then apply.
      void s.ensureConversation(m.conversation_id).then(() => get().conversations[m.conversation_id] && get().applyMessage(m));
      return;
    }
    if (m.seq <= conv.cleared_before_seq) return;
    set((st) => {
      const thread = insertOrdered(st.threads[m.conversation_id] ?? emptyThread(), m);
      const pending = (st.pending[m.conversation_id] ?? []).filter((p) => p.client_msg_id !== m.client_msg_id);
      const isNewer = !conv.last_message || m.seq >= conv.last_message.seq;
      const mine = m.sender_id === st.me;
      const unseen = !mine && m.seq > conv.last_read_seq && !m.deleted && !thread.byId[m.id]?.deleted;
      const wasKnown = Boolean(st.threads[m.conversation_id]?.byId[m.id]);
      const updated: Conversation = {
        ...conv,
        last_message: isNewer
          ? { id: m.id, sender_id: m.sender_id, type: m.type, body: m.body, deleted: m.deleted, created_at: m.created_at, seq: m.seq, status: thread.byId[m.id]!.status }
          : conv.last_message,
        last_activity_at: isNewer ? m.created_at : conv.last_activity_at,
        // Only messages newer than the summary the server gave us are new unread
        // (the summary's count already includes everything up to last_message).
        unread_count:
          unseen && !wasKnown && (!conv.last_message || m.seq > conv.last_message.seq) ? conv.unread_count + 1 : conv.unread_count,
      };
      // A new message from someone clears their typing indicator.
      const typing = { ...st.typing };
      if (typing[m.conversation_id]?.[m.sender_id]) {
        const { [m.sender_id]: _x, ...rest } = typing[m.conversation_id]!;
        typing[m.conversation_id] = rest;
      }
      return {
        threads: { ...st.threads, [m.conversation_id]: thread },
        pending: { ...st.pending, [m.conversation_id]: pending },
        conversations: { ...st.conversations, [conv.id]: updated },
        typing,
      };
    });
  },

  applyStatus(ids, status) {
    set((st) => {
      const threads = { ...st.threads };
      const conversations = { ...st.conversations };
      const want = new Set(ids);
      for (const [cid, t] of Object.entries(threads)) {
        let changed = false;
        const byId = { ...t.byId };
        for (const id of ids) {
          const m = byId[id];
          if (m && (!m.status || statusRank[m.status] < statusRank[status])) {
            byId[id] = { ...m, status };
            changed = true;
          }
        }
        if (changed) threads[cid] = { ...t, byId };
      }
      for (const c of Object.values(conversations)) {
        const lm = c.last_message;
        if (lm && want.has(lm.id) && (!lm.status || statusRank[lm.status as 'sent'] < statusRank[status])) {
          conversations[c.id] = { ...c, last_message: { ...lm, status } };
        }
      }
      return { threads, conversations };
    });
  },

  applyDeleted(conversationId, messageId) {
    set((st) => {
      const t = st.threads[conversationId];
      const conv = st.conversations[conversationId];
      const threads = { ...st.threads };
      if (t?.byId[messageId]) threads[conversationId] = { ...t, byId: { ...t.byId, [messageId]: { ...t.byId[messageId]!, deleted: true, body: null, media_id: null } } };
      const conversations = { ...st.conversations };
      if (conv?.last_message?.id === messageId) conversations[conversationId] = { ...conv, last_message: { ...conv.last_message, deleted: true, body: null } };
      return { threads, conversations };
    });
  },

  applyHidden(conversationId, messageId) {
    set((st) => {
      const t = st.threads[conversationId];
      if (!t?.byId[messageId]) return {};
      const { [messageId]: _m, ...byId } = t.byId;
      return { threads: { ...st.threads, [conversationId]: { ...t, byId, order: t.order.filter((id) => id !== messageId) } } };
    });
  },

  applyMemberState(ms) {
    const conv = get().conversations[ms.conversation_id];
    if (ms.hidden) return get().removeConversation(ms.conversation_id);
    if (!conv) return void get().ensureConversation(ms.conversation_id);
    set((st) => {
      const threads = { ...st.threads };
      const t = threads[ms.conversation_id];
      if (t && ms.cleared_before_seq > conv.cleared_before_seq) {
        const order = t.order.filter((id) => t.byId[id]!.seq > ms.cleared_before_seq);
        threads[ms.conversation_id] = { ...t, order, byId: Object.fromEntries(order.map((id) => [id, t.byId[id]!])) };
      }
      const caughtUp = !conv.last_message || ms.last_read_seq >= conv.last_message.seq;
      return {
        threads,
        conversations: {
          ...st.conversations,
          [conv.id]: {
            ...conv,
            last_read_seq: Math.max(conv.last_read_seq, ms.last_read_seq),
            cleared_before_seq: ms.cleared_before_seq,
            unread_count: caughtUp ? 0 : conv.unread_count,
          },
        },
      };
    });
  },

  setPending(list) {
    const pending: Record<string, PendingMessage[]> = {};
    for (const p of list) (pending[p.conversation_id] ??= []).push(p);
    set({ pending });
  },

  setTyping(conversationId, userId, typing) {
    set((st) => {
      const forConv = { ...(st.typing[conversationId] ?? {}) };
      if (typing) forConv[userId] = Date.now() + 6000;
      else delete forConv[userId];
      return { typing: { ...st.typing, [conversationId]: forConv } };
    });
  },

  setPresence(userId, p) {
    set((st) => ({ presence: { ...st.presence, [userId]: p } }));
  },

  setPeer(p) {
    set((st) => {
      const conversations = { ...st.conversations };
      for (const c of Object.values(conversations)) if (c.peer?.id === p.id) conversations[c.id] = { ...c, peer: p };
      return { conversations };
    });
  },
}));

/** Conversations sorted by latest activity. */
export const sortedConversations = (s: Pick<ChatState, 'conversations'>) =>
  Object.values(s.conversations).sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
