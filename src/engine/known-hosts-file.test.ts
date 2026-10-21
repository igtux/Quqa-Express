import { createHmac, randomBytes } from 'node:crypto';
import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';
import { describeHostKey } from './host-keys.js';
import { hashedMatches, knownHostsName, parseKnownHosts } from './known-hosts-file.js';
import { KnownHosts } from './known-hosts.js';

const { utils } = ssh2;

/** A fresh host key, as known_hosts would hold it. */
function hostKey() {
  const parsed = utils.parseKey(utils.generateKeyPairSync('ed25519').public);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('bad key');
  const blob = parsed.getPublicSSH();
  return { blob, line: `ssh-ed25519 ${blob.toString('base64')}` };
}

function hashed(name: string) {
  const salt = randomBytes(20);
  const hash = createHmac('sha1', salt).update(name).digest();
  return `|1|${salt.toString('base64')}|${hash.toString('base64')}`;
}

describe('parseKnownHosts', () => {
  it('reads plain entries, host lists and [host]:port', () => {
    const a = hostKey();
    const b = hostKey();
    const parsed = parseKnownHosts(
      [
        '# comment',
        '',
        `Server.Example.com,10.0.0.5 ${a.line} root@server`,
        `[jump.example.com]:2222 ${b.line}`,
        `[::1]:2200 ${b.line}`,
      ].join('\r\n'),
    );
    expect(parsed.skipped).toBe(0);
    expect(parsed.plain.map(({ host, port }) => `${host}:${port}`)).toEqual([
      'server.example.com:22',
      '10.0.0.5:22',
      'jump.example.com:2222',
      '::1:2200',
    ]);
    expect(parsed.plain[0]?.key).toEqual({
      algorithm: 'ssh-ed25519',
      key: a.blob.toString('base64'),
    });
  });

  it('reads hashed entries and matches them by host and port', () => {
    const key = hostKey();
    const parsed = parseKnownHosts(
      `${hashed('server.example.com')} ${key.line}\n${hashed('[server.example.com]:2222')} ${key.line}\n`,
    );
    expect(parsed.hashed).toHaveLength(2);
    const [port22, port2222] = parsed.hashed;
    if (!port22 || !port2222) throw new Error('missing');
    expect(hashedMatches(port22, 'server.example.com', 22)).toBe(true);
    expect(hashedMatches(port22, 'SERVER.example.com', 22)).toBe(true);
    expect(hashedMatches(port22, 'server.example.com', 2222)).toBe(false);
    expect(hashedMatches(port22, 'other.example.com', 22)).toBe(false);
    expect(hashedMatches(port2222, 'server.example.com', 2222)).toBe(true);
    expect(knownHostsName('Host', 22)).toBe('host');
    expect(knownHostsName('host', 2222)).toBe('[host]:2222');
  });

  it('skips markers, wildcards, negations and hostile or broken lines', () => {
    const key = hostKey();
    const other = hostKey();
    const parsed = parseKnownHosts(
      [
        `@cert-authority *.example.com ${key.line}`,
        `@revoked server ${key.line}`,
        `*.example.com ${key.line}`,
        `!bad.example.com ${key.line}`,
        `host?.lan ${key.line}`,
        `server ssh-ed25519 not-base64!`,
        `server ssh-rsa ${key.blob.toString('base64')}`, // type does not match the blob
        `server`,
        `|1|short|short ${key.line}`,
        `-oProxyCommand=evil ${key.line}`,
        `ok.example.com ${other.line}`,
      ].join('\n'),
    );
    expect(parsed.plain.map((e) => e.host)).toEqual(['ok.example.com']);
    expect(parsed.hashed).toEqual([]);
    expect(parsed.skipped).toBe(10);
  });
});

describe('KnownHosts store', () => {
  it('imports known_hosts without weakening a pin the user made', async () => {
    const trusted = hostKey();
    const other = hostKey();
    const saves: unknown[] = [];
    const store = new KnownHosts(async (data) => {
      saves.push(data);
    });
    await store.accept('server', 22, describeHostKey(trusted.blob));
    const summary = await store.import(
      parseKnownHosts(
        `server ${other.line}\nfresh ${other.line}\nfresh ${trusted.line}\n${hashed('server')} ${other.line}`,
      ),
    );
    expect(summary).toEqual({ imported: 2, hashed: 1 });
    expect(store.check('server', 22, trusted.blob)).toBe('trusted');
    // Neither the plain nor the hashed entry widens the user's pin.
    expect(store.check('server', 22, other.blob)).toBe('mismatch');
    expect(store.check('fresh', 22, other.blob)).toBe('trusted');
    expect(store.check('fresh', 22, trusted.blob)).toBe('trusted');
    expect(saves.length).toBe(2);
  });

  it('trusts hashed entries for hosts it has no pin for', async () => {
    const key = hostKey();
    const store = new KnownHosts();
    await store.import(parseKnownHosts(`${hashed('[db.lan]:2222')} ${key.line}`));
    expect(store.check('db.lan', 2222, key.blob)).toBe('trusted');
    expect(store.check('db.lan', 22, key.blob)).toBe('unknown');
    expect(store.check('db.lan', 2222, hostKey().blob)).toBe('mismatch');
    expect(store.list()).toEqual({ pins: [], hashed: 1 });
  });

  it('replaces every pin of a host, hashed ones included', async () => {
    const old = hostKey();
    const replacement = hostKey();
    const store = new KnownHosts();
    await store.import(parseKnownHosts(`${hashed('server')} ${old.line}\nserver ${old.line}`));
    expect(store.previous('server', 22)).toHaveLength(2);
    await store.replace('server', 22, describeHostKey(replacement.blob));
    expect(store.check('server', 22, old.blob)).toBe('mismatch');
    expect(store.check('server', 22, replacement.blob)).toBe('trusted');
    expect(store.list().hashed).toBe(0);
    await store.forget('server', 22);
    expect(store.check('server', 22, replacement.blob)).toBe('unknown');
  });

  it('survives a reload and clears on lock', async () => {
    const key = hostKey();
    const store = new KnownHosts();
    await store.accept('a', 22, describeHostKey(key.blob));
    const data = JSON.parse(JSON.stringify(store.data()));
    store.clear();
    expect(store.check('a', 22, key.blob)).toBe('unknown');
    store.load(data);
    expect(store.check('a', 22, key.blob)).toBe('trusted');
  });
});
