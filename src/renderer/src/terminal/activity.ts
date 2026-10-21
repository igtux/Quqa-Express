/**
 * Agent activity heuristics: Claude Code (and similar) shows working markers
 * while it works; when they stop after real work, the agent finished (or
 * waits for an answer). A choice prompt ("Do you want to proceed?") asks for
 * the user at once.
 *
 * Ported from Jarvis NG (apps/web/src/terminal/connection.ts: BUSY_RE,
 * CHOICE_RE, endBusyIfQuiet, stopBusy), same owner, as a class with an
 * injectable clock so it can be tested without a terminal.
 */

/** Claude Code (and similar) while busy. */
export const BUSY_RE = /esc to interrupt|Thinking…|Working…|✻|✽|✶/;
/** Working ends this long after the last working marker, however much other output follows. */
export const BUSY_QUIET_MS = 4000;
/** Markers seen over at least this long count as real work (a redraw shows them in one burst). */
export const MIN_WORK_MS = 3000;
/** Kept from the previous chunk so a marker split across chunks is still seen. */
const MATCH_TAIL = 48;
export const CHOICE_RE = /❯\s*1\.|Do you want to (proceed|make this edit|create)|\(y\/n\)/i;

export interface ActivityEvents {
  busy(busy: boolean): void;
  /** The agent stopped after working for a while. */
  finished(): void;
  /** A prompt asks the user to choose. */
  choice(): void;
}

export class ActivityTracker {
  private tail = '';
  private busySince: number | null = null;
  private lastMarkAt = 0;

  constructor(
    private readonly events: ActivityEvents,
    private readonly now: () => number = Date.now,
  ) {}

  get busy(): boolean {
    return this.busySince !== null;
  }

  /** Decoded output text. */
  output(text: string): void {
    const seen = this.tail + text;
    this.tail = seen.slice(-MATCH_TAIL);
    if (BUSY_RE.test(seen)) {
      const now = this.now();
      this.lastMarkAt = now;
      if (this.busySince === null) {
        this.busySince = now;
        this.events.busy(true);
      }
    }
    if (CHOICE_RE.test(seen)) this.events.choice();
  }

  /** Called about once a second while busy: ends "working" after a quiet spell. */
  tick(): void {
    if (this.busySince === null || this.now() - this.lastMarkAt < BUSY_QUIET_MS) return;
    this.stop(true);
  }

  /** The connection dropped or the terminal closed: not a finish. */
  reset(): void {
    this.tail = '';
    this.stop(false);
  }

  private stop(finished: boolean) {
    if (this.busySince === null) return;
    const worked = this.lastMarkAt - this.busySince >= MIN_WORK_MS;
    this.busySince = null;
    this.events.busy(false);
    if (finished && worked) this.events.finished();
  }
}
