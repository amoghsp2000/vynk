import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar, toast } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { displayName, lastSeen } from '../lib/format';
import type { Conversation, Profile } from '../lib/types';
import { useCall } from '../calls/callStore';
import { useChat } from '../store/chat';

async function openChat(userId: string) {
  const c = await api<Conversation>('POST', '/api/conversations', { user_id: userId });
  useChat.getState().upsertConversation(c);
  return c.id;
}

/** Start a chat by phone number or from saved contacts. */
export function NewChat() {
  const nav = useNavigate();
  const [contacts, setContacts] = useState<Profile[]>([]);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ contacts: Profile[] }>('GET', '/api/contacts').then((r) => setContacts(r.contacts));
  }, []);

  async function start(e: FormEvent, save: boolean) {
    e.preventDefault();
    setError(null);
    try {
      const user = await api<Profile>('GET', `/api/users/lookup?phone_number=${encodeURIComponent(phone)}`);
      if (save) await api('POST', '/api/contacts', { user_id: user.id, ...(name.trim() ? { display_name: name.trim() } : {}) });
      nav(`/chat/${await openChat(user.id)}`);
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 404 ? 'No Parley account uses that number.' : err.message) : 'Network error');
    }
  }

  return (
    <>
      <div className="chat-header">
        <button className="icon-btn" onClick={() => nav('/')} aria-label="Back"><Icon name="back" /></button>
        <b>New chat</b>
      </div>
      <div className="scroll">
        <div className="page">
          <form className="card" onSubmit={(e) => void start(e, false)}>
            <h3>Find by phone number</h3>
            <div className="field">
              <input className="input" placeholder="+14155550123" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required />
            </div>
            <div className="field">
              <input className="input" placeholder="Save as (optional contact name)" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
            </div>
            {error && <div className="error">{error}</div>}
            <div className="row">
              <button className="btn">Message</button>
              <button className="btn secondary" type="button" onClick={(e) => void start(e, true)}>Save contact & message</button>
            </div>
          </form>
          <div className="card" style={{ padding: 6 }}>
            <div className="section-label">Contacts</div>
            {contacts.length === 0 && <p className="muted small" style={{ padding: '0 14px' }}>No saved contacts yet.</p>}
            {contacts.map((c) => (
              <button key={c.id} className="list-item" onClick={async () => nav(`/chat/${await openChat(c.id)}`)}>
                <Avatar name={displayName(c)} photoId={c.profile_photo_id} seed={c.id} size={40} />
                <div className="grow">
                  <div className="title">{displayName(c)}</div>
                  <div className="preview ellipsis">{c.about ?? c.phone_number}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/** Another user's profile, filtered by their privacy settings server-side. */
export function UserProfile() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [p, setP] = useState<Profile | null>(null);
  const presence = useChat((s) => (id ? s.presence[id] : undefined));
  const startCall = useCall((s) => s.startCall);

  const load = () => id && api<Profile>('GET', `/api/users/${id}`).then((x) => {
    setP(x);
    useChat.getState().setPeer(x);
  });
  useEffect(() => {
    void load();
  }, [id]);

  if (!p) return <div className="empty-main">Loading…</div>;
  const online = presence?.online ?? p.online;
  const seen = presence?.last_seen ?? p.last_seen;

  async function act(fn: () => Promise<unknown>, msg: string) {
    try {
      await fn();
      toast(msg);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed');
    }
  }

  return (
    <>
      <div className="chat-header">
        <button className="icon-btn" onClick={() => nav(-1)} aria-label="Back"><Icon name="back" /></button>
        <b>Contact info</b>
      </div>
      <div className="scroll">
        <div className="page">
          <div className="card profile-hero">
            <Avatar name={displayName(p)} photoId={p.profile_photo_id} seed={p.id} size={120} />
            <h2>{displayName(p)}</h2>
            <div className="muted">{p.phone_number}{p.contact_name ? ` · ~${p.name}` : ''}</div>
            <div className="muted small">{online ? 'online' : lastSeen(seen)}</div>
            <div className="actions-row">
              <button className="btn" onClick={async () => nav(`/chat/${await openChat(p.id)}`)}><Icon name="chats" /> Message</button>
              <button className="btn secondary" disabled={p.blocked_by_me} onClick={() => void startCall(p)}><Icon name="phone" /> Call</button>
            </div>
          </div>
          <div className="card">
            <h3>About</h3>
            <div>{p.about ?? <span className="muted">Hidden</span>}</div>
          </div>
          <div className="card">
            {p.is_contact ? (
              <button className="btn secondary block" onClick={() => void act(() => api('DELETE', `/api/contacts/${p.id}`), 'Removed from contacts')}>Remove from contacts</button>
            ) : (
              <button className="btn secondary block" onClick={() => void act(() => api('POST', '/api/contacts', { user_id: p.id }), 'Saved to contacts')}>Save to contacts</button>
            )}
            <div style={{ height: 10 }} />
            {p.blocked_by_me ? (
              <button className="btn secondary block" onClick={() => void act(() => api('DELETE', `/api/blocks/${p.id}`), 'Unblocked')}>Unblock {displayName(p)}</button>
            ) : (
              <button className="btn danger block" onClick={() => confirm(`Block ${displayName(p)}?`) && void act(() => api('POST', '/api/blocks', { user_id: p.id }), 'Blocked')}>
                <Icon name="block" /> Block {displayName(p)}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
