/** Pastes larger than this are typed in slices, so the host is not flooded. */
export const PASTE_CHUNK = 4096;
/** Pause between slices. */
export const PASTE_INTERVAL_MS = 15;

/** Splits text into slices of at most `size` UTF-16 units, never inside a surrogate pair. */
export function sliceInput(text: string, size = PASTE_CHUNK): string[] {
  const slices: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
    }
    slices.push(text.slice(start, end));
    start = end;
  }
  return slices;
}

/** Automatic reconnect: 1, 2, 4, 8, 16, 30 s with ±20 % jitter, then give up. */
export const RECONNECT_DELAYS_S = [1, 2, 4, 8, 16, 30];

/** Delay before reconnect attempt `attempt` (0-based), or null when attempts are used up. */
export function reconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number | null {
  const base = RECONNECT_DELAYS_S[attempt];
  if (base === undefined) return null;
  return Math.round(base * 1000 * (0.8 + random() * 0.4));
}
