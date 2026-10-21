/**
 * Resumable sessions: the commands the engine runs for tmux on a host, and
 * the parsers for their output.
 *
 * Only the engine's own session names (`quqa-<32 hex>`) are ever used, and
 * every command is built here with the quoting helper, so nothing the
 * renderer sends becomes shell text. A terminal runs
 * `tmux new-session -A -s <name>` (create or re-attach) in a PTY; listing,
 * ending and history (copy-mode) run as separate exec commands.
 *
 * Ported from Jarvis NG (apps/ssh-gateway/src/terminals/tmux-attach.ts, `own`
 * mode only, terminal-relay.ts and tmux-history.ts), same owner.
 */
import type { TmuxSessionInfo } from '../shared/protocol.js';
import { sh } from './shell.js';

export const TMUX_NAME = /^quqa-[0-9a-f]{32}$/;
export const MAX_TMUX_SESSIONS = 20;
/** Largest scroll in one history command. */
export const MAX_SCROLL_LINES = 500;

const NO_TMUX = '__quqa_no_tmux__';
const FIELDS = [
  '#{session_name}',
  '#{session_attached}',
  '#{session_created}',
  '#{session_activity}',
  '#{pane_current_command}',
  '#{pane_current_path}',
];
/** tmux replaces control characters (a tab) in its output, so the separator is printable. */
const SEPARATOR = '|';
const LIST_FORMAT = FIELDS.join(SEPARATOR);

function checked(name: string): string {
  if (!TMUX_NAME.test(name)) throw new Error('Invalid tmux session name');
  return name;
}

/**
 * Lets programs inside tmux (e.g. Claude Code) copy to the clipboard through
 * OSC 52 (the app still asks before writing it), including the passthrough
 * envelope Claude Code wraps it in. Chained after the attach in the same
 * tmux call so it reaches the server that call created or joined.
 */
const CLIPBOARD_ON = [
  'set-option',
  '-s',
  'set-clipboard',
  'on',
  ';',
  'set-option',
  '-g',
  'allow-passthrough',
  'on',
] as const;

/** The PTY command of a resumable terminal: create the session or re-attach to it. */
export function attachCommand(name: string): string {
  return sh`tmux new-session -A -s ${checked(name)} ${';'} ${CLIPBOARD_ON}`.text;
}

/** Ends a session ("=" asks for an exact name, not a prefix). */
export function killCommand(name: string): string {
  return sh`tmux kill-session -t ${`=${checked(name)}`}`.text;
}

/**
 * Prints the marker when tmux is missing, else one line per session (none
 * when no server runs). Wrapped in `sh -c` so it means the same whatever the
 * user's login shell is (fish, for one, has no `{ …; }`).
 */
export function listCommand(): string {
  const script = `command -v tmux >/dev/null 2>&1 || { echo ${NO_TMUX}; exit 0; }; ${
    sh`tmux list-sessions -F ${LIST_FORMAT}`.text
  } 2>/dev/null; exit 0`;
  return sh`sh -c ${script}`.text;
}

/** Parses `listCommand` output: only quqa sessions, newest first. */
export function parseList(
  output: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { available: boolean; sessions: TmuxSessionInfo[] } {
  if (output.split('\n').some((line) => line.trim() === NO_TMUX)) {
    return { available: false, sessions: [] };
  }
  const sessions: TmuxSessionInfo[] = [];
  for (const line of output.split('\n')) {
    const parts = line.replace(/\r$/, '').split(SEPARATOR);
    if (parts.length < FIELDS.length) continue;
    const [name = '', attached, created, activity, command = ''] = parts;
    // The path is last and may itself contain the separator.
    const path = parts.slice(FIELDS.length - 1).join(SEPARATOR);
    if (!TMUX_NAME.test(name)) continue;
    const createdAt = Number(created);
    const activityAt = Number(activity);
    sessions.push({
      name,
      attached: Math.max(0, Number(attached) || 0),
      createdAt: Number.isFinite(createdAt) ? new Date(createdAt * 1000).toISOString() : '',
      idleSeconds: Number.isFinite(activityAt) ? Math.max(0, nowSeconds - activityAt) : 0,
      path: printable(path, 1024),
      command: printable(command, 64),
    });
    if (sessions.length >= 200) break;
  }
  sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { available: true, sessions };
}

export type HistoryAction = 'enter' | 'exit' | 'scroll';

/** What tmux reports after each history action. */
export interface HistoryState {
  inMode: boolean;
  /** Lines scrolled up from the bottom (0 at the live end). */
  position: number;
  size: number;
}

const STATE_FORMAT = '#{?pane_in_mode,1,0} #{scroll_position} #{history_size}';

/** One history action on a session, followed by a state report. */
export function historyScript(name: string, action: HistoryAction, lines = 0): string {
  const target = `=${checked(name)}:`;
  const report = sh`tmux display-message -p -t ${target} ${STATE_FORMAT}`.text;
  if (action === 'enter') return `${sh`tmux copy-mode -t ${target}`.text} 2>/dev/null; ${report}`;
  if (action === 'exit') {
    return `${sh`tmux send-keys -t ${target} -X cancel`.text} 2>/dev/null; ${report}`;
  }
  const count = Math.min(MAX_SCROLL_LINES, Math.abs(Math.trunc(lines)));
  if (count === 0) return report;
  const command = lines < 0 ? 'scroll-up' : 'scroll-down';
  return `${sh`tmux send-keys -t ${target} -N ${String(count)} -X ${command}`.text} 2>/dev/null; ${report}`;
}

export function parseHistoryState(output: string): HistoryState | null {
  const match = /^([01]) (\d*) (\d+)$/.exec(output.trim());
  if (!match) return null;
  return {
    inMode: match[1] === '1',
    position: match[2] ? Number(match[2]) : 0,
    size: Number(match[3]),
  };
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function printable(text: string, max: number): string {
  return text.replace(CONTROL, '').slice(0, max);
}
