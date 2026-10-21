/**
 * What the sessions dock and the switcher show: one row per terminal session
 * (open in this window, or a tmux session found on a host), its state,
 * texts, order and grouping.
 *
 * Ported from Jarvis NG (apps/web/src/terminal/dockModel.ts), same owner.
 * Rows are keyed by the open terminal's tag or by `<hostId>/<tmux name>`;
 * there is no "open in another tab" (one window) and no sharing.
 */
import type { TmuxSessionInfo } from '../../../shared/protocol.js';
import type { ConnSnapshot } from './connection.js';

export type RowState = 'live' | 'connecting' | 'down' | 'ended' | 'detached' | 'elsewhere';

export interface DockRow {
  /** The open terminal's tag, or `<hostId>/<tmux name>` for a session found on a host. */
  key: string;
  /** Open in this window. */
  tag: string | null;
  hostId: string | null;
  hostName: string;
  /** The session's own name (alias); empty = none. */
  label: string;
  aliased: boolean;
  /** tmux session name (resumable), or null for a plain shell. */
  session: string | null;
  state: RowState;
  statusText: string;
  statusClass: '' | 'disconnected' | 'connecting';
  folder: string;
  command: string;
  pinned: boolean;
  attention: boolean;
  busy: boolean;
  unread: boolean;
  /** On screen in the visible tab. */
  shown: boolean;
  createdAt: string;
  search: string;
}

export interface OpenTerminal {
  tag: string;
  hostId: string | null;
  hostName: string;
  /** The tmux session it runs in, or the one it is attaching to. */
  session: string | null;
  snapshot: ConnSnapshot;
  shown: boolean;
  createdAt: string;
}

export interface HostSessions {
  hostId: string;
  hostName: string;
  sessions: TmuxSessionInfo[];
}

/** `formatTerminalIdle`. */
export function formatIdle(seconds: number): string {
  if (seconds < 60) return 'active now';
  if (seconds < 3600) return `idle ${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `idle ${Math.floor(seconds / 3600)}h`;
  return `idle ${Math.floor(seconds / 86400)}d`;
}

export function lastSegment(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? '/';
}

export function buildRows(input: {
  open: OpenTerminal[];
  hosts: HostSessions[];
  aliases: Map<string, string>;
  /** Pinned keys: tmux session names, or open terminal tags. */
  pinned: Set<string>;
  forgotten: Set<string>;
}): DockRow[] {
  const { open, hosts, aliases, pinned, forgotten } = input;
  const rows: DockRow[] = [];
  const seen = new Set<string>();
  const found = new Map<string, TmuxSessionInfo>();
  for (const host of hosts) for (const s of host.sessions) found.set(s.name, s);

  for (const terminal of open) {
    if (terminal.session) seen.add(terminal.session);
    rows.push(liveRow(terminal, terminal.session ? found.get(terminal.session) : undefined));
  }
  for (const host of hosts) {
    for (const info of host.sessions) {
      if (seen.has(info.name) || forgotten.has(info.name)) continue;
      seen.add(info.name);
      rows.push(savedRow(host, info));
    }
  }

  function liveRow(terminal: OpenTerminal, info: TmuxSessionInfo | undefined): DockRow {
    const { snapshot } = terminal;
    let state: RowState;
    let statusText: string;
    let statusClass: DockRow['statusClass'] = '';
    switch (snapshot.state) {
      case 'connected':
        state = 'live';
        statusText = snapshot.busy
          ? 'Live · working'
          : snapshot.unread
            ? 'Live · new output'
            : 'Live';
        break;
      case 'connecting':
      case 'host-key':
        state = 'connecting';
        statusText = snapshot.hostKey || snapshot.prompt ? 'Waiting for you' : 'Connecting…';
        statusClass = 'connecting';
        break;
      case 'reconnecting':
        state = 'connecting';
        statusText = snapshot.statusText;
        statusClass = 'connecting';
        break;
      case 'disconnected':
        state = 'down';
        statusText = 'Offline — click to retry';
        statusClass = 'disconnected';
        break;
      case 'denied':
        state = 'down';
        statusText = snapshot.statusText;
        statusClass = 'disconnected';
        break;
      case 'ended':
        state = 'ended';
        statusText = 'Ended — session gone';
        break;
    }
    const label =
      (terminal.session && aliases.get(terminal.session)) || aliases.get(terminal.tag) || '';
    return finish({
      key: terminal.tag,
      tag: terminal.tag,
      hostId: terminal.hostId,
      hostName: terminal.hostName,
      label,
      aliased: label !== '',
      session: terminal.session,
      state,
      statusText,
      statusClass,
      folder: lastSegment(info?.path),
      command: info?.command ?? '',
      pinned: pinned.has(terminal.session ?? terminal.tag),
      attention: snapshot.attention,
      busy: snapshot.busy,
      unread: snapshot.unread && state === 'live',
      shown: terminal.shown,
      createdAt: terminal.createdAt,
    });
  }

  function savedRow(host: HostSessions, info: TmuxSessionInfo): DockRow {
    const label = aliases.get(info.name) ?? '';
    const parts = [
      info.attached > 0 ? 'Open elsewhere' : 'Detached',
      formatIdle(info.idleSeconds),
      ...(info.command ? [info.command] : []),
    ];
    return finish({
      key: `${host.hostId}/${info.name}`,
      tag: null,
      hostId: host.hostId,
      hostName: host.hostName,
      label,
      aliased: label !== '',
      session: info.name,
      state: info.attached > 0 ? 'elsewhere' : 'detached',
      statusText: parts.join(' · '),
      statusClass: '',
      folder: lastSegment(info.path),
      command: info.command,
      pinned: pinned.has(info.name),
      attention: false,
      busy: false,
      unread: false,
      shown: false,
      createdAt: info.createdAt,
    });
  }

  return rows;
}

function finish(row: Omit<DockRow, 'search'>): DockRow {
  return {
    ...row,
    search: [row.label, row.hostName, row.statusText, row.folder, row.command]
      .join(' ')
      .toLowerCase(),
  };
}

/** The name shown on a card: alias, or host name. */
export function rowName(row: DockRow): string {
  return row.aliased ? row.label : row.hostName;
}

/** Inside a host group: un-aliased rows show folder/program. */
export function rowNameInGroup(row: DockRow): string {
  if (!row.aliased) return row.folder || row.command || rowName(row);
  return row.label;
}

const RANK: Record<RowState, number> = {
  live: 2,
  connecting: 2,
  elsewhere: 2,
  detached: 3,
  down: 4,
  ended: 5,
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Pinned (in pin order) → attention → running → down → ended; then host, name. */
export function sortRows(rows: DockRow[], pinOrder: string[]): DockRow[] {
  const pinIndex = (row: DockRow) => {
    const index = pinOrder.indexOf(row.session ?? row.key);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) {
      const byPin = pinIndex(a) - pinIndex(b);
      if (byPin !== 0) return byPin;
      return a.createdAt.localeCompare(b.createdAt);
    }
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    const byRank = RANK[a.state] - RANK[b.state];
    if (byRank !== 0) return byRank;
    const byHost = collator.compare(a.hostName, b.hostName);
    if (byHost !== 0) return byHost;
    const byName = collator.compare(rowName(a), rowName(b));
    if (byName !== 0) return byName;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Fuzzy subsequence match (`terminalFuzzyScore`): lower is better, -1 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const direct = text.indexOf(q);
  if (direct !== -1) return direct;
  let position = -1;
  let gaps = 0;
  for (const char of q) {
    if (char === ' ') continue;
    const next = text.indexOf(char, position + 1);
    if (next === -1) return -1;
    gaps += next - position - 1;
    position = next;
  }
  return 1000 + gaps;
}

/** Rows matching `query`, best first; all rows (in order) for an empty query. */
export function filterRows<T extends { search: string }>(rows: T[], query: string): T[] {
  if (!query.trim()) return rows;
  return rows
    .map((row, index) => ({ row, index, score: fuzzyScore(query, row.search) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.row);
}

export interface RowGroup {
  hostId: string;
  name: string;
  rows: DockRow[];
}

/** Groups by host, in order of first appearance (only used with ≥ 2 hosts). */
export function groupRows(rows: DockRow[]): RowGroup[] {
  const groups: RowGroup[] = [];
  for (const row of rows) {
    const hostId = row.hostId ?? `adhoc:${row.hostName}`;
    let group = groups.find((g) => g.hostId === hostId);
    if (!group) {
      group = { hostId, name: row.hostName, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

/** "1 live · 9 detached". */
export function summarize(rows: DockRow[]): {
  text: string;
  counts: Record<'live' | 'detached' | 'down' | 'ended', number>;
} {
  const counts = { live: 0, detached: 0, down: 0, ended: 0 };
  for (const row of rows) {
    if (row.state === 'live' || row.state === 'connecting') counts.live++;
    else if (row.state === 'down') counts.down++;
    else if (row.state === 'ended') counts.ended++;
    else counts.detached++;
  }
  const parts = [
    counts.live && `${counts.live} live`,
    counts.detached && `${counts.detached} detached`,
    counts.down && `${counts.down} down`,
    counts.ended && `${counts.ended} ended`,
  ].filter(Boolean);
  return { text: parts.join(' · ') || 'No sessions', counts };
}

/** The switcher's dot colour for a row. */
export function dotClass(row: DockRow): string {
  switch (row.state) {
    case 'detached':
    case 'elsewhere':
      return 'detached';
    case 'down':
      return 'down';
    case 'ended':
      return 'ended';
    case 'connecting':
      return 'connecting';
    default:
      return '';
  }
}
