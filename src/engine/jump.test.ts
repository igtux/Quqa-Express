import { describe, expect, it } from 'vitest';
import type { HostInfo } from '../shared/ipc.js';
import { JumpError, MAX_HOPS, matchJumpHost, parseJumpSpec, resolveChain } from './jump.js';

let n = 0;
function host(name: string, extra: Partial<HostInfo> = {}): HostInfo {
  n++;
  return {
    id: `h_${n.toString(16).padStart(16, '0')}`,
    name,
    address: `${name}.example.com`,
    port: 22,
    username: 'me',
    auth: { kind: 'password' },
    os: 'linux',
    group: '',
    tags: [],
    notes: '',
    color: '',
    tmux: false,
    jumpHostId: null,
    proxyJump: '',
    scheme: '',
    font: '',
    agentForward: false,
    fileRoots: [],
    uploadDir: '',
    osc52: 'ask',
    forwards: [],
    createdAt: '',
    lastUsedAt: null,
    connectCount: 0,
    ...extra,
  };
}

describe('ProxyJump entries', () => {
  it('parses user, host and port forms', () => {
    expect(parseJumpSpec('bastion')).toEqual({ user: '', host: 'bastion', port: null });
    expect(parseJumpSpec('ops@bastion:2222')).toEqual({ user: 'ops', host: 'bastion', port: 2222 });
    expect(parseJumpSpec('ssh://ops@[fe80::1]:22')).toEqual({
      user: 'ops',
      host: 'fe80::1',
      port: 22,
    });
    expect(() => parseJumpSpec('bastion:99999')).toThrow(JumpError);
    expect(() => parseJumpSpec('')).toThrow(JumpError);
  });

  it('matches saved hosts by name, then by address, port and user', () => {
    const a = host('bastion');
    const b = host('other', { address: '10.0.0.1', port: 2222, username: 'ops' });
    expect(matchJumpHost('bastion', [a, b])).toBe(a);
    expect(matchJumpHost('ops@10.0.0.1:2222', [a, b])).toBe(b);
    expect(() => matchJumpHost('root@10.0.0.1:2222', [a, b])).toThrow(/not a saved host/);
  });
});

describe('jump chains', () => {
  it('follows jump hosts and ProxyJump lists, first hop first', () => {
    const edge = host('edge');
    const mid = host('mid', { jumpHostId: edge.id });
    const target = host('target', { jumpHostId: mid.id });
    expect(resolveChain(target, [edge, mid, target]).map((h) => h.name)).toEqual(['edge', 'mid']);
    const listed = host('listed', { proxyJump: 'edge,mid' });
    // `edge,mid` as written; the first hop's own jump settings come before it.
    expect(resolveChain(listed, [edge, mid, listed]).map((h) => h.name)).toEqual(['edge', 'mid']);
    const twice = host('twice', { proxyJump: 'mid,edge' });
    expect(() => resolveChain(twice, [edge, mid, twice])).toThrow(/loop/);
    const plain = host('plain', { proxyJump: 'edge' });
    expect(resolveChain(plain, [edge, plain]).map((h) => h.name)).toEqual(['edge']);
    expect(resolveChain(host('direct', { proxyJump: 'none' }), [])).toEqual([]);
  });

  it('refuses loops, missing hosts and overly long chains', () => {
    const a = host('a');
    const b = host('b', { jumpHostId: a.id });
    a.jumpHostId = b.id;
    expect(() => resolveChain(b, [a, b])).toThrow(/loop/);
    const self = host('self', { proxyJump: 'self' });
    expect(() => resolveChain(self, [self])).toThrow(/loop/);
    expect(() => resolveChain(host('x', { jumpHostId: 'h_ffffffffffffffff' }), [])).toThrow(
      /no longer saved/,
    );
    const chain: HostInfo[] = [host('c0')];
    for (let i = 1; i <= MAX_HOPS + 1; i++) {
      chain.push(host(`c${i}`, { jumpHostId: chain[i - 1]?.id ?? null }));
    }
    const last = chain.at(-1);
    if (!last) throw new Error('no chain');
    expect(() => resolveChain(last, chain)).toThrow(/More than/);
  });
});
