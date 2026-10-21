import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matches, parseSshConfig } from './ssh-config.js';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../test/fixtures/ssh-config', name), 'utf8');
const options = { home: '/home/me', localUser: 'me' };

describe('parseSshConfig', () => {
  it('reads concrete hosts and applies wildcard blocks as defaults, first value winning', () => {
    const { hosts } = parseSshConfig(fixture('basic.conf'), options);
    expect(hosts.map((h) => h.alias)).toEqual(['web1', 'web1-alias', 'db.corp', 'bastion.corp']);
    const [web1, alias, db, bastion] = hosts;
    expect(web1).toEqual({
      alias: 'web1',
      hostName: '10.0.0.11',
      user: 'fallback',
      port: 2222,
      identityFile: join('/home/me', '.ssh', 'id_web'),
      proxyJump: '',
    });
    expect(alias?.hostName).toBe('10.0.0.11');
    // `Host *.corp` comes first: its User and ProxyJump win over `Host *`.
    expect(db).toEqual({
      alias: 'db.corp',
      hostName: 'db.corp.internal',
      user: 'corp-admin',
      port: 22,
      identityFile: join('/home/me', '.ssh', 'my keys', 'db key'),
      proxyJump: 'bastion.corp',
    });
    // `*.corp` sets ProxyJump bastion.corp before `ProxyJump none` in its own block.
    expect(bastion?.user).toBe('corp-admin');
    expect(bastion?.hostName).toBe('203.0.113.5');
  });

  it('reports Include, Match and unused keywords instead of following them', () => {
    const { hosts, notes } = parseSshConfig(fixture('basic.conf'), options);
    expect(notes.some((n) => /Include ~\/\.ssh\/config\.d\/\*" was not followed/.test(n))).toBe(
      true,
    );
    expect(notes.some((n) => /Match/.test(n))).toBe(true);
    expect(notes.some((n) => /ServerAliveInterval, ForwardAgent/.test(n))).toBe(true);
    expect(hosts.every((h) => h.user !== 'should-not-apply')).toBe(true);
  });

  it('handles "=" forms, global settings, quotes and bad values', () => {
    const { hosts } = parseSshConfig(fixture('tricky.conf'), options);
    const byAlias = new Map(hosts.map((h) => [h.alias, h]));
    expect(byAlias.get('equals-form')).toMatchObject({
      hostName: 'equals.example.com',
      port: 2200,
      user: 'global-user',
    });
    expect(byAlias.get('bad-addr')?.hostName).toBe('two words');
    expect(byAlias.get('bad-port')?.port).toBe(99999);
    expect(byAlias.get('literal')?.hostName).toBe('literal.example');
    expect(byAlias.has('literal-2')).toBe(false);
    // Settings before the first Host apply to every host and come first, so they win.
    expect(byAlias.get('win')?.user).toBe('global-user');
    expect(byAlias.get('win')?.hostName).toBe('192.0.2.7');
  });

  it('defaults the user to the local account and the host name to the alias', () => {
    const { hosts } = parseSshConfig('Host plain\n', options);
    expect(hosts).toEqual([
      { alias: 'plain', hostName: 'plain', user: 'me', port: 22, identityFile: '', proxyJump: '' },
    ]);
  });

  it('ignores comments, blank lines and wildcard-only hosts', () => {
    const { hosts } = parseSshConfig('# c\n\nHost *\n  User x\nHost ?? a*\n', options);
    expect(hosts).toEqual([]);
  });
});

describe('matches', () => {
  it('matches globs case-insensitively and lets a negation veto', () => {
    expect(matches('Web1', ['web*'])).toBe(true);
    expect(matches('web12', ['web?'])).toBe(false);
    expect(matches('literal-2', ['literal*', '!literal-2'])).toBe(false);
    expect(matches('a.b', ['a?b'])).toBe(true);
    expect(matches('a+b', ['a.b'])).toBe(false);
  });
});
