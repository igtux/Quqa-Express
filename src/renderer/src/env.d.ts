import type { QuqaApi } from '../../shared/ipc.js';

declare global {
  interface Window {
    readonly quqa: QuqaApi;
    /** Present only when the app runs for the UI smoke test. */
    __quqaTest?: {
      text(): string;
      state(): string;
      renderer(): string;
    };
  }
}
