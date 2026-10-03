import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { Avatar, Ticks, useTick } from '../components/common';
import { Icon } from '../components/Icon';
import { displayName, shortWhen } from '../lib/format';
import { api } from '../lib/api';
import type { Message } from '../lib/types';
import { sortedConversations, useChat } from '../store/chat';
import { useSession } from '../store/session';
import { StatusTab } from './Status';
import { CallsTab } from './Calls';

/** Two-pane layout on desktop; one pane at a time on narrow screens. */
export function Home() {
  const me = useSession((s) => s.me)!;
  const connection = useSession((s) => s.connection);
  const loc = useLocation();
  const nav = useNavigate();
  const onStatus = useMatch('/status/*');
  const onCalls = useMatch('/calls/*');
  const hasMain = /^\/(chat|new|profile|settings|user)/.test(loc.pathname);

  return (
    <div className={`shell${hasMain ? ' has-main' : ''}`}>
      <aside className="sidebar">
        <div className="topbar">
          <button className="icon-btn" style={{ width: 'auto', height: 'auto' }} onClick={() => nav('/profile')} aria-label="My profile">
            <Avatar name={me.name} photoId={me.profile_photo_id} seed={me.id} size={38} />
          </button>
          <h1 className="grow">Parley</h1>
          <button className="icon-btn" onClick={() => nav('/new')} aria-label="New chat" title="New chat">
            <Icon name="plus" />
          </button>
          <button className="icon-btn" onClick={() => nav('/settings')} aria-label="Settings" title="Settings">
            <Icon name="settings" />
          </button>
        </div>
        {connection !== 'online' && <div className="conn-banner">{connection === 'connecting' ? 'Connecting…' : 'Offline — messages will send when you reconnect'}</div>}
        <nav className="tabs">
          <NavLink to="/" end className={({ isActive }) => (isActive || /^\/chat/.test(loc.pathname) ? 'active' : '')}>
            <Icon name="chats" /> Chats
          </NavLink>
          <NavLink to="/status">
            <Icon name="status" /> Status
          </NavLink>
          <NavLink to="/calls">
            <Icon name="phone" /> Calls
          </NavLink>
        </nav>
        <div className="scroll" style={{ position: 'relative' }}>
          {onStatus ? <StatusTab /> : onCalls ? <CallsTab /> : <ChatList />}
        </div>
      </aside>
      <main className="main">
        {hasMain ? (
          <Outlet />
        ) : (
          <div className="empty-main">
            <div>
              <img src="/icon.svg" alt="" />
              <h2>Parley for web</h2>
              <p>Pick a chat to start messaging, or press + to start a new one.</p>
              <p className="small">Messages are encrypted in transit (TLS). They are not end-to-end encrypted yet.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function ChatList() {
  const me = useSession((s) => s.me)!;
  const byId = useChat((s) => s.conversations);
  const conversations = useMemo(() => sortedConversations({ conversations: byId }), [byId]);
  const typing = useChat((s) => s.typing);
  const presence = useChat((s) => s.presence);
  const pending = useChat((s) => s.pending);
  const openId = useChat((s) => s.openConversationId);
  const [q, setQ] = useState('');
  useTick(5000); // expire typing indicators

  const needle = q.trim().toLowerCase();
  const list = needle
    ? conversations.filter((c) => [c.peer?.name, c.peer?.contact_name, c.peer?.phone_number].some((v) => v?.toLowerCase().includes(needle)))
    : conversations;

  return (
    <>
      <div className="search">
        <input className="input" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
      </div>
      {list.length === 0 && !needle && (
        <div className="empty-main" style={{ padding: 40 }}>
          No chats yet. Tap + to start one.
        </div>
      )}
      {needle && <div className="section-label">Chats</div>}
      {list.map((c) => {
        const isTyping = Object.entries(typing[c.id] ?? {}).some(([, exp]) => exp > Date.now());
        const lm = c.last_message;
        const myPending = (pending[c.id] ?? []).at(-1);
        const mine = lm?.sender_id === me.id;
        const online = c.peer ? presence[c.peer.id]?.online : null;
        return (
          <Link key={c.id} to={`/chat/${c.id}`} className={`list-item${openId === c.id ? ' active' : ''}`}>
            <Avatar name={displayName(c.peer)} photoId={c.peer?.profile_photo_id} seed={c.peer?.id} online={online} />
            <div className="grow">
              <div className="row">
                <span className="title grow ellipsis">{displayName(c.peer)}</span>
                {lm && <span className={`time${c.unread_count ? ' unread' : ''}`}>{shortWhen(myPending?.created_at ?? lm.created_at)}</span>}
              </div>
              <div className="row">
                <span className="preview grow ellipsis">
                  {isTyping ? (
                    <span className="typing-text">typing…</span>
                  ) : myPending ? (
                    <>
                      <Ticks status={myPending.state} /> <span className="ellipsis">{myPending.body}</span>
                    </>
                  ) : lm ? (
                    <>
                      {mine && !lm.deleted && <Ticks status={(lm.status as 'sent') ?? 'sent'} />}
                      <span className="ellipsis">{lm.deleted ? 'This message was deleted' : lm.type === 'image' ? '📷 Photo' : lm.body}</span>
                    </>
                  ) : (
                    <span className="muted">Say hi 👋</span>
                  )}
                </span>
                {c.unread_count > 0 && <span className="badge">{c.unread_count}</span>}
              </div>
            </div>
          </Link>
        );
      })}
      {needle && <MessageResults q={q.trim()} />}
    </>
  );
}

/** Server-side full-text-ish search across the user's own visible messages. */
function MessageResults({ q }: { q: string }) {
  const conversations = useChat((s) => s.conversations);
  const [results, setResults] = useState<Message[] | null>(null);
  useEffect(() => {
    setResults(null);
    const t = setTimeout(() => {
      api<{ messages: Message[] }>('GET', `/api/messages/search?q=${encodeURIComponent(q)}`)
        .then((r) => setResults(r.messages))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <>
      <div className="section-label">Messages</div>
      {results === null && <div className="list-item muted small">Searching…</div>}
      {results?.length === 0 && <div className="list-item muted small">No messages found.</div>}
      {results?.map((m) => {
        const c = conversations[m.conversation_id];
        return (
          <Link key={m.id} to={`/chat/${m.conversation_id}`} className="list-item">
            <div className="grow">
              <div className="row">
                <span className="title grow ellipsis">{displayName(c?.peer)}</span>
                <span className="time">{shortWhen(m.created_at)}</span>
              </div>
              <div className="preview ellipsis">{m.body}</div>
            </div>
          </Link>
        );
      })}
    </>
  );
}
