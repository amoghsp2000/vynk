import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, toast } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError, logout, type Me, type Privacy, type Visibility } from '../lib/api';
import { displayName } from '../lib/format';
import { uploadFile } from '../lib/media';
import { disablePush, enablePush, pushState } from '../lib/push';
import type { Profile } from '../lib/types';
import { useSession } from '../store/session';

function Header({ title }: { title: string }) {
  const nav = useNavigate();
  return (
    <div className="chat-header">
      <button className="icon-btn" onClick={() => nav('/')} aria-label="Back"><Icon name="back" /></button>
      <b>{title}</b>
    </div>
  );
}

export function MyProfile() {
  const me = useSession((s) => s.me)!;
  const setMe = useSession((s) => s.setMe);
  const [name, setName] = useState(me.name);
  const [about, setAbout] = useState(me.about);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function save(patch: Partial<Pick<Me, 'name' | 'about' | 'profile_photo_id'>>, msg = 'Saved') {
    setBusy(true);
    try {
      setMe(await api<Me>('PATCH', '/api/users/me', patch));
      toast(msg);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const id = await uploadFile(file, 'avatar');
      await save({ profile_photo_id: id }, 'Profile photo updated');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Upload failed');
      setBusy(false);
    }
  }

  return (
    <>
      <Header title="Profile" />
      <div className="scroll">
        <div className="page">
          <div className="card profile-hero">
            <div className="photo-edit" onClick={() => fileRef.current?.click()} role="button" aria-label="Change profile photo">
              <Avatar name={me.name} photoId={me.profile_photo_id} seed={me.id} size={130} />
              <span className="cam"><Icon name="camera" className="ticks" /></span>
            </div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void onPhoto(e.target.files?.[0])} />
            {me.profile_photo_id && (
              <button className="btn secondary" disabled={busy} onClick={() => void save({ profile_photo_id: null }, 'Photo removed')}>Remove photo</button>
            )}
            <div className="muted">{me.phone_number}</div>
          </div>
          <form className="card" onSubmit={(e) => (e.preventDefault(), void save({ name, about }))}>
            <div className="field">
              <label htmlFor="n">Name</label>
              <input id="n" className="input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="a">About</label>
              <input id="a" className="input" value={about} maxLength={140} onChange={(e) => setAbout(e.target.value)} />
            </div>
            <button className="btn" disabled={busy}>Save</button>
          </form>
        </div>
      </div>
    </>
  );
}

interface SessionRow {
  id: string;
  device_name: string;
  platform: string;
  last_used_at: string;
  current: boolean;
}

export function Settings() {
  const nav = useNavigate();
  const [privacy, setPrivacy] = useState<Privacy | null>(null);
  const [blocked, setBlocked] = useState<Profile[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [push, setPush] = useState<string>('…');

  const load = async () => {
    const [me, b, s] = await Promise.all([
      api<Me>('GET', '/api/users/me'),
      api<{ blocked: Profile[] }>('GET', '/api/blocks'),
      api<{ sessions: SessionRow[] }>('GET', '/api/auth/sessions'),
    ]);
    setPrivacy(me.privacy!);
    setBlocked(b.blocked);
    setSessions(s.sessions);
    setPush(await pushState().catch(() => 'unsupported'));
  };
  useEffect(() => {
    void load();
  }, []);

  async function setP<K extends keyof Privacy>(k: K, v: Privacy[K]) {
    setPrivacy(await api<Privacy>('PATCH', '/api/users/me/privacy', { [k]: v }));
  }

  async function togglePush() {
    try {
      if (push === 'on') await disablePush();
      else await enablePush();
      setPush(await pushState());
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed');
    }
  }

  const rows: [keyof Privacy, string][] = [
    ['last_seen', 'Last seen'],
    ['online', 'Online'],
    ['profile_photo', 'Profile photo'],
    ['about', 'About'],
    ['status', 'Status updates'],
  ];

  return (
    <>
      <Header title="Settings" />
      <div className="scroll">
        <div className="page">
          <div className="card">
            <h3>Privacy</h3>
            <p className="muted small">"My contacts" means people you've saved as contacts.</p>
            {privacy &&
              rows.map(([k, label]) => (
                <div className="setting-row" key={k}>
                  <span>{label}</span>
                  <select value={privacy[k] as Visibility} onChange={(e) => void setP(k, e.target.value as Visibility)} aria-label={label}>
                    <option value="everyone">Everyone</option>
                    <option value="contacts">My contacts</option>
                    <option value="nobody">Nobody</option>
                  </select>
                </div>
              ))}
            {privacy && (
              <div className="setting-row">
                <span>
                  Read receipts
                  <div className="muted small">If off, others won't see when you read messages or view statuses.</div>
                </span>
                <input type="checkbox" checked={privacy.read_receipts} onChange={(e) => void setP('read_receipts', e.target.checked)} aria-label="Read receipts" />
              </div>
            )}
          </div>

          <div className="card">
            <h3>Notifications</h3>
            <div className="setting-row">
              <span>
                Push notifications on this device
                <div className="muted small">
                  {push === 'unsupported' && 'Not supported by this browser.'}
                  {push === 'disabled-server' && 'The server has no Web Push (VAPID) keys configured.'}
                  {push === 'denied' && 'Blocked in browser settings.'}
                  {(push === 'on' || push === 'off') && 'New messages and calls while the app is closed. Message text is never included.'}
                </div>
              </span>
              <button className="btn secondary" disabled={push !== 'on' && push !== 'off'} onClick={() => void togglePush()}>
                <Icon name="bell" /> {push === 'on' ? 'Turn off' : 'Turn on'}
              </button>
            </div>
          </div>

          <div className="card">
            <h3>Blocked contacts</h3>
            {blocked.length === 0 && <p className="muted small">Nobody is blocked.</p>}
            {blocked.map((b) => (
              <div className="setting-row" key={b.id}>
                <div className="row">
                  <Avatar name={displayName(b)} seed={b.id} size={34} />
                  {displayName(b)}
                </div>
                <button className="btn secondary" onClick={async () => (await api('DELETE', `/api/blocks/${b.id}`), void load())}>Unblock</button>
              </div>
            ))}
          </div>

          <div className="card">
            <h3>Devices</h3>
            {sessions.map((s) => (
              <div className="setting-row" key={s.id}>
                <span>
                  {s.device_name} {s.current && <b className="small" style={{ color: 'var(--brand)' }}>· this device</b>}
                  <div className="muted small">Active {new Date(s.last_used_at).toLocaleString()}</div>
                </span>
                {!s.current && <button className="btn secondary" onClick={async () => (await api('DELETE', `/api/auth/sessions/${s.id}`), void load())}>Log out</button>}
              </div>
            ))}
            {sessions.length > 1 && (
              <button className="btn secondary block" onClick={async () => (await api('POST', '/api/auth/logout-all'), void load())}>Log out all other devices</button>
            )}
          </div>

          <ChangePassword />

          <div className="card">
            <h3>Security</h3>
            <p className="muted small">
              Messages and calls are encrypted in transit (TLS for messages, DTLS-SRTP for call audio). Messages are stored on the server
              and are <b>not</b> end-to-end encrypted yet.
            </p>
          </div>

          <button className="btn danger block" onClick={async () => (await logout(), nav('/login'))}><Icon name="logout" /> Log out</button>
        </div>
      </div>
    </>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ revoked_sessions: number }>('POST', '/api/auth/password', { current_password: current, new_password: next });
      toast(`Password changed${r.revoked_sessions ? ` · signed out ${r.revoked_sessions} other device(s)` : ''}`);
      setCurrent('');
      setNext('');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not change password');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <h3>Change password</h3>
      <div className="field">
        <input className="input" type="password" autoComplete="current-password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div className="field">
        <input className="input" type="password" autoComplete="new-password" placeholder="New password (min 8 characters)" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
      </div>
      <button className="btn secondary" disabled={busy}>Change password</button>
      <p className="muted small">Other devices are signed out when you change your password.</p>
    </form>
  );
}
