import { describe, expect, it } from 'vitest';
import type { HostInfo } from '../../../shared/ipc.js';
import { EMPTY_HOST, validateHost } from './HostForm.js';
import {
  destination,
  filterHosts,
  groupHosts,
  hostStatus,
  latencyClass,
  latencyText,
  parseTags,
} from './hostModel.js';

const host = (name: string, change: Partial<HostInfo> = {}): HostInfo => ({
  ...EMPTY_HOST,
  id: `h_${name.padEnd(16, '0').slice(0, 16)}`,
  name,
  address: `${name}.example.com`,
  username: 'deploy',
  createdAt: '2026-10-21T00:00:00.000Z',
  lastUsedAt: null,
  connectCount: 0,
  ...change,
});

describe('host search and groups', () => {
  const hosts = [
    host('web1', { group: 'Production', tags: ['eu', 'web'] }),
    host('web2', { group: 'Production', tags: ['us', 'web'] }),
    host('db', { group: 'Data', tags: ['eu'] }),
    host('scratch'),
  ];

  it('filters fuzzily and by tag: / group:', () => {
    expect(filterHosts(hosts, 'web').map((h) => h.name)).toEqual(['web1', 'web2']);
    expect(filterHosts(hosts, 'tag:eu').map((h) => h.name)).toEqual(['web1', 'db']);
    expect(filterHosts(hosts, 'tag:eu web').map((h) => h.name)).toEqual(['web1']);
    expect(filterHosts(hosts, 'group:data').map((h) => h.name)).toEqual(['db']);
    expect(filterHosts(hosts, 'group:"production" w2').map((h) => h.name)).toEqual(['web2']);
    expect(filterHosts(hosts, '')).toEqual(hosts);
  });

  it('groups alphabetically with Ungrouped last', () => {
    expect(groupHosts(hosts).map((g) => [g.name, g.hosts.length])).toEqual([
      ['Data', 1],
      ['Production', 2],
      ['', 1],
    ]);
  });

  it('formats destinations and latency', () => {
    expect(destination(host('a', { port: 2222 }))).toBe('deploy@a.example.com:2222');
    expect(destination(host('b', { address: '::1' }))).toBe('deploy@[::1]');
    expect(latencyText(undefined)).toBe('--');
    expect(latencyText({ ms: 12.4, error: null, at: 0 })).toBe('12 ms');
    expect(latencyText({ ms: null, error: 'Connection refused', at: 0 })).toBe(
      'Connection refused',
    );
    expect(latencyClass({ ms: 200, error: null, at: 0 })).toBe('slow');
    expect(hostStatus(undefined, true)).toBe('checking');
    expect(hostStatus({ ms: null, error: 'x', at: 0 }, false)).toBe('offline');
  });

  it('normalises tags', () => {
    expect(parseTags('Prod, eu  web,,prod')).toEqual(['prod', 'eu', 'web']);
  });
});

describe('validateHost (form checks mirror the IPC schema)', () => {
  const base = { ...EMPTY_HOST, address: 'server.lan', username: 'root' };
  it('accepts a plain host', () => {
    expect(validateHost(base)).toBeNull();
  });
  it.each([
    [{ address: '' }, /host name/],
    [{ address: 'http://x' }, /host name/],
    [{ address: '-oProxyCommand=x' }, /host name/],
    [{ port: 0 }, /port/],
    [{ port: 70000 }, /port/],
    [{ username: '' }, /user/],
    [{ username: 'a b' }, /user/],
    [{ name: 'two\nlines' }, /one line/],
    [{ tags: ['has space'] }, /Tags/],
    [{ notes: 'x'.repeat(4001) }, /notes/],
  ])('rejects %j', (change, message) => {
    expect(validateHost({ ...base, ...change })).toMatch(message);
  });
});
