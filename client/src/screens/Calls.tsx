import { useEffect, useState } from 'react';
import { Avatar, useTick } from '../components/common';
import { Icon } from '../components/Icon';
import { api } from '../lib/api';
import { displayName, duration, shortWhen, timeOfDay } from '../lib/format';
import { realtime } from '../lib/realtime';
import type { CallDto, Profile } from '../lib/types';
import { useCall } from '../calls/callStore';

interface HistoryItem extends CallDto {
  direction: 'incoming' | 'outgoing';
  peer: Profile | null;
}

export function CallsTab() {
  const [calls, setCalls] = useState<HistoryItem[] | null>(null);
  const startCall = useCall((s) => s.startCall);

  useEffect(() => {
    const load = () => void api<{ calls: HistoryItem[] }>('GET', '/api/calls?limit=50').then((r) => setCalls(r.calls));
    load();
    return realtime.on('call.ended', () => setTimeout(load, 300));
  }, []);

  if (!calls) return <p className="muted small" style={{ padding: 14 }}>Loading…</p>;
  if (!calls.length) return <p className="muted small" style={{ padding: 14 }}>No calls yet. Open a chat and tap the phone icon.</p>;
  return (
    <>
      {calls.map((c) => {
        const missed = c.direction === 'incoming' && (c.status === 'MISSED' || c.status === 'REJECTED');
        return (
          <div key={c.id} className="list-item">
            <Avatar name={displayName(c.peer)} photoId={c.peer?.profile_photo_id} seed={c.peer?.id} />
            <div className="grow">
              <div className={`title${missed ? ' missed' : ''}`}>{displayName(c.peer)}</div>
              <div className="preview">
                <Icon name={c.direction === 'incoming' ? 'callIn' : 'callOut'} className={`ticks${missed ? ' missed' : ''}`} />
                {shortWhen(c.created_at)}, {timeOfDay(c.created_at)}
                {c.duration_ms ? ` · ${duration(c.duration_ms)}` : c.status !== 'ENDED' ? ` · ${c.status.toLowerCase()}` : ''}
              </div>
            </div>
            <button className="icon-btn" disabled={!c.peer} onClick={() => c.peer && void startCall(c.peer)} aria-label="Call back"><Icon name="phone" /></button>
          </div>
        );
      })}
    </>
  );
}

const STATUS_TEXT: Record<string, string> = {
  INITIATING: 'Calling…',
  RINGING: 'Ringing…',
  ACCEPTED: 'Connecting…',
  CONNECTING: 'Connecting…',
  RECONNECTING: 'Reconnecting…',
};

/** Incoming / outgoing / active call screen, rendered above everything. */
export function CallOverlay() {
  const c = useCall();
  useTick(1000);
  if (c.phase === 'idle') return null;
  const name = displayName(c.peer);
  const stateText =
    c.phase === 'incoming'
      ? 'Incoming voice call'
      : c.phase === 'ended'
        ? c.message
        : c.status === 'CONNECTED' && c.connectedAt
          ? duration(Date.now() - c.connectedAt)
          : (STATUS_TEXT[c.status ?? ''] ?? '');

  return (
    <div className="call-overlay" role="dialog" aria-label="Call">
      <div className="who">
        <div className={c.phase === 'incoming' || c.status === 'RINGING' ? 'pulse' : ''} style={{ borderRadius: '50%' }}>
          <Avatar name={name} photoId={c.peer?.profile_photo_id} seed={c.peer?.id} size={128} />
        </div>
        <h2>{name}</h2>
        <div className="state">{stateText}</div>
        {c.peerSignalingLost && c.phase === 'active' && <div className="small">{name}'s connection is unstable…</div>}
        <div className="small" style={{ opacity: 0.7 }}>Encrypted in transit (DTLS-SRTP), peer-to-peer when possible</div>
      </div>

      {c.phase === 'incoming' ? (
        <div className="call-controls" style={{ gap: 64 }}>
          <div>
            <button className="call-btn hangup" onClick={() => void c.reject()} aria-label="Decline"><Icon name="hangup" /></button>
            <div className="call-label">Decline</div>
          </div>
          <div>
            <button className="call-btn accept" onClick={() => void c.accept()} aria-label="Accept"><Icon name="phone" /></button>
            <div className="call-label">Accept</div>
          </div>
        </div>
      ) : c.phase === 'ended' ? (
        <div className="call-controls" />
      ) : (
        <div className="call-controls">
          <div>
            <button
              className={`call-btn${c.speakerOn ? ' on' : ''}`}
              onClick={() => void c.toggleSpeaker()}
              disabled={!c.speakerSupported}
              title={c.speakerSupported ? 'Switch audio output' : 'This browser cannot choose an audio output'}
              aria-label="Speaker"
            >
              <Icon name="speaker" />
            </button>
            <div className="call-label">Speaker</div>
          </div>
          <div>
            <button className={`call-btn${c.muted ? ' on' : ''}`} onClick={c.toggleMute} aria-label={c.muted ? 'Unmute' : 'Mute'}>
              <Icon name={c.muted ? 'micOff' : 'mic'} />
            </button>
            <div className="call-label">{c.muted ? 'Unmute' : 'Mute'}</div>
          </div>
          <div>
            <button className="call-btn hangup" onClick={() => void c.hangup()} aria-label="End call"><Icon name="hangup" /></button>
            <div className="call-label">End</div>
          </div>
        </div>
      )}
    </div>
  );
}
