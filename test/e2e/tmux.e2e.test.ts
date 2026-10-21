/**
 * Saved hosts and resumable (tmux) sessions against the test SSH server
 * (docker/test-sshd has tmux). Runs when QUQA_TEST_SSH_HOST is set.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Engine, type EngineMessage } from '../../src/engine/engine.js';
import type { HostAction, HostInput, SessionEvent } from '../../src/shared/ipc.js';

const HOST = process.env['QUQA_TEST_SSH_HOST'];
const PORT = Number(process.env['QUQA_TEST_SSH_PORT'] ?? 22);
const USER = process.env['QUQA_TEST_SSH_USER'] ?? 'quqa';
const PASSWORD = process.env['QUQA_TEST_SSH_PASSWORD'] ?? 'quqa-test-password';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'quqa-tmux-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const engines: Engine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.shutdown();
});

const host = (tmux: boolean): HostInput => ({
  name: 'test sshd',
  address: HOST ?? 'localhost',
  port: PORT,
  username: USER,
  auth: { kind: 'password' },
  os: 'linux',
  group: '',
  tags: [],
  notes: '',
  color: '',
  tmux,
  jumpHostId: null,
  proxyJump: '',
  scheme: '',
  font: '',
});

const tmuxName = () => `quqa-${randomBytes(16).toString('hex')}`;

async function setUp() {
  const events: EngineMessage[] = [];
  const engine: Engine = new Engine(
    (event) => {
      events.push(event);
      if (event.type === 'host-key') {
        queueMicrotask(() =>
          engine.handle({ type: 'host-key-answer', requestId: event.requestId, accept: true }),
        );
      }
      if (event.type === 'prompt') {
        queueMicrotask(() =>
          engine.handle({
            type: 'prompt-answer',
            requestId: event.requestId,
            answers: [PASSWORD],
            remember: true,
          }),
        );
      }
    },
    { connectTimeoutMs: 10_000, kdf: { memoryKiB: 64, iterations: 1, parallelism: 1 } },
  );
  engines.push(engine);
  await engine.call('vault.open', { path: join(root, `${randomBytes(6).toString('hex')}.json`) });
  await engine.call('vault.create', { mode: 'password', password: 'tmux e2e' });
  let ids = 0;
  const of = (id: string) =>
    events.filter((e): e is SessionEvent => 'sessionId' in e && e.sessionId === id);
  const until = async <T>(probe: () => T | undefined, ms = 15_000): Promise<T> => {
    const started = Date.now();
    for (;;) {
      const value = probe();
      if (value !== undefined) return value;
      if (Date.now() - started > ms) throw new Error('Timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const output = (id: string) =>
    Buffer.concat(of(id).flatMap((e) => (e.type === 'data' ? [Buffer.from(e.data)] : []))).toString(
      'utf8',
    );
  return {
    engine,
    of,
    connect(hostId: string, action: HostAction) {
      const sessionId = `s${++ids}`;
      engine.handle({
        type: 'connect',
        sessionId,
        request: { hostId, action, cols: 100, rows: 30 },
      });
      return sessionId;
    },
    waitFor<T extends SessionEvent['type']>(id: string, type: T) {
      return until(() => of(id).findLast((e) => e.type === type)) as Promise<
        Extract<SessionEvent, { type: T }>
      >;
    },
    waitForOutput: (id: string, pattern: RegExp) =>
      until(() => (pattern.test(output(id)) ? output(id) : undefined)),
    type(id: string, data: string) {
      engine.handle({ type: 'input', sessionId: id, data, encoding: 'utf8' });
    },
  };
}

describe.skipIf(!HOST)('saved hosts and resumable sessions', () => {
  it('connects by host id and counts the connection', async () => {
    const t = await setUp();
    const saved = await t.engine.call('hosts.save', { host: host(false) });
    const id = t.connect(saved.id, { type: 'shell', tmux: tmuxName() });
    // tmux is off for the host: a plain shell.
    expect((await t.waitFor(id, 'ready')).tmux).toBeNull();
    t.type(id, 'echo plain-$TMUX-shell\n');
    await t.waitForOutput(id, /plain--shell/);
    const [after] = (await t.engine.call('hosts.list', {})).hosts;
    expect(after?.connectCount).toBe(1);
    expect(after?.lastUsedAt).not.toBeNull();
  });

  it('runs the terminal in tmux, keeps it on close, lists it, re-attaches and ends it', async () => {
    const t = await setUp();
    const saved = await t.engine.call('hosts.save', { host: host(true) });
    const name = tmuxName();

    const first = t.connect(saved.id, { type: 'shell', tmux: name });
    expect((await t.waitFor(first, 'ready')).tmux).toBe(name);
    t.type(first, "export QUQA_MARK=kept''-alive; echo in-$TMUX\n");
    await t.waitForOutput(first, /in-\/tmp\/tmux-/);
    t.engine.handle({ type: 'disconnect', sessionId: first });

    // Listed from the host by a one-shot connection.
    const lister = t.connect(saved.id, { type: 'list' });
    const listed = await t.waitFor(lister, 'tmux-sessions');
    expect(listed.available).toBe(true);
    expect(listed.sessions.map((s) => s.name)).toContain(name);
    expect((await t.waitFor(lister, 'closed')).exitCode).toBe(0);

    // A second terminal re-attaches: the shell state is still there.
    const second = t.connect(saved.id, { type: 'shell', tmux: name });
    expect((await t.waitFor(second, 'ready')).tmux).toBe(name);
    t.type(second, 'echo mark=$QUQA_MARK\n');
    await t.waitForOutput(second, /mark=kept-alive/);

    // Listing over the live connection, then ending it on the host.
    t.engine.handle({ type: 'tmux', message: { sessionId: second, op: 'list' } });
    await t.waitFor(second, 'tmux-sessions');
    const ender = t.connect(saved.id, { type: 'end', session: name });
    const after = await t.waitFor(ender, 'tmux-sessions');
    expect(after.sessions.map((s) => s.name)).not.toContain(name);
    // The attached terminal sees its session end.
    await t.waitFor(second, 'closed');
  });

  it('drives tmux history (copy-mode) for the session only', async () => {
    const t = await setUp();
    const saved = await t.engine.call('hosts.save', { host: host(true) });
    const name = tmuxName();
    const id = t.connect(saved.id, { type: 'shell', tmux: name });
    await t.waitFor(id, 'ready');
    t.type(id, 'seq 1 300\n');
    await t.waitForOutput(id, /\b300\r?\n/);
    t.engine.handle({
      type: 'tmux',
      message: { sessionId: id, op: 'history', action: 'enter', lines: 0 },
    });
    expect(await t.waitFor(id, 'history')).toMatchObject({ inMode: true });
    t.engine.handle({
      type: 'tmux',
      message: { sessionId: id, op: 'history', action: 'scroll', lines: -20 },
    });
    await expect
      .poll(() => t.of(id).findLast((e) => e.type === 'history'))
      .toMatchObject({
        inMode: true,
        position: 20,
      });
    t.engine.handle({
      type: 'tmux',
      message: { sessionId: id, op: 'history', action: 'exit', lines: 0 },
    });
    await expect
      .poll(() => t.of(id).findLast((e) => e.type === 'history'))
      .toMatchObject({
        inMode: false,
      });
    t.engine.handle({ type: 'disconnect', sessionId: id });
    const ender = t.connect(saved.id, { type: 'end', session: name });
    await t.waitFor(ender, 'closed');
  });
});
