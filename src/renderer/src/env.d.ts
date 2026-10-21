import type { QuqaApi } from '../../shared/ipc.js';

declare global {
  /** The app version from package.json (set at build time). */
  const __APP_VERSION__: string;
  interface Window {
    readonly quqa: QuqaApi;
    /** Present only when the app runs for the UI smoke test. */
    __quqaTest?: {
      /** The active terminal's text. */
      text(): string;
      state(): string;
      renderer(): string;
      tmux(): string | null;
      tabs(): number;
      panes(): number;
      /** The active terminal is a local shell. */
      local(): boolean;
      /** The window title its program set. */
      title(): string;
      /** Switch the active terminal to xterm's DOM renderer. */
      useDomRenderer(): void;
    };
  }
}
