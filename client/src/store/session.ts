import { create } from 'zustand';
import { auth, refreshSession, type Me } from '../lib/api';
import { realtime } from '../lib/realtime';
import { startSync } from '../lib/sync';

interface SessionState {
  status: 'loading' | 'anon' | 'authed';
  me: Me | null;
  connection: 'offline' | 'connecting' | 'online';
  init(): Promise<void>;
  setMe(me: Me): void;
}

let initialized = false;

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  me: null,
  connection: 'offline',

  async init() {
    if (initialized) return; // StrictMode runs effects twice in development
    initialized = true;
    realtime.onState((connection) => set({ connection }));
    auth.onChange((t) => {
      if (!t) {
        realtime.stop();
        set({ status: 'anon', me: null });
        return;
      }
      const wasAuthed = get().status === 'authed' && get().me?.id === t.user.id;
      set({ status: 'authed', me: { ...get().me, ...t.user } });
      if (!wasAuthed) {
        startSync(t.user.id);
        realtime.start();
      }
    });
    try {
      if (!(await refreshSession())) set({ status: 'anon' });
    } catch {
      // Server unreachable: we can't know; show login but realtime will retry if a token appears.
      set({ status: 'anon' });
    }
  },

  setMe(me) {
    set({ me });
  },
}));
