/**
 * The notice island's model: short notices (copied, uploaded, an error) and
 * the live transfers (uploads and downloads with progress, Cancel, Resume).
 *
 * Ported from Jarvis NG (apps/web/src/terminal/notices.ts: kinds, linger
 * times, at most three on screen, the leaving animation), same owner, as a
 * plain store the workspace owns instead of a React hook; transfers come from
 * the engine's `transfer` events.
 */
import type { TransferEvent } from '../../../shared/protocol.js';

export type NoticeKind = 'progress' | 'info' | 'success' | 'error';

export interface NoticeAction {
  label: string;
  run(): void;
}

export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
  /** Second line, e.g. the target folder. */
  detail?: string;
  /** 0..1 while running; null for indeterminate. */
  progress?: number | null;
  leaving?: boolean;
  actions?: NoticeAction[];
  /** The transfer this notice shows. */
  transfer?: string;
}

const LINGER_MS: Record<NoticeKind, number | null> = {
  progress: null,
  info: 2600,
  success: 2600,
  error: 8000,
};
const EXIT_MS = 260;
const MAX_NOTICES = 4;

export interface TransferControls {
  cancel(transfer: TransferEvent): void;
  resume(transfer: TransferEvent): void;
}

export class Notices {
  notices: Notice[] = [];
  readonly transfers = new Map<string, TransferEvent>();
  private nextId = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly controls: TransferControls) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  notice(text: string, kind: NoticeKind = 'info', extra: Partial<Notice> = {}): number {
    const id = ++this.nextId;
    this.notices = [...this.notices.filter((n) => !n.leaving), { ...extra, id, kind, text }];
    // Too many: drop the oldest that is not a running transfer.
    while (this.notices.length > MAX_NOTICES) {
      const index = this.notices.findIndex((n) => n.kind !== 'progress');
      this.notices.splice(index === -1 ? 0 : index, 1);
    }
    this.schedule(id, kind);
    this.changed();
    return id;
  }

  update(id: number, patch: Partial<Omit<Notice, 'id'>>): void {
    let found = false;
    this.notices = this.notices.map((n) => {
      if (n.id !== id) return n;
      found = true;
      return { ...n, ...patch };
    });
    if (!found) return;
    if (patch.kind) this.schedule(id, patch.kind);
    this.changed();
  }

  dismiss(id: number): void {
    clearTimeout(this.timers.get(id));
    this.notices = this.notices.map((n) => (n.id === id ? { ...n, leaving: true } : n));
    this.changed();
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.notices = this.notices.filter((n) => n.id !== id);
        this.changed();
      }, EXIT_MS),
    );
  }

  private schedule(id: number, kind: NoticeKind) {
    clearTimeout(this.timers.get(id));
    const linger = LINGER_MS[kind];
    if (linger !== null)
      this.timers.set(
        id,
        setTimeout(() => this.dismiss(id), linger),
      );
  }

  /* ----- Transfers ------------------------------------------------------- */

  /** An engine `transfer` event: create or update its notice. */
  onTransfer(transfer: TransferEvent): void {
    this.transfers.set(transfer.id, transfer);
    const view = transferNotice(transfer, this.controls);
    const existing = this.notices.find((n) => n.transfer === transfer.id && !n.leaving);
    if (existing) this.update(existing.id, view);
    else this.notice(view.text, view.kind, view);
    if (transfer.state === 'done' || transfer.state === 'cancelled') {
      // Kept a while for "the last transfers", then forgotten.
      setTimeout(() => this.transfers.delete(transfer.id), 60_000);
    }
  }

  /** Removes the cards of these transfers (another notice speaks for them). */
  dropTransfers(ids: readonly string[]): void {
    const before = this.notices.length;
    this.notices = this.notices.filter((n) => !n.transfer || !ids.includes(n.transfer));
    if (this.notices.length !== before) this.changed();
  }

  /** Running and stopped transfers (the island shows at most a few of them). */
  activeTransfers(): TransferEvent[] {
    return [...this.transfers.values()].filter(
      (t) => t.state === 'running' || t.state === 'interrupted',
    );
  }
}

/** How a transfer looks on the island. */
export function transferNotice(
  transfer: TransferEvent,
  controls: TransferControls,
): Omit<Notice, 'id'> {
  const verb = transfer.direction === 'upload' ? 'Upload' : 'Download';
  const where =
    transfer.direction === 'upload'
      ? `to ${dirname(transfer.remotePath)}`
      : `from ${dirname(transfer.remotePath)}`;
  const size = `${formatBytes(transfer.bytes)} of ${formatBytes(transfer.total)}`;
  const base = { transfer: transfer.id };
  switch (transfer.state) {
    case 'running':
      return {
        ...base,
        kind: 'progress',
        text: `${transfer.direction === 'upload' ? 'Uploading' : 'Downloading'} ${transfer.name}`,
        detail: `${size} · ${where}`,
        progress: transfer.total > 0 ? Math.min(1, transfer.bytes / transfer.total) : null,
        actions: [{ label: 'Cancel', run: () => controls.cancel(transfer) }],
      };
    case 'interrupted':
      return {
        ...base,
        kind: 'progress',
        text: `${verb} of ${transfer.name} paused`,
        detail: transfer.error || size,
        progress: transfer.total > 0 ? Math.min(1, transfer.bytes / transfer.total) : null,
        actions: [
          { label: 'Resume', run: () => controls.resume(transfer) },
          { label: 'Cancel', run: () => controls.cancel(transfer) },
        ],
      };
    case 'done':
      return {
        ...base,
        kind: 'success',
        text:
          transfer.direction === 'upload'
            ? `Uploaded ${transfer.name}`
            : `Downloaded ${transfer.name}`,
        detail: `${formatBytes(transfer.total)} · ${where}`,
        progress: 1,
        actions: [],
      };
    case 'cancelled':
      return {
        ...base,
        kind: 'info',
        text: `${verb} of ${transfer.name} cancelled`,
        detail: transfer.error || where,
        actions: [],
      };
    case 'failed':
      return {
        ...base,
        kind: 'error',
        text: `${verb} of ${transfer.name} failed`,
        detail: transfer.error || where,
        actions: [{ label: 'Retry', run: () => controls.resume(transfer) }],
      };
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '–';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
