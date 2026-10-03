import { create } from 'zustand';
import { api, ApiError } from '../lib/api';
import { realtime } from '../lib/realtime';
import type { CallDto, Profile } from '../lib/types';
import { startRingback, startRingtone, stopTone } from './tones';

/**
 * 1:1 voice calls over WebRTC. Audio flows peer-to-peer (or via TURN when NAT
 * prevents a direct path); the server only relays signaling.
 *
 *   caller: getUserMedia -> call.initiate -> createOffer -> call.offer
 *   callee: call.incoming -> (accept) getUserMedia -> call.accept (gets the
 *           buffered offer + ICE) -> createAnswer -> call.answer
 *   both:   trickle ICE via call.ice_candidate; report ICE state via call.state
 *
 * Remote candidates that arrive before the remote description are buffered.
 * ICE 'failed' triggers an ICE restart (caller side); a signaling reconnect
 * re-binds with call.resume.
 */

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'active' | 'ended';

interface CallState {
  phase: CallPhase;
  callId: string | null;
  role: 'caller' | 'callee' | null;
  peer: Profile | null;
  status: CallDto['status'] | null;
  connectedAt: number | null;
  muted: boolean;
  speakerOn: boolean;
  speakerSupported: boolean;
  peerSignalingLost: boolean;
  message: string | null;

  startCall(peer: Profile): Promise<void>;
  accept(): Promise<void>;
  reject(): Promise<void>;
  hangup(): Promise<void>;
  toggleMute(): void;
  toggleSpeaker(): Promise<void>;
}

// ---- engine internals (one call at a time) ----
let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let iceServers: RTCIceServer[] = [];
let remoteCandidates: RTCIceCandidateInit[] = [];
let remoteDescSet = false;
let restartAttempts = 0;
let failTimer: ReturnType<typeof setTimeout> | undefined;
let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
let endedResetTimer: ReturnType<typeof setTimeout> | undefined;

// Diagnostics hook (byte counters + ICE state only) used by end-to-end tests to
// verify real RTP audio flow. On in dev, opt-in elsewhere via localStorage.
if (import.meta.env.DEV || localStorage.getItem('parley.debug') === '1') {
  (window as unknown as { __parleyCall: unknown }).__parleyCall = {
    stats: async () => {
      if (!pc) return null;
      const out = { inboundBytes: 0, outboundBytes: 0, ice: pc.iceConnectionState, candidateType: '' as string };
      const report = await pc.getStats();
      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') out.inboundBytes += r.bytesReceived ?? 0;
        if (r.type === 'outbound-rtp' && r.kind === 'audio') out.outboundBytes += r.bytesSent ?? 0;
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
          const local = report.get(r.localCandidateId);
          out.candidateType = local?.candidateType ?? '';
        }
      });
      return out;
    },
    diag: async () => {
      if (!pc) return null;
      const report = await pc.getStats();
      const pairs: string[] = [];
      const cands: string[] = [];
      report.forEach((r) => {
        if (r.type === 'candidate-pair') {
          const l = report.get(r.localCandidateId);
          const rm = report.get(r.remoteCandidateId);
          pairs.push(`${l?.candidateType}:${l?.address}:${l?.port} -> ${rm?.candidateType}:${rm?.address}:${rm?.port} ${r.state}`);
        }
        if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands.push(`${r.type} ${r.candidateType} ${r.address}:${r.port} ${r.protocol}`);
      });
      return { ice: pc.iceConnectionState, gathering: pc.iceGatheringState, signaling: pc.signalingState, remoteDescSet, buffered: remoteCandidates.length, pairs, cands };
    },
  };
}

const iceUp = () => pc?.iceConnectionState === 'connected' || pc?.iceConnectionState === 'completed';

const remoteAudio = new Audio();
remoteAudio.autoplay = true;
const supportsSink = 'setSinkId' in HTMLMediaElement.prototype;

const END_TEXT: Record<string, string> = {
  hangup: 'Call ended',
  rejected: 'Call declined',
  busy: 'User is on another call',
  no_answer: 'No answer',
  cancelled: 'Call cancelled',
  connection_lost: 'Connection lost',
  setup_timeout: 'Could not connect',
  ice_failed: 'Could not establish a connection',
  mic_denied: 'Microphone access was denied',
};

export const useCall = create<CallState>((set, get) => {
  // `localStorage['parley.forceRelay'] = '1'` forces TURN-only ICE: useful to
  // verify the relay path that users behind symmetric NAT/firewalls depend on.
  const iceConfig = (): RTCConfiguration => ({
    iceServers,
    iceCandidatePoolSize: 2,
    iceTransportPolicy: localStorage.getItem('parley.forceRelay') === '1' ? 'relay' : 'all',
  });

  async function getMic() {
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  }

  function createPeer() {
    const callId = get().callId!;
    pc = new RTCPeerConnection(iceConfig());
    remoteCandidates = [];
    remoteDescSet = false;
    for (const t of localStream?.getTracks() ?? []) pc.addTrack(t, localStream!);

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      void realtime
        .request('call.ice_candidate', { call_id: callId, candidate: e.candidate.toJSON() })
        .catch(() => undefined); // trickle ICE tolerates loss; restart covers the rest
    };
    pc.ontrack = (e) => {
      remoteAudio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void remoteAudio.play().catch(() => undefined);
    };
    pc.oniceconnectionstatechange = () => onIceState(pc!.iceConnectionState);
  }

  function onIceState(state: RTCIceConnectionState) {
    const s = get();
    if (!s.callId || s.phase === 'ended') return;
    if (state === 'connected' || state === 'completed') {
      clearTimeout(failTimer);
      clearTimeout(disconnectTimer);
      restartAttempts = 0;
      stopTone();
      set({ phase: 'active', status: 'CONNECTED', connectedAt: s.connectedAt ?? Date.now() });
      void realtime.request('call.state', { call_id: s.callId, state: 'connected' }).catch(() => undefined);
    } else if (state === 'disconnected') {
      // Often transient (network handover). Give it a moment, then restart ICE.
      set({ status: 'RECONNECTING' });
      void realtime.request('call.state', { call_id: s.callId, state: 'reconnecting' }).catch(() => undefined);
      clearTimeout(disconnectTimer);
      disconnectTimer = setTimeout(() => {
        if (pc?.iceConnectionState === 'disconnected') void iceRestart();
      }, 4000);
      armFailTimer();
    } else if (state === 'failed') {
      set({ status: 'RECONNECTING' });
      void iceRestart();
      armFailTimer();
    }
  }

  function armFailTimer() {
    if (failTimer) return;
    failTimer = setTimeout(() => {
      failTimer = undefined;
      const st = pc?.iceConnectionState;
      if (st !== 'connected' && st !== 'completed') void fail('ice_failed');
    }, 20_000);
  }

  /** Caller drives ICE restarts so both sides don't offer at once (glare). */
  async function iceRestart() {
    const s = get();
    if (!pc || s.role !== 'caller' || !s.callId || restartAttempts >= 3) return;
    restartAttempts++;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await realtime.request('call.offer', { call_id: s.callId, sdp: offer.sdp });
    } catch (err) {
      console.warn('ICE restart failed', err);
    }
  }

  async function flushCandidates() {
    remoteDescSet = true;
    for (const c of remoteCandidates.splice(0)) await pc?.addIceCandidate(c).catch(() => undefined);
  }

  async function handleOffer(sdp: string) {
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await flushCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await realtime.request('call.answer', { call_id: get().callId, sdp: answer.sdp });
    if (get().status === 'ACCEPTED' && !iceUp()) set({ status: 'CONNECTING' });
  }

  function cleanup() {
    stopTone();
    clearTimeout(failTimer);
    clearTimeout(disconnectTimer);
    failTimer = undefined;
    pc?.close();
    pc = null;
    for (const t of localStream?.getTracks() ?? []) t.stop();
    localStream = null;
    remoteAudio.srcObject = null;
  }

  function finish(status: CallDto['status'], reason: string | null) {
    cleanup();
    set({ phase: 'ended', status, message: (reason && END_TEXT[reason]) ?? (status === 'MISSED' ? 'Missed call' : 'Call ended') });
    clearTimeout(endedResetTimer);
    endedResetTimer = setTimeout(() => {
      if (get().phase === 'ended') reset();
    }, 2200);
  }

  function reset() {
    set({
      phase: 'idle',
      callId: null,
      role: null,
      peer: null,
      status: null,
      connectedAt: null,
      muted: false,
      speakerOn: false,
      peerSignalingLost: false,
      message: null,
    });
  }

  async function fail(reason: string) {
    const id = get().callId;
    if (id) await realtime.request('call.fail', { call_id: id, reason }).catch(() => undefined);
    finish('FAILED', reason);
  }

  // ---- signaling events ----
  realtime.on('call.incoming', (e) => {
    if (get().phase !== 'idle') return; // server-side busy lock normally prevents this
    clearTimeout(endedResetTimer);
    set({
      phase: 'incoming',
      callId: e.payload.call.id,
      role: 'callee',
      peer: e.payload.caller,
      status: 'RINGING',
      message: null,
    });
    startRingtone();
  });
  realtime.on('call.accepted', (e) => {
    if (e.payload.id !== get().callId) return;
    stopTone();
    set({ phase: 'active', ...(iceUp() ? {} : { status: 'ACCEPTED' as const }) });
  });
  realtime.on('call.offer', (e) => {
    if (e.payload.call_id === get().callId) void handleOffer(e.payload.sdp).catch((err) => console.warn(err));
  });
  realtime.on('call.answer', async (e) => {
    if (e.payload.call_id !== get().callId || !pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: e.payload.sdp }).catch((err) => console.warn(err));
    await flushCandidates();
    // ICE may already have connected while candidates were being added.
    if (!iceUp()) set({ status: 'CONNECTING' });
  });
  realtime.on('call.ice_candidate', (e) => {
    if (e.payload.call_id !== get().callId) return;
    // Delayed or early candidates: hold until the remote description exists.
    if (pc && remoteDescSet) void pc.addIceCandidate(e.payload.candidate).catch(() => undefined);
    else remoteCandidates.push(e.payload.candidate);
  });
  realtime.on('call.ended', (e) => {
    if (e.payload.id === get().callId && get().phase !== 'ended') finish(e.payload.status, e.payload.end_reason);
  });
  realtime.on('call.answered_elsewhere', (e) => {
    if (e.payload.call_id === get().callId && get().phase === 'incoming') {
      cleanup();
      reset();
    }
  });
  realtime.on('call.peer_disconnected', (e) => {
    if (e.payload.call_id === get().callId) set({ peerSignalingLost: true });
  });
  realtime.on('call.peer_resumed', (e) => {
    if (e.payload.call_id !== get().callId) return;
    set({ peerSignalingLost: false });
    const st = pc?.iceConnectionState;
    if (st && st !== 'connected' && st !== 'completed') void iceRestart();
  });
  realtime.on('call.state', (e) => {
    if (e.payload.call_id === get().callId && e.payload.status === 'RECONNECTING') set({ status: 'RECONNECTING' });
  });

  // After our own signaling reconnects, re-bind this connection to the call.
  realtime.onOpen(async (first) => {
    const s = get();
    if (first) {
      // Opened from a push notification / reload while being called: show it again.
      const r = await api<{ active: { call: CallDto; role: string } | null }>('GET', '/api/calls/active').catch(() => null);
      const active = r?.active;
      if (active && active.role === 'callee' && active.call.status === 'RINGING' && s.phase === 'idle') {
        const peer = await api<Profile>('GET', `/api/users/${active.call.caller_id}`).catch(() => null);
        set({ phase: 'incoming', callId: active.call.id, role: 'callee', peer, status: 'RINGING', message: null });
        startRingtone();
      }
      return;
    }
    if (!s.callId || s.phase === 'ended' || s.phase === 'idle') return;
    try {
      await realtime.request('call.resume', { call_id: s.callId });
      const st = pc?.iceConnectionState;
      if (s.role === 'caller' && st && st !== 'connected' && st !== 'completed' && st !== 'new') void iceRestart();
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'invalid_call_state' || err.code === 'not_found')) finish('ENDED', null);
    }
  });

  return {
    phase: 'idle',
    callId: null,
    role: null,
    peer: null,
    status: null,
    connectedAt: null,
    muted: false,
    speakerOn: false,
    speakerSupported: supportsSink,
    peerSignalingLost: false,
    message: null,

    async startCall(peer) {
      if (get().phase !== 'idle' && get().phase !== 'ended') return;
      clearTimeout(endedResetTimer);
      set({ phase: 'outgoing', role: 'caller', peer, status: 'INITIATING', callId: null, message: null, connectedAt: null });
      try {
        localStream = await getMic();
      } catch {
        finish('FAILED', 'mic_denied');
        return;
      }
      try {
        const r = await realtime.request<{ call: CallDto; busy: boolean; ice_servers: RTCIceServer[] }>('call.initiate', {
          callee_id: peer.id,
          type: 'voice',
        });
        if (r.busy) return finish('MISSED', 'busy');
        iceServers = r.ice_servers;
        set({ callId: r.call.id, status: r.call.status });
        startRingback();
        createPeer();
        const offer = await pc!.createOffer({ offerToReceiveAudio: true });
        await pc!.setLocalDescription(offer);
        await realtime.request('call.offer', { call_id: r.call.id, sdp: offer.sdp });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Call failed';
        cleanup();
        set({ phase: 'ended', status: 'FAILED', message: msg });
        endedResetTimer = setTimeout(reset, 2500);
      }
    },

    async accept() {
      const s = get();
      if (s.phase !== 'incoming' || !s.callId) return;
      stopTone();
      try {
        localStream = await getMic();
      } catch {
        await realtime.request('call.reject', { call_id: s.callId }).catch(() => undefined);
        return finish('FAILED', 'mic_denied');
      }
      try {
        const r = await realtime.request<{ call: CallDto; offer: string | null; candidates: RTCIceCandidateInit[]; ice_servers: RTCIceServer[] }>(
          'call.accept',
          { call_id: s.callId },
        );
        iceServers = r.ice_servers;
        set({ phase: 'active', status: 'ACCEPTED' });
        createPeer();
        remoteCandidates.push(...r.candidates);
        // If the caller's offer hasn't arrived yet it comes as a call.offer event.
        if (r.offer) await handleOffer(r.offer);
      } catch (err) {
        cleanup();
        set({ phase: 'ended', status: 'FAILED', message: err instanceof Error ? err.message : 'Could not answer' });
        endedResetTimer = setTimeout(reset, 2500);
      }
    },

    async reject() {
      const id = get().callId;
      stopTone();
      if (id) await realtime.request('call.reject', { call_id: id }).catch(() => undefined);
      finish('REJECTED', 'rejected');
    },

    async hangup() {
      const id = get().callId;
      if (id) await realtime.request('call.end', { call_id: id }).catch(() => undefined);
      finish('ENDED', get().status === 'RINGING' || get().status === 'INITIATING' ? 'cancelled' : 'hangup');
    },

    toggleMute() {
      const muted = !get().muted;
      for (const t of localStream?.getAudioTracks() ?? []) t.enabled = !muted;
      set({ muted });
    },

    async toggleSpeaker() {
      // Browsers only allow choosing among output devices; there is no
      // earpiece/speaker distinction on the web.
      if (!supportsSink) return;
      const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
      if (outputs.length < 2) return set({ speakerOn: !get().speakerOn });
      const current = (remoteAudio as HTMLAudioElement & { sinkId?: string }).sinkId ?? 'default';
      const idx = outputs.findIndex((d) => d.deviceId === current);
      const next = outputs[(idx + 1) % outputs.length]!;
      await (remoteAudio as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(next.deviceId);
      set({ speakerOn: next.deviceId !== 'default' });
    },
  };
});
