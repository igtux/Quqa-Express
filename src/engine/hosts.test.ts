import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Value from 'typebox/value';
import { afterEach, describe, expect, it } from 'vitest';
import { AppCalls, type HostInput } from '../shared/ipc.js';
import { Engine } from './engine.js';
import { DEFAULT_UI } from './hosts.js';
import { ed25519Pair } from '../../test/keypair.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function unlocked() {
  const engine = new Engine(() => undefined, {
    kdf: { memoryKiB: 64, iterations: 1, parallelism: 1 },
  });
  const dir = await mkdtemp(join(tmpdir(), 'quqa-hosts-'));
  dirs.push(dir);
  await engine.call('vault.open', { path: join(dir, 'vault.json') });
  await engine.call('vault.create', { mode: 'password', password: 'hosts test' });
  return { engine, dir };
}

const input: HostInput = {
  name: 'web 1',
  address: 'web1.example.com',
  port: 22,
  username: 'deploy',
  auth: { kind: 'password' },
  os: 'linux',
  group: 'Production',
  tags: ['Web', 'eu', 'web'],
  notes: 'Primary\nweb server',
  color: '#22c55e',
  tmux: true,
  jumpHostId: null,
  proxyJump: '',
  scheme: '',
  font: '',
  agentForward: false,
  fileRoots: [],
  uploadDir: '',
  osc52: 'ask',
  forwards: [],
};

const valid = (host: unknown) => Value.Check(AppCalls['hosts.save'].params, host);

describe('host validation (IPC schema)', () => {
  it('accepts a full host', () => {
    expect(valid({ host: input })).toBe(true);
    expect(valid({ id: 'h_0123456789abcdef', host: input })).toBe(true);
  });

  it.each([
    ['address with a space', { address: 'two words' }],
    ['address with an option', { address: '-oProxyCommand=x' }],
    ['port 0', { port: 0 }],
    ['user with a semicolon', { username: 'a;b' }],
    ['a secret in auth', { auth: { kind: 'password', password: 'x' } }],
    ['a key path in auth', { auth: { kind: 'key', keyId: '../x' } }],
    ['a newline in the name', { name: 'a\nb' }],
    ['a control character in notes', { notes: 'a\u001b[31mb' }],
    ['a tag with a comma', { tags: ['a,b'] }],
    ['17 tags', { tags: Array.from({ length: 17 }, (_, i) => `t${i}`) }],
    ['a colour name', { color: 'red' }],
    ['an unknown field', { privateKey: 'x' }],
    ['a bad jump host id', { jumpHostId: 'h_x' }],
  ])('rejects %s', (_, change) => {
    expect(valid({ host: { ...input, ...change } })).toBe(false);
  });

  it('rejects bad ids', () => {
    expect(valid({ id: '../h', host: input })).toBe(false);
  });
});

describe('saved hosts', () => {
  it('creates, lists, edits and deletes hosts; tags are normalised', async () => {
    const { engine } = await unlocked();
    const created = await engine.call('hosts.save', { host: input });
    expect(created.id).toMatch(/^h_[0-9a-f]{16}$/);
    expect(created.tags).toEqual(['eu', 'web']);
    expect(created.connectCount).toBe(0);
    expect(created.lastUsedAt).toBeNull();

    const edited = await engine.call('hosts.save', {
      id: created.id,
      host: { ...input, name: 'web one', port: 2222 },
    });
    expect(edited).toMatchObject({ id: created.id, name: 'web one', port: 2222 });
    expect(edited.createdAt).toBe(created.createdAt);

    const second = await engine.call('hosts.save', { host: { ...input, name: 'alpha' } });
    expect((await engine.call('hosts.list', {})).hosts.map((h) => h.name)).toEqual([
      'alpha',
      'web one',
    ]);

    await engine.call('hosts.delete', { id: second.id, forgetHostKey: false });
    expect((await engine.call('hosts.list', {})).hosts.map((h) => h.id)).toEqual([created.id]);
    await expect(
      engine.call('hosts.delete', { id: second.id, forgetHostKey: false }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses missing keys and jump hosts, and drops a jump when its host is deleted', async () => {
    const { engine } = await unlocked();
    await expect(
      engine.call('hosts.save', {
        host: { ...input, auth: { kind: 'key', keyId: 'key_0123456789abcdef' } },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      engine.call('hosts.save', { host: { ...input, jumpHostId: 'h_0123456789abcdef' } }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const key = await engine.call('keys.generate', { label: 'k' });
    const bastion = await engine.call('hosts.save', { host: { ...input, name: 'bastion' } });
    const inner = await engine.call('hosts.save', {
      host: { ...input, auth: { kind: 'key', keyId: key.id }, jumpHostId: bastion.id },
    });
    await expect(
      engine.call('hosts.save', { id: bastion.id, host: { ...input, jumpHostId: bastion.id } }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await engine.call('keys.list', {})).keys[0]?.usedBy).toBe(1);

    await engine.call('hosts.delete', { id: bastion.id, forgetHostKey: false });
    const [left] = (await engine.call('hosts.list', {})).hosts;
    expect(left).toMatchObject({ id: inner.id, jumpHostId: null });
  });

  it('needs an unlocked vault', async () => {
    const { engine } = await unlocked();
    await engine.call('vault.lock', {});
    await expect(engine.call('hosts.list', {})).rejects.toMatchObject({ code: 'locked' });
  });

  it('keeps hosts and UI state sealed in the vault file', async () => {
    const { engine, dir } = await unlocked();
    await engine.call('hosts.save', { host: input });
    expect(await engine.call('ui.get', {})).toEqual(DEFAULT_UI);
    const ui = { ...DEFAULT_UI, scheme: 'dracula', zoom: 2 };
    await engine.call('ui.save', ui);
    expect(await engine.call('ui.get', {})).toEqual(ui);
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(join(dir, 'vault.json'), 'utf8');
    expect(text).not.toMatch(/web1\.example\.com|deploy|dracula|Production/);
  });

  it('pings the SSH port without logging in', async () => {
    const { engine } = await unlocked();
    const { createServer } = await import('node:net');
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const up = await engine.call('hosts.save', { host: { ...input, address: '127.0.0.1', port } });
    const down = await engine.call('hosts.save', {
      host: { ...input, address: '127.0.0.1', port: 1 },
    });
    const { results } = await engine.call('hosts.ping', { ids: [up.id, down.id] });
    server.close();
    expect(results[0]).toMatchObject({ id: up.id, error: null });
    expect(results[0]?.ms).toBeGreaterThanOrEqual(0);
    expect(results[1]).toMatchObject({ id: down.id, ms: null, error: 'Connection refused' });
  });
});

describe('~/.ssh/config import', () => {
  it('previews entries, imports the chosen ones and their keys once', async () => {
    const { engine, dir } = await unlocked();
    const keyFile = join(dir, 'id_test');
    await writeFile(keyFile, ed25519Pair().private);
    const config = join(dir, 'config');
    await writeFile(
      config,
      [
        'Host a b',
        `  IdentityFile ${keyFile}`,
        'Host a',
        '  HostName 10.0.0.1',
        '  User alice',
        '  ProxyJump bastion',
        'Host broken',
        '  HostName "x y"',
        'Host nokey',
        '  HostName nokey.example',
        `  IdentityFile ${join(dir, 'missing')}`,
        'Host *',
        '  User fallback',
      ].join('\n'),
    );
    const preview = await engine.call('sshConfig.readPath', { path: config });
    expect(preview.found).toBe(true);
    expect(preview.entries.map((e) => [e.alias, e.problem === ''])).toEqual([
      ['a', true],
      ['b', true],
      ['broken', false],
      ['nokey', true],
    ]);
    const result = await engine.call('sshConfig.import', {
      token: preview.token,
      aliases: ['a', 'b', 'broken', 'nokey'],
      importKeys: true,
      tmux: true,
    });
    expect(result.hosts).toBe(3);
    expect(result.keys).toBe(1);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/^nokey: .* was not found/);

    const { hosts } = await engine.call('hosts.list', {});
    const a = hosts.find((h) => h.name === 'a');
    const b = hosts.find((h) => h.name === 'b');
    expect(a).toMatchObject({
      address: '10.0.0.1',
      username: 'alice',
      proxyJump: 'bastion',
      tmux: true,
    });
    expect(b).toMatchObject({ address: 'b', username: 'fallback' });
    expect(a?.auth).toEqual(b?.auth);
    expect(a?.auth.kind).toBe('key');
    expect(hosts.find((h) => h.name === 'nokey')?.auth).toEqual({ kind: 'password' });
    expect((await engine.call('keys.list', {})).keys).toHaveLength(1);

    // The second preview flags duplicates; an old token is refused.
    const again = await engine.call('sshConfig.readPath', { path: config });
    expect(again.entries.find((e) => e.alias === 'a')?.duplicate).toBe(true);
    await expect(
      engine.call('sshConfig.import', {
        token: preview.token,
        aliases: ['a'],
        importKeys: false,
        tmux: false,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports a missing file', async () => {
    const { engine, dir } = await unlocked();
    const preview = await engine.call('sshConfig.readPath', { path: join(dir, 'nope') });
    expect(preview).toMatchObject({ found: false, entries: [] });
  });
});
