import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Avatar, toast } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { displayName, shortWhen, timeOfDay } from '../lib/format';
import { uploadFile, useMediaUrl } from '../lib/media';
import type { Profile, StatusItem } from '../lib/types';
import { useSession } from '../store/session';
import { useStatus } from '../store/status';

const COLORS = ['#4f46e5', '#0e7490', '#15803d', '#b45309', '#be123c', '#7c3aed', '#334155'];

export function StatusTab() {
  const nav = useNavigate();
  const me = useSession((s) => s.me)!;
  const { mine, updates, loaded, load } = useStatus();
  useEffect(() => {
    void load();
  }, [load]);

  const fresh = updates.filter((g) => !g.all_viewed);
  const seen = updates.filter((g) => g.all_viewed);
  return (
    <>
      <button className="list-item" onClick={() => nav(mine.length ? `/status/view/${me.id}` : '/status/new')}>
        <Avatar name={me.name} photoId={me.profile_photo_id} seed={me.id} ring={mine.length ? 'seen' : undefined} />
        <div className="grow">
          <div className="title">My status</div>
          <div className="preview">{mine.length ? `${mine.length} update${mine.length > 1 ? 's' : ''} · ${shortWhen(mine.at(-1)!.created_at)}` : 'Tap to add a status update'}</div>
        </div>
      </button>
      {fresh.length > 0 && <div className="section-label">Recent updates</div>}
      {fresh.map((g) => (
        <StatusRow key={g.user.id} user={g.user} latest={g.latest_at} ring="new" onClick={() => nav(`/status/view/${g.user.id}`)} />
      ))}
      {seen.length > 0 && <div className="section-label">Viewed updates</div>}
      {seen.map((g) => (
        <StatusRow key={g.user.id} user={g.user} latest={g.latest_at} ring="seen" onClick={() => nav(`/status/view/${g.user.id}`)} />
      ))}
      {loaded && !updates.length && <p className="muted small" style={{ padding: 14 }}>No status updates from your contacts in the last 24 hours.</p>}
      <button className="fab" onClick={() => nav('/status/new')} aria-label="New status"><Icon name="plus" /></button>
    </>
  );
}

function StatusRow({ user, latest, ring, onClick }: { user: Profile; latest: string; ring: 'new' | 'seen'; onClick(): void }) {
  return (
    <button className="list-item" onClick={onClick}>
      <Avatar name={displayName(user)} photoId={user.profile_photo_id} seed={user.id} ring={ring} />
      <div className="grow">
        <div className="title">{displayName(user)}</div>
        <div className="preview">{shortWhen(latest)}</div>
      </div>
    </button>
  );
}

export function StatusComposer() {
  const nav = useNavigate();
  const [mode, setMode] = useState<'text' | 'image'>('text');
  const [text, setText] = useState('');
  const [color, setColor] = useState(COLORS[0]!);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  async function post() {
    setBusy(true);
    try {
      if (mode === 'text') {
        await api('POST', '/api/status', { type: 'text', text, bg_color: color });
      } else if (file) {
        const media_id = await uploadFile(file, 'status');
        await api('POST', '/api/status', { type: file.type.startsWith('video/') ? 'video' : 'image', media_id, ...(text.trim() ? { text } : {}) });
      }
      await useStatus.getState().load();
      toast('Status posted · visible for 24 hours');
      nav('/status');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not post status');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="chat-header">
        <button className="icon-btn" onClick={() => nav('/status')} aria-label="Back"><Icon name="back" /></button>
        <b className="grow">New status</b>
        <button className={`icon-btn${mode === 'text' ? ' send-btn' : ''}`} onClick={() => setMode('text')} aria-label="Text status"><Icon name="text" /></button>
        <button className={`icon-btn${mode === 'image' ? ' send-btn' : ''}`} onClick={() => setMode('image')} aria-label="Photo status"><Icon name="image" /></button>
      </div>
      <div className="scroll">
        <div className="page">
          {mode === 'text' ? (
            <>
              <textarea className="text-status-edit" style={{ background: color }} placeholder="Type a status" maxLength={700} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
              <div className="composer-colors">
                {COLORS.map((c) => (
                  <button key={c} className={c === color ? 'sel' : ''} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Background ${c}`} />
                ))}
              </div>
            </>
          ) : (
            <div className="card">
              <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              {preview && (file?.type.startsWith('video/') ? <video src={preview} controls style={{ width: '100%', marginTop: 12, borderRadius: 12 }} /> : <img src={preview} alt="" style={{ width: '100%', marginTop: 12, borderRadius: 12 }} />)}
              <div className="field" style={{ marginTop: 12 }}>
                <input className="input" placeholder="Add a caption" maxLength={700} value={text} onChange={(e) => setText(e.target.value)} />
              </div>
              <p className="muted small">Images up to 10 MB, videos up to 30 MB. Files are checked server-side.</p>
            </div>
          )}
          <button className="btn block" disabled={busy || (mode === 'text' ? !text.trim() : !file)} onClick={() => void post()}>
            {busy ? 'Posting…' : 'Post status'}
          </button>
        </div>
      </div>
    </>
  );
}

const TEXT_MS = 5000;
const IMAGE_MS = 6000;

export function StatusViewer() {
  const { userId } = useParams<{ userId: string }>();
  const nav = useNavigate();
  const me = useSession((s) => s.me)!;
  const { mine, updates, markViewed } = useStatus();
  const isMine = userId === me.id;
  const group = isMine ? { user: null, statuses: mine } : updates.find((g) => g.user.id === userId);
  const statuses = group?.statuses ?? [];
  const [idx, setIdx] = useState(() => Math.max(0, statuses.findIndex((s) => !s.viewed)));
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reply, setReply] = useState('');
  const [viewers, setViewers] = useState<{ user: Profile; viewed_at: string }[] | null>(null);
  const current = statuses[idx];
  const mediaUrl = useMediaUrl(current?.media_id);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!group || !statuses.length) nav('/status', { replace: true });
  }, [group, statuses.length, nav]);

  useEffect(() => {
    if (current && !isMine && !current.viewed) void markViewed(current.id);
    setProgress(0);
    setViewers(null);
  }, [current?.id]);

  // Auto-advance (videos advance when they end).
  useEffect(() => {
    if (!current || paused || current.type === 'video') return;
    const total = current.type === 'text' ? TEXT_MS : IMAGE_MS;
    if (current.type === 'image' && !mediaUrl) return;
    const start = Date.now() - progress * total;
    const t = setInterval(() => {
      const p = (Date.now() - start) / total;
      if (p >= 1) next();
      else setProgress(p);
    }, 50);
    return () => clearInterval(t);
  }, [current?.id, paused, mediaUrl]);

  function next() {
    if (idx < statuses.length - 1) setIdx(idx + 1);
    else nav('/status');
  }
  const prev = () => setIdx(Math.max(0, idx - 1));

  async function sendReply() {
    if (!current || !reply.trim()) return;
    try {
      await api('POST', `/api/status/${current.id}/reply`, { client_msg_id: crypto.randomUUID(), body: reply.trim() });
      setReply('');
      toast('Reply sent');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not reply');
    }
  }

  async function remove() {
    if (!current || !confirm('Delete this status update?')) return;
    await api('DELETE', `/api/status/${current.id}`);
    await useStatus.getState().load();
    if (statuses.length <= 1) nav('/status');
    else setIdx(Math.max(0, idx - 1));
  }

  async function showViewers() {
    if (!current) return;
    setPaused(true);
    const r = await api<{ viewers: { user: Profile; viewed_at: string }[] }>('GET', `/api/status/${current.id}/viewers`);
    setViewers(r.viewers);
  }

  if (!current) return null;
  const owner = isMine ? me : group!.user!;
  return (
    <div className="status-viewer">
      <div className="status-progress">
        {statuses.map((s, i) => (
          <span key={s.id}><i style={{ width: `${i < idx ? 100 : i === idx ? progress * 100 : 0}%` }} /></span>
        ))}
      </div>
      <div className="status-top">
        <button className="icon-btn" onClick={() => nav('/status')} aria-label="Close"><Icon name="back" /></button>
        <Avatar name={isMine ? 'You' : displayName(owner as Profile)} photoId={owner.profile_photo_id} seed={owner.id} size={36} />
        <div className="grow">
          <div style={{ fontWeight: 600 }}>{isMine ? 'My status' : displayName(owner as Profile)}</div>
          <div className="small" style={{ opacity: 0.8 }}>{shortWhen(current.created_at)}</div>
        </div>
        {isMine && <button className="icon-btn" onClick={() => void remove()} aria-label="Delete status"><Icon name="trash" /></button>}
      </div>
      <div className="status-body" onMouseDown={() => setPaused(true)} onMouseUp={() => setPaused(false)} onTouchStart={() => setPaused(true)} onTouchEnd={() => setPaused(false)}>
        <StatusContent s={current} url={mediaUrl} videoRef={videoRef} onVideoEnd={next} onVideoProgress={setProgress} />
        {current.type !== 'text' && current.text && <div className="status-caption">{current.text}</div>}
        <div className="status-nav">
          <button onClick={prev} aria-label="Previous" />
          <button onClick={next} aria-label="Next" />
        </div>
      </div>
      {viewers ? (
        <div className="viewers-sheet">
          <div className="row" style={{ padding: '10px 14px' }}>
            <b className="grow">Viewed by {viewers.length}</b>
            <button className="icon-btn" onClick={() => (setViewers(null), setPaused(false))} aria-label="Close"><Icon name="close" /></button>
          </div>
          {viewers.map((v) => (
            <div className="list-item" key={v.user.id}>
              <Avatar name={displayName(v.user)} photoId={v.user.profile_photo_id} seed={v.user.id} size={36} />
              <div className="grow">{displayName(v.user)}</div>
              <span className="time">{timeOfDay(v.viewed_at)}</span>
            </div>
          ))}
        </div>
      ) : isMine ? (
        <div className="status-bottom" style={{ justifyContent: 'center' }}>
          <button className="btn secondary" onClick={() => void showViewers()}><Icon name="eye" /> {current.view_count ?? 0} views</button>
        </div>
      ) : (
        <form className="status-bottom" onSubmit={(e) => (e.preventDefault(), void sendReply())}>
          <input placeholder="Reply…" value={reply} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)} onChange={(e) => setReply(e.target.value)} maxLength={4096} />
          <button className="icon-btn send-btn" disabled={!reply.trim()} aria-label="Send reply"><Icon name="send" /></button>
        </form>
      )}
    </div>
  );
}

function StatusContent({ s, url, videoRef, onVideoEnd, onVideoProgress }: { s: StatusItem; url: string | null; videoRef: React.RefObject<HTMLVideoElement | null>; onVideoEnd(): void; onVideoProgress(p: number): void }) {
  if (s.type === 'text') {
    return <div className="status-text" style={{ background: s.bg_color ?? '#4f46e5' }}>{s.text}</div>;
  }
  if (!url) return <div className="muted">Loading…</div>;
  if (s.type === 'video') {
    return (
      <video
        ref={videoRef}
        src={url}
        autoPlay
        playsInline
        onEnded={onVideoEnd}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          if (v.duration) onVideoProgress(v.currentTime / v.duration);
        }}
      />
    );
  }
  return <img src={url} alt="Status" />;
}
