/**
 * Keyboard shortcuts that work in every layout. With a Georgian (or Russian,
 * Greek…) layout the V key reports `key: "ვ"`, so letter checks miss Ctrl+V;
 * `code` names the physical key. `key` is still accepted for layouts that
 * move letters (Dvorak's V is not on the QWERTY V key).
 *
 * Ported from Jarvis NG (apps/web/src/kit/keys.ts), same owner.
 */
export function isLetterKey(event: KeyboardEvent, letter: string): boolean {
  const lower = letter.toLowerCase();
  return event.code === `Key${lower.toUpperCase()}` || event.key.toLowerCase() === lower;
}

/** Digit 1–9 by physical key (Alt+Shift changes `key` on many layouts). */
export function digitKey(event: KeyboardEvent): number | null {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
  return match ? Number(match[1]) : null;
}

/**
 * Ctrl+= / Ctrl+- / Ctrl+0 by physical key as well: on some layouts these
 * keys type other characters (the French layout's 0 key is "à").
 */
export function zoomKey(event: KeyboardEvent): 1 | -1 | 'reset' | null {
  const { key, code } = event;
  if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') return 1;
  if (key === '-' || code === 'Minus' || code === 'NumpadSubtract') return -1;
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'reset';
  return null;
}

/** Focus is in a text field or the terminal (where plain Ctrl+K belongs to the shell). */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm',
    ),
  );
}
