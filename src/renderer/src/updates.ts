/**
 * The renderer's view of the update check (main does the checking, see
 * src/main/updater.ts): a small store the top bar, the update panel and the
 * About dialog share. It asks main for the state now and then (a local call,
 * no network) and often while a download runs.
 */
import { useSyncExternalStore } from 'react';
import type { UpdateState } from '../../shared/ipc.js';
import { call } from './api.js';

let state: UpdateState | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function set(next: UpdateState) {
  state = next;
  for (const listener of listeners) listener();
  schedule();
}

function schedule() {
  clearTimeout(timer);
  const busy = state !== null && (state.checking || state.phase !== 'idle');
  // Main's first check runs a few seconds after start.
  const waiting = state !== null && state.autoUpdate && state.checkedAt === null;
  timer = setTimeout(() => void refresh(), busy ? 700 : waiting ? 3000 : 5 * 60_000);
}

async function refresh() {
  try {
    set(await call('updates.status', {}));
  } catch {
    schedule();
  }
}

export const updates = {
  start(): void {
    if (state === null) void refresh();
  },
  async check(): Promise<void> {
    if (state) set({ ...state, checking: true });
    set(await call('updates.check', {}));
  },
  async install(): Promise<void> {
    set(await call('updates.install', {}));
  },
  async skip(version: string): Promise<void> {
    set(await call('updates.skip', { version }));
  },
  async setAuto(autoUpdate: boolean): Promise<void> {
    await call('app.setSettings', { autoUpdate });
    await refresh();
  },
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdates(): UpdateState | null {
  return useSyncExternalStore(subscribe, () => state);
}
