/**
 * The SSH engine against a real OpenSSH server (docker/test-sshd). Runs when
 * QUQA_TEST_SSH_HOST is set, as in the dev container:
 *
 *   docker compose -f docker/compose.yml run --rm dev pnpm test:e2e
 */
import { utils } from 'ssh2';
import { afterEach, describe, expect, it } from 'vitest';
import { describeHostKey } from '../../src/engine/host-keys.js';
import { Engine, HIGH_WATER_BYTES } from '../../src/engine/engine.js';
import { KnownHosts } from '../../src/engine/known-hosts.js';
import type { ConnectRequest, SessionEvent } from '../../src/shared/ipc.js';

const HOST = process.env['QUQA_TEST_SSH_HOST'];
const PORT = Number(process.env['QUQA_TEST_SSH_PORT'] ?? 22);
const USER = process.env['QUQA_TEST_SSH_USER'] ?? 'quqa';
const PASSWORD = process.env['QUQA_TEST_SSH_PASSWORD'] ?? 'quqa-test-password';

const password: ConnectRequest = {
  host: HOST ?? 'localhost',
  port: PORT,
  username: USER,
  auth: { kind: 'password', password: PASSWORD },
  cols: 80,
  rows: 24,
};

class Harness {
  readonly events: SessionEvent[] = [];
  readonly engine: Engine;
  private ids = 0;

  constructor(
    readonly knownHosts = new KnownHosts(),
    /** Accept host-key prompts automatically (true), refuse (false), or leave them (null). */
    private readonly autoAccept: boolean | null = true,
  ) {
    this.engine = new Engine(
      (event) => {
        this.events.push(event);
        if (event.type === 'host-key' && this.autoAccept !== null) {
          queueMicrotask(() =>
            this.engine.handle({
              type: 'host-key-answer',
              requestId: event.requestId,
              accept: this.autoAccept,
            }),
          );
        }
      },
      knownHosts,
      { connectTimeoutMs: 10_000 },
    );
  }

  connect(request: ConnectRequest = password): string {
    const sessionId = `s${++this.ids}`;
    this.engine.handle({ type: 'connect', sessionId, request });
    return sessionId;
  }

  of(sessionId: string) {
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  async waitFor<T extends SessionEvent['type']>(
    sessionId: string,
    type: T,
    ms = 15_000,
  ): Promise<Extract<SessionEvent, { type: T }>> {
    const found = await until(() => this.of(sessionId).find((e) => e.type === type), ms);
    return found as Extract<SessionEvent, { type: T }>;
  }

  output(sessionId: string): string {
    return Buffer.concat(
      this.of(sessionId).flatMap((e) => (e.type === 'data' ? [Buffer.from(e.data)] : [])),
    ).toString('utf8');
  }

  received(sessionId: string): number {
    return this.of(sessionId).reduce((n, e) => n + (e.type === 'data' ? e.data.byteLength : 0), 0);
  }

  async waitForOutput(sessionId: string, pattern: RegExp, ms = 15_000): Promise<string> {
    return until(() => {
      const text = this.output(sessionId);
      return pattern.test(text) ? text : undefined;
    }, ms);
  }

  type(sessionId: string, data: string) {
    this.engine.handle({ type: 'input', sessionId, data, encoding: 'utf8' });
  }

  /** Acknowledges everything received so far, as the renderer does after drawing. */
  ackAll(sessionId: string, already: { acked: number }) {
    const total = this.received(sessionId);
    if (total > already.acked) {
      this.engine.handle({ type: 'ack', sessionId, bytes: total - already.acked });
      already.acked = total;
    }
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
function harness(...args: ConstructorParameters<typeof Harness>) {
  const h = new Harness(...args);
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.engine.shutdown();
});

describe.skipIf(!HOST)('SSH engine against a real server', () => {
  it('asks about the host key, runs a command, resizes and disconnects', async () => {
    const h = harness();
    const id = h.connect();
    const prompt = await h.waitFor(id, 'host-key');
    expect(prompt.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(prompt.algorithm).toMatch(/^(ssh-ed25519|ecdsa-|rsa-|ssh-rsa)/);
    await h.waitFor(id, 'ready');

    // Quotes keep the typed command from matching the pattern by its echo.
    h.type(id, "echo hel''lo\n");
    await h.waitForOutput(id, /\bhello\r?\n/);

    h.engine.handle({ type: 'resize', sessionId: id, cols: 100, rows: 30 });
    h.type(id, 'stty size\n');
    await h.waitForOutput(id, /\b30 100\b/);

    expect(h.of(id).some((e) => e.type === 'closed')).toBe(false);
    h.engine.handle({ type: 'disconnect', sessionId: id });
    await h.waitFor(id, 'closed');
    expect(h.engine.sessionCount).toBe(0);
  });

  it('does not ask again for an accepted key', async () => {
    const h = harness();
    await h.waitFor(h.connect(), 'ready');
    const second = h.connect();
    await h.waitFor(second, 'ready');
    expect(h.of(second).some((e) => e.type === 'host-key')).toBe(false);
  });

  it('refuses a changed host key', async () => {
    const knownHosts = new KnownHosts();
    // Pin some other ed25519 key for the server.
    const other = utils.parseKey(utils.generateKeyPairSync('ed25519').public);
    if (other instanceof Error) throw other;
    knownHosts.accept(password.host, PORT, describeHostKey(other.getPublicSSH()));
    const h = harness(knownHosts);
    const id = h.connect();
    const error = await h.waitFor(id, 'error');
    expect(error.code).toBe('host_key_mismatch');
    expect(error.message).toMatch(/has changed .*SHA256:/);
    expect(h.of(id).some((e) => e.type === 'host-key')).toBe(false);
    await h.waitFor(id, 'closed');
  });

  it('stops when the user rejects the host key', async () => {
    const h = harness(new KnownHosts(), false);
    const id = h.connect();
    expect((await h.waitFor(id, 'error')).code).toBe('host_key_rejected');
    expect(h.of(id).some((e) => e.type === 'ready')).toBe(false);
  });

  it('waits for the user on the host-key prompt without timing out', async () => {
    const events: SessionEvent[] = [];
    const engine = new Engine((e) => events.push(e), new KnownHosts(), { connectTimeoutMs: 1000 });
    try {
      engine.handle({ type: 'connect', sessionId: 's1', request: password });
      const prompt = await until(() => events.find((e) => e.type === 'host-key'), 10_000);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(events.some((e) => e.type === 'error')).toBe(false);
      if (prompt.type !== 'host-key') throw new Error('unreachable');
      engine.handle({ type: 'host-key-answer', requestId: prompt.requestId, accept: true });
      await until(() => events.find((e) => e.type === 'ready'), 10_000);
    } finally {
      engine.shutdown();
    }
  });

  it('reports a wrong password', async () => {
    const h = harness();
    const id = h.connect({ ...password, auth: { kind: 'password', password: 'wrong' } });
    expect((await h.waitFor(id, 'error')).code).toBe('auth_failed');
    await h.waitFor(id, 'closed');
  });

  it('logs in with an encrypted private key', async () => {
    const pair = utils.generateKeyPairSync('ed25519', {
      passphrase: 'correct horse',
      cipher: 'aes256-ctr',
      rounds: 16,
      comment: 'quqa-e2e',
    });
    // Install the public key over a password session.
    const h = harness();
    const setup = h.connect();
    await h.waitFor(setup, 'ready');
    h.type(
      setup,
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${pair.public}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo inst''alled\n`,
    );
    await h.waitForOutput(setup, /\binstalled\r?\n/);

    const key = h.connect({
      ...password,
      auth: { kind: 'key', privateKey: pair.private, passphrase: 'correct horse' },
    });
    await h.waitFor(key, 'ready');
    h.type(key, 'echo key-lo""gin\n');
    await h.waitForOutput(key, /\bkey-login\r?\n/);

    const wrong = h.connect({
      ...password,
      auth: { kind: 'key', privateKey: pair.private, passphrase: 'wrong' },
    });
    expect((await h.waitFor(wrong, 'error')).code).toBe('invalid_key');
    const missing = h.connect({ ...password, auth: { kind: 'key', privateKey: pair.private } });
    expect((await h.waitFor(missing, 'error')).message).toMatch(/passphrase/);
  });

  it('pauses output the terminal has not drawn, and resumes on ack', async () => {
    const h = harness();
    const id = h.connect();
    await h.waitFor(id, 'ready');
    const acked = { acked: 0 };
    await new Promise((resolve) => setTimeout(resolve, 300));
    h.ackAll(id, acked);

    // ~13 MB of output; nothing is acknowledged while it streams.
    h.type(id, 'head -c 10000000 /dev/zero | base64 -w 0; echo; echo do""ne\n');
    await until(() => (h.received(id) - acked.acked > HIGH_WATER_BYTES ? true : undefined), 15_000);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const stalled = h.received(id) - acked.acked;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(h.received(id) - acked.acked).toBe(stalled);
    // Paused: at most the high-water mark plus what was already in flight.
    expect(stalled).toBeLessThan(HIGH_WATER_BYTES + 4 * 1024 * 1024);

    const done = until(
      () => (/\bdone\r?\n/.test(h.output(id).slice(-200)) ? true : undefined),
      60_000,
    );
    const pump = setInterval(() => h.ackAll(id, acked), 20);
    try {
      await done;
    } finally {
      clearInterval(pump);
    }
    expect(h.received(id)).toBeGreaterThan(13_000_000);
  }, 90_000);

  it('reports the shell exit status', async () => {
    const h = harness();
    const id = h.connect();
    await h.waitFor(id, 'ready');
    h.type(id, 'exit 3\n');
    expect((await h.waitFor(id, 'closed')).exitCode).toBe(3);
    expect(h.of(id).some((e) => e.type === 'error')).toBe(false);

    // The session can be reopened with the credentials the engine kept.
    h.engine.handle({ type: 'reconnect', sessionId: id });
    await until(
      () => (h.of(id).filter((e) => e.type === 'ready').length === 2 ? true : undefined),
      15_000,
    );
  });
});
