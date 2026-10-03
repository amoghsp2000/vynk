import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar, EmojiPicker, Ticks, toast, useTick } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { dayLabel, displayName, lastSeen, timeOfDay } from '../lib/format';
import { realtime } from '../lib/realtime';
import { discardPending, markRead, retryPending, sendText, stopTyping, userTyping } from '../lib/sync';
import type { Message, PendingMessage } from '../lib/types';
import { useCall } from '../calls/callStore';
import { useChat } from '../store/chat';
import { useSession } from '../store/session';

export function ChatScreen() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const me = useSession((s) => s.me)!;
  const conv = useChat((s) => (id ? s.conversations[id] : undefined));
  const thread = useChat((s) => (id ? s.threads[id] : undefined));
  const pending = useChat((s) => (id ? s.pending[id] : undefined)) ?? [];
  const typingMap = useChat((s) => (id ? s.typing[id] : undefined));
  const presence = useChat((s) => (conv?.peer ? s.presence[conv.peer.id] : undefined));
  const startCall = useCall((s) => s.startCall);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [menu, setMenu] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useTick(3000);

  // Load the conversation (deep links) and its newest history page.
  useEffect(() => {
    if (!id) return;
    useChat.getState().setOpen(id);
    void useChat.getState().ensureConversation(id).then(() => {
      if (!useChat.getState().conversations[id]) nav('/', { replace: true });
    });
    void useChat.getState().loadHistory(id);
    stickToBottom.current = true;
    return () => {
      useChat.getState().setOpen(null);
      stopTyping();
    };
  }, [id, nav]);

  const messages = thread ? thread.order.map((mid) => thread.byId[mid]!) : [];
  const lastIncoming = [...messages].reverse().find((m) => m.sender_id !== me.id);

  // Mark read while the chat is visible.
  useEffect(() => {
    if (!id || !lastIncoming) return;
    const tryRead = () => document.visibilityState === 'visible' && markRead(id, lastIncoming.seq);
    tryRead();
    document.addEventListener('visibilitychange', tryRead);
    return () => document.removeEventListener('visibilitychange', tryRead);
  }, [id, lastIncoming?.seq]);

  // Keep scrolled to the bottom when new messages arrive (unless reading history).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending.length, id]);

  async function loadOlder() {
    const el = listRef.current;
    if (!el || !id) return;
    const before = el.scrollHeight;
    await useChat.getState().loadHistory(id, true);
    requestAnimationFrame(() => (el.scrollTop = el.scrollHeight - before));
  }

  function onScroll() {
    const el = listRef.current!;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && thread?.hasMore && thread.loaded) void loadOlder();
  }

  async function del(m: Message, scope: 'me' | 'everyone') {
    try {
      await realtime.request('message.delete', { message_id: m.id, scope });
      if (scope === 'me') useChat.getState().applyHidden(m.conversation_id, m.id);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not delete');
    }
  }

  async function deleteChat() {
    if (!id || !confirm('Delete this chat? Messages are removed only from your devices.')) return;
    await api('DELETE', `/api/conversations/${id}`);
    useChat.getState().removeConversation(id);
    nav('/');
  }

  async function toggleBlock() {
    if (!conv?.peer) return;
    const p = conv.peer;
    if (p.blocked_by_me) await api('DELETE', `/api/blocks/${p.id}`);
    else if (confirm(`Block ${displayName(p)}? They won't be able to call or message you.`)) await api('POST', '/api/blocks', { user_id: p.id });
    else return;
    useChat.getState().setPeer(await api('GET', `/api/users/${p.id}`));
    setMenu(false);
  }

  if (!id || !conv) return <div className="empty-main">Loading…</div>;
  const peer = conv.peer;
  const isTyping = Object.values(typingMap ?? {}).some((exp) => exp > Date.now());
  const subtitle = isTyping ? 'typing…' : presence?.online ? 'online' : lastSeen(presence?.last_seen ?? null);

  // Interleave day separators.
  const rows: React.ReactNode[] = [];
  let lastDay = '';
  for (const m of messages) {
    const day = new Date(m.created_at).toDateString();
    if (day !== lastDay) {
      rows.push(<div key={`d-${day}`} className="day-sep">{dayLabel(m.created_at)}</div>);
      lastDay = day;
    }
    rows.push(
      <Bubble key={m.id} m={m} mine={m.sender_id === me.id} peerName={displayName(peer)} onReply={() => setReplyTo(m)} onDelete={(s) => void del(m, s)} />,
    );
  }
  for (const p of pending) rows.push(<PendingBubble key={p.client_msg_id} p={p} />);

  return (
    <>
      <div className="chat-header" style={{ position: 'relative' }}>
        <button className="icon-btn" onClick={() => nav('/')} aria-label="Back">
          <Icon name="back" />
        </button>
        <div className="row grow who" onClick={() => peer && nav(`/user/${peer.id}`)}>
          <Avatar name={displayName(peer)} photoId={peer?.profile_photo_id} seed={peer?.id} size={40} />
          <div className="grow">
            <div className="ellipsis" style={{ fontWeight: 600 }}>{displayName(peer)}</div>
            <div className={`sub ellipsis${isTyping ? ' typing-text' : ''}`}>{subtitle}</div>
          </div>
        </div>
        <button className="icon-btn" disabled={!peer || peer.blocked_by_me} onClick={() => peer && void startCall(peer)} aria-label="Voice call" title="Voice call">
          <Icon name="phone" />
        </button>
        <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="More">
          <Icon name="more" />
        </button>
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            <button onClick={() => peer && nav(`/user/${peer.id}`)}>View profile</button>
            <button onClick={toggleBlock}>{peer?.blocked_by_me ? 'Unblock' : 'Block'}</button>
            <button className="danger" onClick={deleteChat}>Delete chat</button>
          </div>
        )}
      </div>

      <div className="messages" ref={listRef} onScroll={onScroll}>
        {thread?.hasMore && thread.loaded && (
          <button className="btn secondary load-more" onClick={() => void loadOlder()}>Load older messages</button>
        )}
        {rows}
      </div>

      {peer?.blocked_by_me ? (
        <div className="reply-preview" style={{ justifyContent: 'center' }}>
          You blocked this contact. <button className="btn secondary" onClick={toggleBlock}>Unblock</button>
        </div>
      ) : (
        <Composer
          conversationId={id}
          replyTo={replyTo}
          replyName={replyTo ? (replyTo.sender_id === me.id ? 'You' : displayName(peer)) : ''}
          clearReply={() => setReplyTo(null)}
          onSent={() => (stickToBottom.current = true)}
        />
      )}
    </>
  );
}

function Bubble({ m, mine, peerName, onReply, onDelete }: { m: Message; mine: boolean; peerName: string; onReply(): void; onDelete(scope: 'me' | 'everyone'): void }) {
  const canEveryone = mine && !m.deleted && Date.now() - Date.parse(m.created_at) < 48 * 3600_000;
  return (
    <div className={`bubble-row${mine ? ' out' : ''}`}>
      <div className={`bubble${m.deleted ? ' deleted' : ''}`}>
        {!m.deleted && (
          <div className="bubble-actions">
            <button onClick={onReply} title="Reply" aria-label="Reply"><Icon name="reply" className="ticks" /></button>
            <button
              onClick={() => {
                const scope = canEveryone && confirm('Delete for everyone? (Cancel = delete only for me)') ? 'everyone' : 'me';
                onDelete(scope);
              }}
              title="Delete"
              aria-label="Delete"
            >
              <Icon name="trash" className="ticks" />
            </button>
          </div>
        )}
        {m.status_reply_id && <span className="quote"><b>Status</b>Replied to {mine ? `${peerName}'s` : 'your'} status</span>}
        {m.reply_to && (
          <span className="quote">
            <b>{m.reply_to.sender_id === m.sender_id ? (mine ? 'You' : peerName) : mine ? peerName : 'You'}</b>
            {m.reply_to.deleted ? 'Deleted message' : m.reply_to.body}
          </span>
        )}
        {m.deleted ? '🚫 This message was deleted' : m.body}
        <span className="footer">
          {timeOfDay(m.created_at)}
          {mine && !m.deleted && <Ticks status={m.status ?? 'sent'} />}
        </span>
      </div>
    </div>
  );
}

function PendingBubble({ p }: { p: PendingMessage }) {
  return (
    <div className="bubble-row out">
      <div className="bubble">
        {p.body}
        <span className="footer">
          {timeOfDay(p.created_at)} <Ticks status={p.state} />
        </span>
        {p.state === 'failed' && (
          <div className="failed">
            Not sent{p.error ? `: ${p.error}` : ''} ·{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), retryPending(p.client_msg_id))}>Retry</a> ·{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), discardPending(p.client_msg_id))}>Discard</a>
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ conversationId, replyTo, replyName, clearReply, onSent }: { conversationId: string; replyTo: Message | null; replyName: string; clearReply(): void; onSent(): void }) {
  const [text, setText] = useState('');
  const [emoji, setEmoji] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Drafts survive navigation and reloads.
  const draftKey = `parley.draft.${conversationId}`;
  useEffect(() => {
    setText(localStorage.getItem(draftKey) ?? '');
  }, [draftKey]);
  useEffect(() => {
    if (text) localStorage.setItem(draftKey, text);
    else localStorage.removeItem(draftKey);
  }, [text, draftKey]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  function send() {
    const body = text.trim();
    if (!body) return;
    sendText(conversationId, body, replyTo?.id);
    stopTyping();
    setText('');
    clearReply();
    setEmoji(false);
    onSent();
    ref.current?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      {replyTo && (
        <div className="reply-preview">
          <div className="quote ellipsis">
            <b style={{ color: 'var(--brand)' }}>{replyName}</b>
            <div className="ellipsis">{replyTo.body}</div>
          </div>
          <button className="icon-btn" onClick={clearReply} aria-label="Cancel reply"><Icon name="close" /></button>
        </div>
      )}
      <div className="composer">
        {emoji && <EmojiPicker onPick={(e) => setText((t) => t + e)} />}
        <button className="icon-btn" onClick={() => setEmoji(!emoji)} aria-label="Emoji"><Icon name="smile" /></button>
        <textarea
          ref={ref}
          rows={1}
          placeholder="Message"
          value={text}
          maxLength={4096}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) userTyping(conversationId);
            else stopTyping();
          }}
          onKeyDown={onKey}
          aria-label="Message"
        />
        <button className="icon-btn send-btn" onClick={send} disabled={!text.trim()} aria-label="Send"><Icon name="send" /></button>
      </div>
    </>
  );
}
