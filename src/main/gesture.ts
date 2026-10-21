/**
 * Clipboard reads need a user gesture. Main reads the clipboard for the page
 * (text for a paste, an image or copied files to upload), but only right
 * after the user pressed a key or clicked in the window, so a page that went
 * wrong (or a terminal program) can never read the clipboard on its own.
 * Main sees the input itself (`webContents` `input-event`), so the page cannot
 * fake a gesture.
 */
const GESTURE_TYPES = new Set([
  'rawKeyDown',
  'keyDown',
  'mouseDown',
  'contextMenu',
  'pointerDown',
  'gestureTap',
]);

/** How long after a key press or click a clipboard read is still allowed. */
export const GESTURE_WINDOW_MS = 3000;

export class UserGesture {
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  /** Records an input event the window received. */
  note(type: string): void {
    if (GESTURE_TYPES.has(type)) this.last = this.now();
  }

  /** True while a clipboard read may follow the last key press or click. */
  recent(): boolean {
    const age = this.now() - this.last;
    return age >= 0 && age <= GESTURE_WINDOW_MS;
  }
}
