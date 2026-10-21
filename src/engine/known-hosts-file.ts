/**
 * OpenSSH `known_hosts` parsing, for importing pins the user already trusts.
 *
 *   host1,host2,[host3]:2222 ssh-ed25519 AAAA… comment
 *   |1|<base64 salt>|<base64 HMAC-SHA1(salt, host)> ssh-ed25519 AAAA…
 *
 * Supported: plain host lists, `[host]:port`, hashed (`|1|`) entries.
 * Skipped (counted): `@cert-authority` and `@revoked` lines, wildcard and
 * negated patterns, malformed lines and keys whose blob does not match the
 * named type.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { algorithmOf, type PinnedHostKey } from './host-keys.js';

export const MAX_KNOWN_HOSTS_BYTES = 4 * 1024 * 1024;

export interface PlainEntry {
  host: string;
  port: number;
  key: PinnedHostKey;
}

export interface HashedEntry {
  /** base64, 20 bytes */
  salt: string;
  /** base64 HMAC-SHA1(salt, "host" or "[host]:port") */
  hash: string;
  key: PinnedHostKey;
}

export interface ParsedKnownHosts {
  plain: PlainEntry[];
  hashed: HashedEntry[];
  skipped: number;
}

const KEY_TYPE = /^[A-Za-z0-9@._-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseKnownHosts(text: string): ParsedKnownHosts {
  const result: ParsedKnownHosts = { plain: [], hashed: [], skipped: 0 };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    if (fields[0]?.startsWith('@')) {
      result.skipped++;
      continue;
    }
    const [hosts, type, blob64] = fields;
    const key = hosts && type && blob64 ? parseKey(type, blob64) : null;
    if (!hosts || !key) {
      result.skipped++;
      continue;
    }
    if (hosts.startsWith('|')) {
      const hashed = parseHashed(hosts);
      if (hashed) result.hashed.push({ ...hashed, key });
      else result.skipped++;
      continue;
    }
    for (const pattern of hosts.split(',')) {
      const target = parseHostPattern(pattern);
      if (target) result.plain.push({ ...target, key });
      else result.skipped++;
    }
  }
  return result;
}

function parseKey(type: string, blob64: string): PinnedHostKey | null {
  if (!KEY_TYPE.test(type) || !BASE64.test(blob64) || blob64.length > 16 * 1024) return null;
  const blob = Buffer.from(blob64, 'base64');
  try {
    if (algorithmOf(blob) !== type) return null;
  } catch {
    return null;
  }
  return { algorithm: type, key: blob.toString('base64') };
}

function parseHashed(field: string): { salt: string; hash: string } | null {
  const match = /^\|1\|([A-Za-z0-9+/]+={0,2})\|([A-Za-z0-9+/]+={0,2})$/.exec(field);
  if (!match?.[1] || !match[2]) return null;
  const salt = Buffer.from(match[1], 'base64');
  const hash = Buffer.from(match[2], 'base64');
  if (salt.length !== 20 || hash.length !== 20) return null;
  return { salt: salt.toString('base64'), hash: hash.toString('base64') };
}

/** `host` or `[host]:port`; wildcards and negations are not imported. */
function parseHostPattern(pattern: string): { host: string; port: number } | null {
  if (!pattern || /[*?!]/.test(pattern)) return null;
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(pattern);
  const host = bracketed ? bracketed[1] : pattern;
  const port = bracketed ? Number(bracketed[2]) : 22;
  if (!host || port < 1 || port > 65535) return null;
  if (!/^[A-Za-z0-9.:_-]{1,253}$/.test(host)) return null;
  return { host: host.toLowerCase(), port };
}

/** The name OpenSSH hashes for a host: `host` on port 22, `[host]:port` otherwise. */
export function knownHostsName(host: string, port: number): string {
  const name = host.toLowerCase();
  return port === 22 ? name : `[${name}]:${port}`;
}

export function hashedMatches(entry: { salt: string; hash: string }, host: string, port: number) {
  const expected = Buffer.from(entry.hash, 'base64');
  const actual = createHmac('sha1', Buffer.from(entry.salt, 'base64'))
    .update(knownHostsName(host, port))
    .digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
