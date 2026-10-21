/**
 * Jump hosts: which saved hosts a connection goes through, in order. A host
 * names its jump host by id, or (when it has none) by the `ProxyJump` line
 * it was imported with from ~/.ssh/config. Every hop must be a saved host,
 * so it brings its own login and its own pinned host key; loops and overly
 * long chains are refused.
 */
import type { HostInfo } from '../shared/ipc.js';

export const MAX_HOPS = 8;

export class JumpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JumpError';
  }
}

/** One `ProxyJump` entry: `[user@]host[:port]`, `[user@][v6]:port` or `ssh://user@host:port`. */
export function parseJumpSpec(text: string): { user: string; host: string; port: number | null } {
  let spec = text.trim().replace(/^ssh:\/\//i, '');
  let user = '';
  const at = spec.lastIndexOf('@');
  if (at >= 0) {
    user = spec.slice(0, at);
    spec = spec.slice(at + 1);
  }
  let host = spec;
  let port: number | null = null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(spec);
  if (bracketed) {
    host = bracketed[1] ?? '';
    port = bracketed[2] ? Number(bracketed[2]) : null;
  } else {
    const colon = /^([^:]+):(\d+)$/.exec(spec);
    if (colon) {
      host = colon[1] ?? '';
      port = Number(colon[2]);
    }
  }
  if (!host || (port !== null && !(port >= 1 && port <= 65535))) {
    throw new JumpError(`"${text.slice(0, 80)}" is not a valid ProxyJump entry`);
  }
  return { user, host, port };
}

/** The saved host a `ProxyJump` entry means: by name (the ssh config alias), else by address. */
export function matchJumpHost(text: string, hosts: readonly HostInfo[]): HostInfo {
  const { user, host, port } = parseJumpSpec(text);
  const name = host.toLowerCase();
  const fits = (h: HostInfo) =>
    (port === null || h.port === port) && (user === '' || h.username === user);
  const found =
    hosts.find((h) => h.name.toLowerCase() === name && fits(h)) ??
    hosts.find((h) => h.address.toLowerCase() === name && fits(h)) ??
    hosts.find((h) => h.name.toLowerCase() === name);
  if (!found) {
    throw new JumpError(
      `The jump host "${text.slice(0, 80)}" (ProxyJump) is not a saved host; add or import it first`,
    );
  }
  return found;
}

/** The hosts `host` connects through directly, nearest last (empty: a direct connection). */
function directJumps(host: HostInfo, hosts: readonly HostInfo[]): HostInfo[] {
  if (host.jumpHostId !== null) {
    const jump = hosts.find((h) => h.id === host.jumpHostId);
    if (!jump) throw new JumpError(`The jump host of ${host.name} is no longer saved`);
    return [jump];
  }
  const proxy = host.proxyJump.trim();
  if (proxy === '' || proxy.toLowerCase() === 'none') return [];
  return proxy
    .split(',')
    .filter((part) => part.trim() !== '')
    .map((part) => matchJumpHost(part, hosts));
}

/**
 * Every hop before `target`, first hop first. The first hop's own jump
 * settings are followed too (as OpenSSH does), so chains can be built from
 * single links.
 */
export function resolveChain(target: HostInfo, hosts: readonly HostInfo[]): HostInfo[] {
  const chain: HostInfo[] = [];
  const seen = new Set<string>([target.id]);
  let next = directJumps(target, hosts);
  while (next.length > 0) {
    for (const hop of next) {
      if (seen.has(hop.id)) {
        throw new JumpError(`The jump hosts of ${target.name} form a loop through ${hop.name}`);
      }
      seen.add(hop.id);
    }
    chain.unshift(...next);
    if (chain.length > MAX_HOPS) {
      throw new JumpError(`More than ${MAX_HOPS} jump hosts for ${target.name}`);
    }
    const first = next[0];
    next = first ? directJumps(first, hosts) : [];
  }
  return chain;
}
