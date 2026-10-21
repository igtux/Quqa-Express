/**
 * Phase 4 against real OpenSSH servers (docker/test-sshd): SFTP browsing and
 * edits, uploads and downloads with resume after a dropped connection, file
 * roots against `..` and symlink escapes, installing a public key, jump hosts
 * (test-sshd-inner is reachable only through test-sshd), and local, remote
 * and dynamic (SOCKS5) port forwards.
 *
 *   docker compose -f docker/compose.yml run --rm dev pnpm test:e2e
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, connect as tcpConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Engine, type EngineMessage } from '../../src/engine/engine.js';
import type { ConnectRequest, HostInput, SessionEvent } from '../../src/shared/ipc.js';

const HOST = process.env['QUQA_TEST_SSH_HOST'];
const INNER = process.env['QUQA_TEST_SSH_INNER_HOST'];
const PORT = Number(process.env['QUQA_TEST_SSH_PORT'] ?? 22);
const USER = process.env['QUQA_TEST_SSH_USER'] ?? 'quqa';
const PASSWORD = process.env['QUQA_TEST_SSH_PASSWORD'] ?? 'quqa-test-password';
const FAST_KDF = { memoryKiB: 64, iterations: 1, parallelism: 1 };

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'quqa-e2e4-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const baseHost = (name: string, address: string): HostInput => ({
  name,
  address,
  port: PORT,
  username: USER,
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
});

class Harness {
  readonly events: EngineMessage[] = [];
  readonly engine: Engine;
  private ids = 0;

  constructor(throttle = 0) {
    this.engine = new Engine(
      (event) => {
        this.events.push(event);
        if (event.type === 'host-key') {
          queueMicrotask(() =>
            this.engine.handle({
              type: 'host-key-answer',
              requestId: event.requestId,
              accept: true,
            }),
          );
        }
        if (event.type === 'prompt') {
          queueMicrotask(() =>
            this.engine.handle({
              type: 'prompt-answer',
              requestId: event.requestId,
              answers: [PASSWORD],
              remember: false,
            }),
          );
        }
      },
      { connectTimeoutMs: 10_000, kdf: FAST_KDF, transferThrottle: throttle },
    );
  }

  async open(): Promise<this> {
    await this.engine.call('vault.open', {
      path: join(root, `${randomBytes(6).toString('hex')}.json`),
    });
    await this.engine.call('vault.create', { mode: 'password', password: 'e2e' });
    return this;
  }

  connect(request: ConnectRequest): string {
    const sessionId = `s${++this.ids}`;
    this.engine.handle({ type: 'connect', sessionId, request });
    return sessionId;
  }

  async hold(hostId: string): Promise<string> {
    const id = this.connect({ hostId, action: { type: 'hold' }, cols: 80, rows: 24 });
    await this.waitFor(id, 'ready');
    return id;
  }

  of(sessionId: string): SessionEvent[] {
    return this.events.filter(
      (e): e is SessionEvent => 'sessionId' in e && e.sessionId === sessionId,
    );
  }

  async waitFor<T extends SessionEvent['type']>(
    sessionId: string,
    type: T,
    after = 0,
    ms = 20_000,
  ): Promise<Extract<SessionEvent, { type: T }>> {
    const found = await until(
      () =>
        this.of(sessionId)
          .slice(after)
          .find((e) => e.type === type),
      ms,
    );
    return found as Extract<SessionEvent, { type: T }>;
  }

  output(sessionId: string): string {
    return Buffer.concat(
      this.of(sessionId).flatMap((e) => (e.type === 'data' ? [Buffer.from(e.data)] : [])),
    ).toString('utf8');
  }

  /** The latest event of a transfer. */
  transfer(id: string) {
    return this.events
      .flatMap((e) => (e.type === 'transfer' && e.transfer.id === id ? [e.transfer] : []))
      .at(-1);
  }

  async transferDone(id: string, ms = 60_000) {
    return until(() => {
      const t = this.transfer(id);
      if (t?.state === 'failed' || t?.state === 'cancelled')
        throw new Error(`transfer ${t.state}: ${t.error}`);
      return t?.state === 'done' ? t : undefined;
    }, ms);
  }
}

async function until<T>(probe: () => T | undefined, ms: number): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const harnesses: Harness[] = [];
/** `throttle`: bytes per second per transfer, so a drop or cancel lands mid-transfer. */
async function harness(throttle = 0) {
  const h = new Harness(throttle);
  harnesses.push(h);
  return h.open();
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.engine.shutdown();
});

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Connects and reads the first line the server sends (an SSH banner). */
function readBanner(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('latin1');
      if (text.includes('\n')) {
        socket.destroy();
        resolve(text.split('\n')[0] ?? '');
      }
    });
    socket.on('error', reject);
  });
}

describe.skipIf(!HOST)('SFTP, transfers and file roots', () => {
  it('lists, creates, renames, uploads, downloads and deletes', async () => {
    const h = await harness();
    const host = await h.engine.call('hosts.save', { host: baseHost('sftp', HOST ?? '') });
    const id = await h.hold(host.id);
    const listing = await h.engine.call('files.list', { sessionId: id });
    expect(listing.path).toBe(`/home/${USER}`);
    expect(listing.home).toBe(listing.path);
    expect(listing.roots).toEqual([]);

    const folder = `e2e-${randomBytes(4).toString('hex')}`;
    const made = await h.engine.call('files.mkdir', {
      sessionId: id,
      parent: listing.path,
      name: folder,
    });
    expect(made).toMatchObject({ type: 'directory', name: folder });
    await expect(
      h.engine.call('files.mkdir', { sessionId: id, parent: listing.path, name: folder }),
    ).rejects.toMatchObject({ code: 'exists' });

    // Upload a 3 MB file, then the same name again: asked first, replaced on request.
    const local = join(root, 'payload.bin');
    const bytes = randomBytes(3 * 1024 * 1024);
    await writeFile(local, bytes);
    const up = await h.engine.call('files.upload', {
      sessionId: id,
      directory: made.path,
      files: [{ path: local, name: 'payload.bin' }],
      conflict: 'ask',
      wait: true,
    });
    expect(up.paths).toEqual([`${made.path}/payload.bin`]);
    expect(h.transfer(up.started[0]?.id ?? '')).toMatchObject({
      state: 'done',
      bytes: bytes.length,
    });
    const again = await h.engine.call('files.upload', {
      sessionId: id,
      directory: made.path,
      files: [{ path: local, name: 'payload.bin' }],
      conflict: 'ask',
      wait: false,
    });
    expect(again).toMatchObject({ started: [], conflicts: ['payload.bin'] });
    const renamed = await h.engine.call('files.upload', {
      sessionId: id,
      directory: made.path,
      files: [{ path: local, name: 'payload.bin' }],
      conflict: 'rename',
      wait: true,
    });
    expect(renamed.paths).toEqual([`${made.path}/payload-1.bin`]);

    // The listing shows both, folders first, with sizes; no partial files are left.
    const inside = await h.engine.call('files.list', { sessionId: id, path: made.path });
    expect(inside.entries.map((e) => e.name).sort()).toEqual(['payload-1.bin', 'payload.bin']);
    expect(inside.entries[0]).toMatchObject({ type: 'file', size: bytes.length, mode: 0o644 });

    // Rename, refuse to replace, then move into a subfolder.
    await h.engine.call('files.rename', {
      sessionId: id,
      from: `${made.path}/payload-1.bin`,
      toParent: made.path,
      toName: 'copy.bin',
      overwrite: false,
    });
    await expect(
      h.engine.call('files.rename', {
        sessionId: id,
        from: `${made.path}/copy.bin`,
        toParent: made.path,
        toName: 'payload.bin',
        overwrite: false,
      }),
    ).rejects.toMatchObject({ code: 'exists' });
    const sub = await h.engine.call('files.mkdir', {
      sessionId: id,
      parent: made.path,
      name: 'sub',
    });
    await h.engine.call('files.rename', {
      sessionId: id,
      from: `${made.path}/copy.bin`,
      toParent: sub.path,
      toName: 'copy.bin',
      overwrite: false,
    });

    // Download into a local folder; an existing local file is never overwritten.
    const downloads = await mkdtemp(join(root, 'dl-'));
    await writeFile(join(downloads, 'payload.bin'), 'already here');
    const down = await h.engine.call('files.download', {
      sessionId: id,
      paths: [`${made.path}/payload.bin`],
      folder: downloads,
    });
    const done = await h.transferDone(down.started[0]?.id ?? '');
    expect(done.name).toBe('payload (1).bin');
    expect(sha(await readFile(join(downloads, 'payload (1).bin')))).toBe(sha(bytes));
    expect(await readFile(join(downloads, 'payload.bin'), 'utf8')).toBe('already here');
    expect((await readdir(downloads)).some((n) => n.includes('quqa-part'))).toBe(false);

    // A folder with contents needs `recursive`.
    await expect(
      h.engine.call('files.delete', { sessionId: id, path: made.path, recursive: false }),
    ).rejects.toMatchObject({ code: 'exists' });
    const deleted = await h.engine.call('files.delete', {
      sessionId: id,
      path: made.path,
      recursive: true,
    });
    // payload.bin, sub/copy.bin, sub and the folder itself.
    expect(deleted.deleted).toBe(4);
    await expect(
      h.engine.call('files.list', { sessionId: id, path: made.path }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('resumes an upload and a download after the connection drops', async () => {
    const h = await harness(8 * 1024 * 1024);
    const host = await h.engine.call('hosts.save', { host: baseHost('resume', HOST ?? '') });
    const id = await h.hold(host.id);
    const { path: home } = await h.engine.call('files.list', { sessionId: id });
    const folder = await h.engine.call('files.mkdir', {
      sessionId: id,
      parent: home,
      name: `resume-${randomBytes(4).toString('hex')}`,
    });
    const local = join(root, 'big.bin');
    const bytes = randomBytes(24 * 1024 * 1024);
    await writeFile(local, bytes);
    const session = (
      h.engine as unknown as { sessions: Map<string, { client: { destroy(): void } | null }> }
    ).sessions;
    const drop = () => session.get(id)?.client?.destroy();

    const up = await h.engine.call('files.upload', {
      sessionId: id,
      directory: folder.path,
      files: [{ path: local, name: 'big.bin' }],
      conflict: 'ask',
      wait: false,
    });
    const upId = up.started[0]?.id ?? '';
    await until(
      () => ((h.transfer(upId)?.bytes ?? 0) > 4 * 1024 * 1024 ? true : undefined),
      60_000,
    );
    const before = h.of(id).length;
    drop();
    const paused = await until(() => {
      const t = h.transfer(upId);
      return t?.state === 'interrupted' ? t : undefined;
    }, 20_000);
    expect(paused.bytes).toBeGreaterThan(0);
    await h.waitFor(id, 'closed', before);
    h.engine.handle({ type: 'reconnect', sessionId: id });
    await h.waitFor(id, 'ready', before);
    // It continues by itself from the partial file, not from zero.
    const resumedAt = await until(() => {
      const events = h.events.flatMap((e) =>
        e.type === 'transfer' && e.transfer.id === upId ? [e.transfer] : [],
      );
      const index = events.findIndex((t) => t.state === 'interrupted');
      return events.slice(index + 1).find((t) => t.state === 'running');
    }, 20_000);
    expect(resumedAt.bytes).toBeGreaterThan(0);
    await h.transferDone(upId, 120_000);

    // Download it back, dropping the connection halfway.
    const downloads = await mkdtemp(join(root, 'dl-'));
    const down = await h.engine.call('files.download', {
      sessionId: id,
      paths: [`${folder.path}/big.bin`],
      folder: downloads,
    });
    const downId = down.started[0]?.id ?? '';
    await until(
      () => ((h.transfer(downId)?.bytes ?? 0) > 4 * 1024 * 1024 ? true : undefined),
      60_000,
    );
    const mark = h.of(id).length;
    drop();
    await until(() => (h.transfer(downId)?.state === 'interrupted' ? true : undefined), 20_000);
    await h.waitFor(id, 'closed', mark);
    h.engine.handle({ type: 'reconnect', sessionId: id });
    await h.transferDone(downId, 120_000);
    const copy = await readFile(join(downloads, 'big.bin'));
    expect(copy.length).toBe(bytes.length);
    expect(sha(copy)).toBe(sha(bytes));

    await h.engine.call('files.delete', { sessionId: id, path: folder.path, recursive: true });
  }, 240_000);

  it('cancels an upload and removes its partial file', async () => {
    const h = await harness(4 * 1024 * 1024);
    const host = await h.engine.call('hosts.save', { host: baseHost('cancel', HOST ?? '') });
    const id = await h.hold(host.id);
    const { path: home } = await h.engine.call('files.list', { sessionId: id });
    const folder = await h.engine.call('files.mkdir', {
      sessionId: id,
      parent: home,
      name: `cancel-${randomBytes(4).toString('hex')}`,
    });
    const local = join(root, 'cancel.bin');
    await writeFile(local, randomBytes(16 * 1024 * 1024));
    const up = await h.engine.call('files.upload', {
      sessionId: id,
      directory: folder.path,
      files: [{ path: local, name: 'cancel.bin' }],
      conflict: 'ask',
      wait: false,
    });
    const upId = up.started[0]?.id ?? '';
    await until(() => ((h.transfer(upId)?.bytes ?? 0) > 1024 * 1024 ? true : undefined), 60_000);
    await h.engine.call('transfers.cancel', { sessionId: id, id: upId });
    expect(h.transfer(upId)?.state).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const left = await h.engine.call('files.list', { sessionId: id, path: folder.path });
    expect(left.entries).toEqual([]);
    await h.engine.call('files.delete', { sessionId: id, path: folder.path, recursive: true });
  });

  it('keeps browsing and uploads inside the file roots (.. and symlink escapes)', async () => {
    const h = await harness();
    const setup = await h.engine.call('hosts.save', { host: baseHost('setup', HOST ?? '') });
    const plain = await h.hold(setup.id);
    const { path: home } = await h.engine.call('files.list', { sessionId: plain });
    const name = `roots-${randomBytes(4).toString('hex')}`;
    const allowed = await h.engine.call('files.mkdir', { sessionId: plain, parent: home, name });

    // A symlink inside the root pointing out of it, made over a shell.
    const shell = h.connect({
      host: HOST ?? '',
      port: PORT,
      username: USER,
      auth: { kind: 'password' },
      cols: 80,
      rows: 24,
    });
    await h.waitFor(shell, 'ready');
    h.engine.handle({
      type: 'input',
      sessionId: shell,
      data: `ln -s /etc ${allowed.path}/out && echo linked''ok\n`,
      encoding: 'utf8',
    });
    await until(() => (/linkedok/.test(h.output(shell)) ? true : undefined), 15_000);

    const limited = await h.engine.call('hosts.save', {
      host: { ...baseHost('limited', HOST ?? ''), fileRoots: [allowed.path] },
    });
    const id = await h.hold(limited.id);
    // Home is outside the root: browsing starts at the root.
    const start = await h.engine.call('files.list', { sessionId: id });
    expect(start).toMatchObject({ path: allowed.path, roots: [allowed.path] });
    expect(start.entries.map((e) => e.name)).toEqual(['out']);
    for (const path of [home, `${allowed.path}/..`, `${allowed.path}/out`, '/etc', '/']) {
      await expect(h.engine.call('files.list', { sessionId: id, path })).rejects.toMatchObject({
        code: 'permission_denied',
      });
    }
    await expect(
      h.engine.call('files.mkdir', { sessionId: id, parent: `${allowed.path}/out`, name: 'x' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(
      h.engine.call('files.delete', { sessionId: id, path: allowed.path, recursive: true }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    // The symlink itself (not its target) may be removed.
    await h.engine.call('files.delete', {
      sessionId: id,
      path: `${allowed.path}/out`,
      recursive: false,
    });
    // Uploads with no folder go to the first root.
    const local = join(root, 'root-upload.txt');
    await writeFile(local, 'inside');
    const up = await h.engine.call('files.upload', {
      sessionId: id,
      directory: null,
      files: [{ path: local, name: 'note.txt' }],
      conflict: 'rename',
      wait: true,
    });
    expect(up.paths).toEqual([`${allowed.path}/note.txt`]);
    await h.engine.call('files.delete', { sessionId: plain, path: allowed.path, recursive: true });
  });

  it('pastes into ~/uploads, creating it, under a fresh name', async () => {
    const h = await harness();
    const host = await h.engine.call('hosts.save', { host: baseHost('paste', HOST ?? '') });
    const id = await h.hold(host.id);
    const image = join(root, 'clipboard_1.png');
    await writeFile(image, randomBytes(2048));
    const first = await h.engine.call('files.upload', {
      sessionId: id,
      directory: null,
      files: [{ path: image, name: 'clipboard_1.png' }],
      conflict: 'rename',
      wait: true,
    });
    const second = await h.engine.call('files.upload', {
      sessionId: id,
      directory: null,
      files: [{ path: image, name: 'clipboard_1.png' }],
      conflict: 'rename',
      wait: true,
    });
    expect(first.paths[0]).toBe(`/home/${USER}/uploads/clipboard_1.png`);
    expect(second.paths[0]).toBe(`/home/${USER}/uploads/clipboard_1-1.png`);
    await h.engine.call('files.delete', {
      sessionId: id,
      path: first.paths[0] ?? '',
      recursive: false,
    });
    await h.engine.call('files.delete', {
      sessionId: id,
      path: second.paths[0] ?? '',
      recursive: false,
    });
  });

  it('installs a public key once, then logs in with it', async () => {
    const h = await harness();
    const host = await h.engine.call('hosts.save', { host: baseHost('install', HOST ?? '') });
    const id = await h.hold(host.id);
    const key = await h.engine.call('keys.generate', { label: 'installed' });
    expect(await h.engine.call('keys.install', { sessionId: id, keyId: key.id })).toMatchObject({
      added: true,
      path: `/home/${USER}/.ssh/authorized_keys`,
    });
    expect(await h.engine.call('keys.install', { sessionId: id, keyId: key.id })).toMatchObject({
      added: false,
    });
    const byKey = h.connect({
      host: HOST ?? '',
      port: PORT,
      username: USER,
      auth: { kind: 'key', keyId: key.id },
      cols: 80,
      rows: 24,
    });
    await h.waitFor(byKey, 'ready');
    expect(h.of(byKey).some((e) => e.type === 'prompt')).toBe(false);
  });
});

describe.skipIf(!HOST || !INNER)('jump hosts', () => {
  it('reaches a server only visible from the jump host, checking both host keys', async () => {
    const h = await harness();
    // Directly, the inner server is out of reach.
    const direct = h.connect({
      host: INNER ?? '',
      port: PORT,
      username: USER,
      auth: { kind: 'password' },
      cols: 80,
      rows: 24,
    });
    expect((await h.waitFor(direct, 'error')).code).toMatch(/unreachable|timeout/);

    const outer = await h.engine.call('hosts.save', { host: baseHost('outer', HOST ?? '') });
    const inner = await h.engine.call('hosts.save', {
      host: { ...baseHost('inner', INNER ?? ''), jumpHostId: outer.id },
    });
    const id = h.connect({
      hostId: inner.id,
      action: { type: 'shell', tmux: null },
      cols: 80,
      rows: 24,
    });
    await h.waitFor(id, 'ready');
    const keys = h.of(id).flatMap((e) => (e.type === 'host-key' ? [e] : []));
    expect(keys.map((k) => k.host)).toEqual(
      [HOST?.toLowerCase(), INNER?.toLowerCase()].map(String),
    );
    expect(keys[0]?.fingerprint).not.toBe(keys[1]?.fingerprint);
    expect(h.of(id).filter((e) => e.type === 'prompt')).toHaveLength(2);
    h.engine.handle({
      type: 'input',
      sessionId: id,
      data: 'echo via-$SSH_CONNECTION\n',
      encoding: 'utf8',
    });
    await until(() => (/via-\d+\.\d+\.\d+\.\d+ /.test(h.output(id)) ? true : undefined), 15_000);

    // Both pins are saved: a second connection asks nothing about keys.
    const { pins } = await h.engine.call('hostKeys.list', {});
    expect(pins.map((p) => p.host).sort()).toEqual(
      [HOST, INNER].map((x) => String(x).toLowerCase()).sort(),
    );
    const again = h.connect({ hostId: inner.id, action: { type: 'hold' }, cols: 80, rows: 24 });
    await h.waitFor(again, 'ready');
    expect(h.of(again).some((e) => e.type === 'host-key')).toBe(false);
    // SFTP works through the jump too.
    expect((await h.engine.call('files.list', { sessionId: again })).path).toBe(`/home/${USER}`);
  });

  it('uses ProxyJump from ~/.ssh/config and refuses loops', async () => {
    const h = await harness();
    const outer = await h.engine.call('hosts.save', { host: baseHost('bastion', HOST ?? '') });
    const inner = await h.engine.call('hosts.save', {
      host: { ...baseHost('inside', INNER ?? ''), proxyJump: `${USER}@bastion` },
    });
    const id = h.connect({ hostId: inner.id, action: { type: 'hold' }, cols: 80, rows: 24 });
    await h.waitFor(id, 'ready');

    // bastion → inside → bastion is a loop.
    await h.engine.call('hosts.save', {
      id: outer.id,
      host: { ...baseHost('bastion', HOST ?? ''), proxyJump: 'inside' },
    });
    const looped = h.connect({ hostId: inner.id, action: { type: 'hold' }, cols: 80, rows: 24 });
    const error = await h.waitFor(looped, 'error');
    expect(error).toMatchObject({ code: 'invalid_request' });
    expect(error.message).toMatch(/loop/);
    await expect(
      h.engine.call('hosts.save', {
        id: outer.id,
        host: { ...baseHost('bastion', HOST ?? ''), jumpHostId: inner.id },
      }),
    ).resolves.toBeTruthy();
    // jumpHostId chains are checked when saving.
    await expect(
      h.engine.call('hosts.save', {
        id: inner.id,
        host: { ...baseHost('inside', INNER ?? ''), jumpHostId: outer.id },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe.skipIf(!HOST)('port forwards', () => {
  it('forwards a local port, a SOCKS5 proxy and a remote port, with bytes counted', async () => {
    const h = await harness();
    const host = await h.engine.call('hosts.save', { host: baseHost('tunnels', HOST ?? '') });
    const id = h.connect({
      hostId: host.id,
      action: { type: 'shell', tmux: null },
      cols: 80,
      rows: 24,
    });
    await h.waitFor(id, 'ready');

    // -L: a local port to the server's own sshd.
    const localPort = await freePort();
    const local = await h.engine.call('forwards.start', {
      sessionId: id,
      spec: {
        kind: 'local',
        bindAddress: '127.0.0.1',
        bindPort: localPort,
        destHost: 'localhost',
        destPort: 22,
        allowPublic: false,
      },
    });
    expect(local).toMatchObject({ state: 'listening', kind: 'local' });
    expect(await readBanner(tcpConnect(localPort, '127.0.0.1'))).toMatch(/^SSH-2\.0-OpenSSH/);
    // The same port again is a clear error.
    await expect(
      h.engine.call('forwards.start', {
        sessionId: id,
        spec: {
          kind: 'local',
          bindAddress: '127.0.0.1',
          bindPort: localPort,
          destHost: 'localhost',
          destPort: 22,
          allowPublic: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'exists', message: expect.stringMatching(/already in use/) });
    // Not loopback without the explicit opt-in.
    await expect(
      h.engine.call('forwards.start', {
        sessionId: id,
        spec: {
          kind: 'local',
          bindAddress: '0.0.0.0',
          bindPort: await freePort(),
          destHost: 'localhost',
          destPort: 22,
          allowPublic: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    // -D: SOCKS5 CONNECT to localhost:22 as the server sees it.
    const socksPort = await freePort();
    await h.engine.call('forwards.start', {
      sessionId: id,
      spec: {
        kind: 'dynamic',
        bindAddress: '127.0.0.1',
        bindPort: socksPort,
        destHost: '',
        destPort: 0,
        allowPublic: false,
      },
    });
    const banner = await new Promise<string>((resolve, reject) => {
      const socket = tcpConnect(socksPort, '127.0.0.1');
      let stage = 0;
      let buffer = Buffer.alloc(0);
      socket.on('error', reject);
      socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 0 && buffer.length >= 2) {
          expect([...buffer.subarray(0, 2)]).toEqual([5, 0]);
          buffer = buffer.subarray(2);
          stage = 1;
          const name = Buffer.from('localhost');
          socket.write(
            Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([0, 22])]),
          );
        }
        if (stage === 1 && buffer.length >= 10) {
          expect(buffer[1]).toBe(0);
          buffer = buffer.subarray(10);
          stage = 2;
        }
        if (stage === 2 && buffer.includes(10)) {
          socket.destroy();
          resolve(buffer.toString('latin1').split('\n')[0] ?? '');
        }
      });
    });
    expect(banner).toMatch(/^SSH-2\.0-OpenSSH/);

    // -R: a port on the server reaches an echo server here.
    const echo = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const echoPort = (echo.address() as AddressInfo).port;
    const remotePort = 20000 + Math.floor(Math.random() * 20000);
    await h.engine.call('forwards.start', {
      sessionId: id,
      spec: {
        kind: 'remote',
        bindAddress: '127.0.0.1',
        bindPort: remotePort,
        destHost: '127.0.0.1',
        destPort: echoPort,
        allowPublic: false,
      },
    });
    h.engine.handle({
      type: 'input',
      sessionId: id,
      data: `exec 3<>/dev/tcp/127.0.0.1/${remotePort}; echo ping-back >&3; read -r line <&3; echo "got-$line"\n`,
      encoding: 'utf8',
    });
    await until(() => (/got-ping-back/.test(h.output(id)) ? true : undefined), 15_000);
    echo.close();

    const { forwards } = await h.engine.call('forwards.list', {});
    expect(forwards).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const counted = (await h.engine.call('forwards.list', {})).forwards;
    expect(counted.every((f) => f.bytesIn > 0)).toBe(true);

    // Stopping closes the listener; closing the session drops the rest.
    await h.engine.call('forwards.stop', { sessionId: id, id: local.id });
    await expect(readBanner(tcpConnect(localPort, '127.0.0.1'))).rejects.toThrow();
    h.engine.handle({ type: 'disconnect', sessionId: id });
    expect((await h.engine.call('forwards.list', {})).forwards).toEqual([]);
  });

  it('starts a saved "automatic" forward with the first session and reopens it after a drop', async () => {
    const h = await harness();
    const port = await freePort();
    const host = await h.engine.call('hosts.save', {
      host: {
        ...baseHost('auto', HOST ?? ''),
        forwards: [
          {
            id: 'f_00c0ffee',
            kind: 'local',
            bindAddress: '127.0.0.1',
            bindPort: port,
            destHost: 'localhost',
            destPort: 22,
            allowPublic: false,
            auto: true,
            label: 'sshd',
          },
        ],
      },
    });
    const id = await h.hold(host.id);
    await until(
      () =>
        h.of(id).some((e) => e.type === 'forwards' && e.forwards[0]?.state === 'listening')
          ? true
          : undefined,
      10_000,
    );
    expect(await readBanner(tcpConnect(port, '127.0.0.1'))).toMatch(/^SSH-2\.0/);
    const second = await h.hold(host.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await h.engine.call('forwards.list', {})).forwards).toHaveLength(1);

    const before = h.of(id).length;
    (h.engine as unknown as { sessions: Map<string, { client: { destroy(): void } }> }).sessions
      .get(id)
      ?.client.destroy();
    await h.waitFor(id, 'closed', before);
    expect((await h.engine.call('forwards.list', {})).forwards[0]?.state).toBe('paused');
    h.engine.handle({ type: 'reconnect', sessionId: id });
    await h.waitFor(id, 'ready', before);
    await until(
      () =>
        h
          .of(id)
          .slice(before)
          .some((e) => e.type === 'forwards' && e.forwards[0]?.state === 'listening')
          ? true
          : undefined,
      10_000,
    );
    expect(await readBanner(tcpConnect(port, '127.0.0.1'))).toMatch(/^SSH-2\.0/);
    h.engine.handle({ type: 'disconnect', sessionId: second });
  });
});
