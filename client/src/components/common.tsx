import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useMediaUrl } from '../lib/media';
import type { MsgStatus } from '../lib/types';
import { Icon } from './Icon';

const PALETTE = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e', '#ef4444'];
const colorFor = (seed: string) => PALETTE[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

export function Avatar({
  name,
  photoId,
  seed,
  size = 46,
  online,
  ring,
}: {
  name: string;
  photoId?: string | null;
  seed?: string;
  size?: number;
  online?: boolean | null;
  ring?: 'new' | 'seen';
}) {
  const url = useMediaUrl(photoId);
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div
      className={`avatar${ring ? ` ring${ring === 'seen' ? ' seen' : ''}` : ''}`}
      style={{ width: size, height: size, background: url ? 'transparent' : colorFor(seed ?? name), fontSize: size * 0.38 }}
    >
      {url ? <img src={url} alt="" /> : initials || '?'}
      {online && <span className="dot" />}
    </div>
  );
}

export function Ticks({ status }: { status: MsgStatus | null }) {
  if (status === 'pending') return <Icon name="clock" className="ticks" title="Sending" />;
  if (status === 'failed') return <Icon name="alert" className="ticks" title="Not sent" />;
  if (status === 'read') return <Icon name="checks" className="ticks read" title="Read" />;
  if (status === 'delivered') return <Icon name="checks" className="ticks" title="Delivered" />;
  return <Icon name="check" className="ticks" title="Sent" />;
}

const EMOJI =
  '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😜 🤪 🤗 🤔 🤨 😐 😏 😒 🙄 😬 😌 😴 🤒 🤯 🥳 😎 🤓 😕 😟 😮 😲 😳 🥺 😢 😭 😱 😤 😡 👍 👎 👏 🙌 🙏 💪 👋 🤝 ✌️ 🤞 👌 👀 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 💯 ✨ 🔥 🎉 🎂 🎁 ☕ 🍕 🍔 🍿 ⚽ 🏀 🎵 📞 📷 ⏰ ✅ ❌ ⭐ 🌙 ☀️ 🌧️ 🌈 🐶 🐱'.split(
    ' ',
  );

export function EmojiPicker({ onPick }: { onPick: (e: string) => void }) {
  return (
    <div className="emoji-panel" role="listbox" aria-label="Emoji">
      {EMOJI.map((e) => (
        <button key={e} type="button" onClick={() => onPick(e)} aria-label={e}>
          {e}
        </button>
      ))}
    </div>
  );
}

// ---- toast ----
const useToastStore = create<{ text: string | null; show(t: string): void }>((set) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    text: null,
    show(text) {
      clearTimeout(timer);
      set({ text });
      timer = setTimeout(() => set({ text: null }), 3500);
    },
  };
});
export const toast = (t: string) => useToastStore.getState().show(t);
export function Toast() {
  const text = useToastStore((s) => s.text);
  return text ? <div className="toast" role="status">{text}</div> : null;
}

/** Re-renders every `ms` (for relative times, call timers, typing expiry). */
export function useTick(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
