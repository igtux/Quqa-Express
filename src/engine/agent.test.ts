/**
 * The SSH agent: where it is looked for, listing its keys by fingerprint, and
 * logging in with it against an in-process ssh2 server, with a fake agent on
 * a Unix socket (ssh2's AgentProtocol in server mode). Agent forwarding is
 * requested on the shell only when the host has it switched on.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import ssh2, { type Connection, type ParsedKey } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostInput } from '../shared/ipc.js';
import { listAgentKeys, locateAgent, WINDOWS_AGENT_PIPE } from './agent.js';
import { Engine, type EngineMessage } from './engine.js';
import { fingerprintOf } from './host-keys.js';

const { AgentProtocol, Server, utils } = ssh2;
const onWindows = process.platform === 'win32';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A fresh Ed25519 key (ssh2 now and then cannot parse back one it generated: retry). */
function newKey(comment?: string): ParsedKey {
  for (let i = 0; i < 20; i++) {
    const pair = utils.generateKeyPairSync('ed25519', comment ? { comment } : {});
    const key = utils.parseKey(pair.private);
    if (!(key instanceof Error) && !Array.isArray(key)) return key;
  }
  throw new Error('no key');
}

/** A fake ssh-agent holding one key; counts signatures. */
async function fakeAgent(key: ParsedKey) {
  const dir = await mkdtemp(join(tmpdir(), 'quqa-agent-'));
  // Windows has no Unix sockets in a temp folder; the OpenSSH agent uses a named pipe there too.
  const path = onWindows ? `\\\\.\\pipe\\${basename(dir)}` : join(dir, 'agent.sock');
  const stats = { signs: 0, lists: 0 };
  const server = createServer((socket) => {
    const protocol = new AgentProtocol(false);
    protocol.on('identities', (request) => {
      stats.lists++;
      protocol.getIdentitiesReply(request, [key]);
    });
    protocol.on('sign', (request, _publicKey, data) => {
      stats.signs++;
      protocol.signReply(request, key.sign(data) as Buffer);
    });
    socket.pipe(protocol).pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { path, stats };
}

/** An ssh2 server that accepts only `allowed` (verifying the signature) and records agent requests. */
async function sshServer(allowed: ParsedKey) {
  const host = utils.generateKeyPairSync('ed25519');
  const seen = { agentRequests: 0, shells: 0 };
  const server = new Server({ hostKeys: [host.private] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      if (!ctx.key.data.equals(allowed.getPublicSSH())) return ctx.reject();
      if (!ctx.signature) return ctx.accept();
      const ok = ctx.blob && allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo);
      return ok === true ? ctx.accept() : ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('auth-agent', (ok) => {
          seen.agentRequests++;
          ok?.();
        });
        session.on('pty', (ok) => ok?.());
        session.on('shell', (ok) => {
          seen.shells++;
          const channel = ok();
          channel.write('agent-login-ok\r\n');
        });
      });
    });
    client.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as AddressInfo).port, seen };
}

async function engineWithVault() {
  const events: EngineMessage[] = [];
  const engine = new Engine(
    (event) => {
      events.push(event);
      if (event.type === 'host-key') {
        queueMicrotask(() =>
          engine.handle({ type: 'host-key-answer', requestId: event.requestId, accept: true }),
        );
      }
    },
    { connectTimeoutMs: 5000, kdf: { memoryKiB: 64, iterations: 1, parallelism: 1 } },
  );
  const dir = await mkdtemp(join(tmpdir(), 'quqa-agent-vault-'));
  cleanups.push(async () => {
    engine.shutdown();
    // Let a last vault write (the connect counter) finish first.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(dir, { recursive: true, force: true });
  });
  await engine.call('vault.open', { path: join(dir, 'vault.json') });
  await engine.call('vault.create', { mode: 'password', password: 'agent test' });
  const waitFor = async (predicate: (e: EngineMessage) => boolean, ms = 8000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for an engine event');
  };
  return { engine, events, waitFor };
}

const host = (port: number, agentForward: boolean): HostInput => ({
  name: 'agent host',
  address: '127.0.0.1',
  port,
  username: 'agent-user',
  auth: { kind: 'agent', agent: 'system' },
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
  agentForward,
  fileRoots: [],
  uploadDir: '',
  osc52: 'ask',
  forwards: [],
});

describe('locating the agent', () => {
  it('uses the OpenSSH pipe or Pageant on Windows and SSH_AUTH_SOCK elsewhere', () => {
    expect(locateAgent('system', {}, 'win32')).toEqual({ ok: true, path: WINDOWS_AGENT_PIPE });
    expect(WINDOWS_AGENT_PIPE).toBe('\\\\.\\pipe\\openssh-ssh-agent');
    expect(locateAgent('pageant', {}, 'win32')).toEqual({ ok: true, path: 'pageant' });
    expect(locateAgent('system', { SSH_AUTH_SOCK: '/tmp/a.sock' }, 'linux')).toEqual({
      ok: true,
      path: '/tmp/a.sock',
    });
    expect(locateAgent('system', {}, 'darwin')).toMatchObject({ ok: false });
    expect(locateAgent('system', { SSH_AUTH_SOCK: 'x\0y' }, 'linux')).toMatchObject({ ok: false });
    expect(locateAgent('pageant', {}, 'linux')).toMatchObject({ ok: false });
  });
});

describe('the SSH agent', () => {
  it('lists the keys by fingerprint, never more', async () => {
    const key = newKey('me@laptop\u0007');
    const agent = await fakeAgent(key);
    const listed = await listAgentKeys('system', { ok: true, path: agent.path });
    expect(listed).toEqual({
      available: true,
      message: '',
      keys: [
        {
          algorithm: 'ssh-ed25519',
          fingerprint: fingerprintOf(key.getPublicSSH()),
          comment: 'me@laptop',
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain('PRIVATE');
    expect(agent.stats.signs).toBe(0);
  });

  it('reports a missing or silent agent', async () => {
    expect(
      await listAgentKeys('pageant', { ok: false, message: 'Pageant exists only on Windows' }),
    ).toEqual({
      available: false,
      message: 'Pageant exists only on Windows',
      keys: [],
    });
    const missing = onWindows ? '\\\\.\\pipe\\quqa-no-such-agent' : join(tmpdir(), 'no-such.sock');
    const gone = await listAgentKeys('system', { ok: true, path: missing });
    expect(gone).toMatchObject({ available: false, keys: [] });
  });

  // On Windows the engine always uses the OpenSSH pipe, so a fake agent cannot stand in.
  it.skipIf(onWindows)(
    'logs in with the agent, and forwards it only when the host allows it',
    async () => {
      const key = newKey();
      const agent = await fakeAgent(key);
      const server = await sshServer(key);
      const previous = process.env['SSH_AUTH_SOCK'];
      process.env['SSH_AUTH_SOCK'] = agent.path;
      cleanups.push(() => {
        if (previous === undefined) delete process.env['SSH_AUTH_SOCK'];
        else process.env['SSH_AUTH_SOCK'] = previous;
      });
      const { engine, events, waitFor } = await engineWithVault();

      const plain = await engine.call('hosts.save', { host: host(server.port, false) });
      engine.handle({
        type: 'connect',
        sessionId: 's1',
        request: { hostId: plain.id, action: { type: 'shell', tmux: null }, cols: 80, rows: 24 },
      });
      await waitFor((e) => e.type === 'ready' && e.sessionId === 's1');
      expect(events.some((e) => e.type === 'prompt')).toBe(false);
      expect(agent.stats.signs).toBe(1);
      await waitFor((e) => e.type === 'data' && e.sessionId === 's1');
      expect(server.seen.agentRequests).toBe(0);

      const forwarding = await engine.call('hosts.save', { host: host(server.port, true) });
      engine.handle({
        type: 'connect',
        sessionId: 's2',
        request: {
          hostId: forwarding.id,
          action: { type: 'shell', tmux: null },
          cols: 80,
          rows: 24,
        },
      });
      await waitFor((e) => e.type === 'ready' && e.sessionId === 's2');
      expect(server.seen.agentRequests).toBe(1);
    },
  );

  it.skipIf(onWindows)('fails clearly when the agent does not hold an accepted key', async () => {
    const accepted = newKey();
    const other = newKey();
    const agent = await fakeAgent(other);
    const server = await sshServer(accepted);
    const previous = process.env['SSH_AUTH_SOCK'];
    process.env['SSH_AUTH_SOCK'] = agent.path;
    cleanups.push(() => {
      if (previous === undefined) delete process.env['SSH_AUTH_SOCK'];
      else process.env['SSH_AUTH_SOCK'] = previous;
    });
    const { engine, waitFor } = await engineWithVault();
    const saved = await engine.call('hosts.save', { host: host(server.port, false) });
    engine.handle({
      type: 'connect',
      sessionId: 's1',
      request: { hostId: saved.id, action: { type: 'hold' }, cols: 80, rows: 24 },
    });
    expect(await waitFor((e) => e.type === 'error')).toMatchObject({
      code: 'auth_failed',
      message: "The server accepted none of the agent's keys",
    });
    expect(agent.stats.signs).toBe(0);
  });
});
