/**
 * Host list helpers for the hosts screen: search, groups, latency texts and
 * relative times. Latency and time texts follow Jarvis NG
 * (apps/web/src/machines/common.tsx), same owner.
 */
import type { HostInfo, LatencyResult } from '../../../shared/ipc.js';
import { fuzzyScore } from '../terminal/dockModel.js';

export type HostStatus = 'online' | 'offline' | 'checking' | 'unknown';

export interface Latency {
  ms: number | null;
  error: string | null;
  at: number;
}

/** Latency results are reused this long. */
export const LATENCY_TTL_MS = 20_000;

export function hostStatus(entry: Latency | undefined, checking: boolean): HostStatus {
  if (checking) return 'checking';
  if (!entry) return 'unknown';
  return entry.ms !== null ? 'online' : 'offline';
}

export function latencyClass(entry: Latency | undefined): string {
  if (!entry) return '';
  if (entry.ms === null) return 'timeout';
  return entry.ms < 50 ? 'fast' : entry.ms < 150 ? 'medium' : 'slow';
}

export function latencyText(entry: Latency | undefined): string {
  if (!entry) return '--';
  if (entry.ms === null) return entry.error ?? 'Offline';
  return `${Math.round(entry.ms)} ms`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function destination(host: Pick<HostInfo, 'username' | 'address' | 'port'>): string {
  const address = host.address.includes(':') ? `[${host.address}]` : host.address;
  return `${host.username}@${address}${host.port === 22 ? '' : `:${host.port}`}`;
}

export function hostSearchText(host: HostInfo): string {
  return [host.name, host.address, host.username, host.group, ...host.tags].join(' ').toLowerCase();
}

/** Hosts matching the query (fuzzy), best first; `tag:x` and `group:x` filter exactly. */
export function filterHosts(hosts: HostInfo[], query: string): HostInfo[] {
  let rest = query.trim();
  let list = hosts;
  for (const match of query.matchAll(/(?:^|\s)(tag|group):("[^"]*"|\S+)/gi)) {
    const kind = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').replace(/^"|"$/g, '').toLowerCase();
    list = list.filter((host) =>
      kind === 'tag' ? host.tags.includes(value) : host.group.toLowerCase() === value,
    );
    rest = rest.replace(match[0].trim(), '').trim();
  }
  if (!rest) return list;
  return list
    .map((host, index) => ({ host, index, score: fuzzyScore(rest, hostSearchText(host)) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.host);
}

export interface HostGroup {
  name: string;
  hosts: HostInfo[];
}

/** Named groups alphabetically, then "Ungrouped" (name ''). */
export function groupHosts(hosts: HostInfo[]): HostGroup[] {
  const groups = new Map<string, HostInfo[]>();
  for (const host of hosts) groups.set(host.group, [...(groups.get(host.group) ?? []), host]);
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([name, list]) => ({ name, hosts: list }));
}

export function toLatency(result: LatencyResult, at = Date.now()): Latency {
  return { ms: result.ms, error: result.error, at };
}

/** `user@host:port` (also `host`, `[v6]:port`) for Quick Connect. */
export function splitDestination(value: string): {
  host?: string;
  username?: string;
  port?: number;
} {
  const match = /^(?:([^@\s]+)@)?(\[[0-9A-Fa-f:.]+\]|[^:\s@]+)(?::(\d{1,5}))?$/.exec(value.trim());
  if (!match) return {};
  const [, username, host, port] = match;
  return {
    ...(host !== undefined && { host: host.replace(/^\[(.*)\]$/, '$1') }),
    ...(username !== undefined && { username }),
    ...(port !== undefined && { port: Number(port) }),
  };
}

/** Comma- or space-separated tags, normalised as the engine stores them. */
export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\s]+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
