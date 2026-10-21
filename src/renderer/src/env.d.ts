import type { QuqaApi } from '../../shared/ipc.js';

declare global {
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
    };
  }
}
