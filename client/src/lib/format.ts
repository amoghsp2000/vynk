const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

export function timeOfDay(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Chat list style: time today, "Yesterday", weekday this week, else date. */
export function shortWhen(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return timeOfDay(iso);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * 86_400_000) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString();
}

export function dayLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function lastSeen(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  return `last seen ${sameDay(d, new Date()) ? 'today' : shortWhen(iso).toLowerCase()} at ${timeOfDay(iso)}`;
}

export function duration(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const displayName = (p: { name: string; contact_name?: string | null } | null | undefined) =>
  p ? (p.contact_name ?? p.name) : 'Unknown';
