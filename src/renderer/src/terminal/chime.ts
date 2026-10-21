/**
 * A short two-note chime made with Web Audio (no sound files, nothing
 * fetched). Jarvis NG's synthesized fallback (apps/web/src/terminal/bell.ts),
 * same owner; its sound packs are not bundled.
 */
let context: AudioContext | null = null;

export function playChime(volume = 0.25): void {
  try {
    context ??= new AudioContext();
    const ctx = context;
    const start = ctx.currentTime;
    for (const [index, frequency] of [880, 1318.5].entries()) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      const at = start + index * 0.12;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(volume, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.4);
    }
  } catch {
    // No audio device.
  }
}
