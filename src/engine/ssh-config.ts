/**
 * Reads an OpenSSH client config (~/.ssh/config) for the host import.
 *
 * Only Host, HostName, User, Port, IdentityFile and ProxyJump are used. As in
 * ssh, the first value found for a keyword wins, and a block applies to every
 * alias its patterns match: so `Host *` (and other wildcard) blocks act as
 * defaults for the concrete aliases. Concrete aliases are the Host patterns
 * without wildcards or negation. `Include` and `Match` are not followed; they
 * and the other keywords are reported as notes.
 */
import { join } from 'node:path';

export interface SshConfigHost {
  alias: string;
  hostName: string;
  user: string;
  port: number;
  /** Absolute path, or empty. */
  identityFile: string;
  proxyJump: string;
}

export interface ParsedSshConfig {
  hosts: SshConfigHost[];
  notes: string[];
}

const USED = new Set(['hostname', 'user', 'port', 'identityfile', 'proxyjump']);
const MAX_LINES = 20_000;
const MAX_NOTES = 50;

interface Block {
  /** null: lines before the first Host (they apply to every host). */
  patterns: string[] | null;
  /** Inside a Match block: never applied. */
  ignored: boolean;
  values: Map<string, string>;
}

export function parseSshConfig(
  text: string,
  options: { home: string; localUser: string },
): ParsedSshConfig {
  const notes: string[] = [];
  const note = (message: string) => {
    if (notes.length < MAX_NOTES && !notes.includes(message)) notes.push(message);
  };
  const blocks: Block[] = [{ patterns: null, ignored: false, values: new Map() }];
  const aliases: string[] = [];
  const unknown = new Set<string>();

  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_LINES) note(`Only the first ${MAX_LINES} lines were read`);
  for (const [index, raw] of lines.slice(0, MAX_LINES).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!match) continue;
    const keyword = (match[1] ?? '').toLowerCase();
    const args = splitArgs(match[2] ?? '');
    const current = blocks[blocks.length - 1] as Block;

    if (keyword === 'host') {
      blocks.push({ patterns: args, ignored: false, values: new Map() });
      for (const pattern of args) {
        if (!/[*?!]/.test(pattern) && !aliases.includes(pattern)) aliases.push(pattern);
      }
      continue;
    }
    if (keyword === 'match') {
      blocks.push({ patterns: [], ignored: true, values: new Map() });
      note(`Line ${index + 1}: "Match" blocks are not supported; their settings were ignored`);
      continue;
    }
    if (keyword === 'include') {
      note(
        `Line ${index + 1}: "Include ${args.join(' ')}" was not followed; import that file separately`,
      );
      continue;
    }
    if (current.ignored) continue;
    if (!USED.has(keyword)) {
      unknown.add(match[1] ?? keyword);
      continue;
    }
    // The first value wins, within a block as across blocks.
    if (!current.values.has(keyword) && args[0] !== undefined) current.values.set(keyword, args[0]);
  }

  if (unknown.size > 0) {
    const names = [...unknown].slice(0, 12).join(', ');
    note(`Ignored (not used by quqa-express): ${names}${unknown.size > 12 ? ', …' : ''}`);
  }

  const hosts = aliases.map((alias) => resolve(alias, blocks, options));
  return { hosts, notes };
}

function resolve(
  alias: string,
  blocks: Block[],
  options: { home: string; localUser: string },
): SshConfigHost {
  const values = new Map<string, string>();
  for (const block of blocks) {
    if (block.ignored) continue;
    if (block.patterns !== null && !matches(alias, block.patterns)) continue;
    for (const [keyword, value] of block.values)
      if (!values.has(keyword)) values.set(keyword, value);
  }
  const hostName = expand(values.get('hostname') ?? alias, alias, options.home);
  const port = Number(values.get('port') ?? 22);
  const identity = values.get('identityfile');
  const proxyJump = values.get('proxyjump') ?? '';
  return {
    alias,
    hostName,
    user: values.get('user') ?? options.localUser,
    port: Number.isInteger(port) ? port : 0,
    identityFile: identity ? identityPath(expand(identity, alias, options.home), options.home) : '',
    proxyJump: proxyJump.toLowerCase() === 'none' ? '' : proxyJump,
  };
}

/** True when a positive pattern matches and no negated one does (case-insensitive). */
export function matches(alias: string, patterns: string[]): boolean {
  let positive = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (glob(negated ? pattern.slice(1) : pattern).test(alias)) {
      if (negated) return false;
      positive = true;
    }
  }
  return positive;
}

function glob(pattern: string): RegExp {
  const body = pattern
    .split('')
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[\\^$.|+()[\]{}]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

/** `%h` (the alias), `%d` (home) and `%%`; other tokens are left as they are. */
function expand(value: string, alias: string, home: string): string {
  return value.replace(/%([hd%])/g, (_, token: string) =>
    token === 'h' ? alias : token === 'd' ? home : '%',
  );
}

function identityPath(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(path)) return path;
  // ssh resolves a relative IdentityFile against ~/.ssh in practice for keys there.
  return join(home, '.ssh', path);
}

/** Whitespace-separated arguments; double quotes group (ssh's own rule). */
function splitArgs(text: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const match of text.replace(/\s+#.*$/, '').matchAll(pattern)) {
    args.push(match[1] ?? match[2] ?? '');
  }
  return args;
}
