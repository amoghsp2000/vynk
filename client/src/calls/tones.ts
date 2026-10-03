/** Ring and ringback tones synthesised with WebAudio (no audio assets needed). */
let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function beep(freqs: number[], ms: number, gain = 0.08) {
  ctx ??= new AudioContext();
  const t0 = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
  g.gain.setValueAtTime(gain, t0 + ms / 1000 - 0.05);
  g.gain.linearRampToValueAtTime(0, t0 + ms / 1000);
  g.connect(ctx.destination);
  for (const f of freqs) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    o.start(t0);
    o.stop(t0 + ms / 1000);
  }
}

export function startRingtone() {
  stopTone();
  const ring = () => {
    beep([660, 880], 350, 0.12);
    setTimeout(() => beep([660, 880], 350, 0.12), 450);
  };
  ring();
  timer = setInterval(ring, 2500);
}

export function startRingback() {
  stopTone();
  const ring = () => beep([440, 480], 1200, 0.05);
  ring();
  timer = setInterval(ring, 3500);
}

export function stopTone() {
  clearInterval(timer);
  timer = undefined;
}
