import { create } from 'zustand';
import { api } from '../lib/api';
import { realtime } from '../lib/realtime';
import type { Profile, StatusItem } from '../lib/types';

export interface StatusGroup {
  user: Profile;
  statuses: StatusItem[];
  latest_at: string;
  all_viewed: boolean;
}

interface StatusState {
  mine: StatusItem[];
  updates: StatusGroup[];
  loaded: boolean;
  load(): Promise<void>;
  markViewed(id: string): Promise<void>;
}

export const useStatus = create<StatusState>((set, get) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reloadSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void get().load(), 300);
  };
  realtime.on('status.updated', reloadSoon);
  realtime.on('status.deleted', reloadSoon);
  realtime.on('status.viewed', (e) =>
    set((s) => ({
      mine: s.mine.map((m) => (m.id === e.payload.status_id ? { ...m, view_count: (m.view_count ?? 0) + 1 } : m)),
    })),
  );
  realtime.onOpen(() => {
    if (get().loaded) reloadSoon();
  });

  return {
    mine: [],
    updates: [],
    loaded: false,
    async load() {
      const r = await api<{ mine: StatusItem[]; updates: StatusGroup[] }>('GET', '/api/status');
      set({ mine: r.mine, updates: r.updates, loaded: true });
    },
    async markViewed(id) {
      set((s) => ({
        updates: s.updates.map((g) => {
          const statuses = g.statuses.map((x) => (x.id === id ? { ...x, viewed: true } : x));
          return { ...g, statuses, all_viewed: statuses.every((x) => x.viewed) };
        }),
      }));
      await api('POST', `/api/status/${id}/view`).catch(() => undefined);
    },
  };
});
