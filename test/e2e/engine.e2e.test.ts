/**
 * The SSH engine against a real OpenSSH server (docker/test-sshd). Runs when
 * QUQA_TEST_SSH_HOST is set, as in the dev container:
 *
 *   docker compose -f docker/compose.yml run --rm dev pnpm test:e2e
 *
 * Every test gets its own vault in a temporary folder; keys are generated at
 * run time and installed over a password session.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Engine, HIGH_WATER_BYTES, type EngineMessage } from '../../src/engine/engine.js';
import type { AdhocConnect, ConnectRequest, SessionEvent } from '../../src/shared/ipc.js';
import { ed25519Pair } from '../keypair.js';

const { Client, utils } = ssh2;

const HOST = process.env['QUQA_TEST_SSH_HOST'];
const PORT = Number(process.env['QUQA_TEST_SSH_PORT'] ?? 22);
const USER = process.env['QUQA_TEST_SSH_USER'] ?? 'quqa';
const PASSWORD = process.env['QUQA_TEST_SSH_PASSWORD'] ?? 'quqa-test-password';
const VAULT_PASSWORD = 'e2e vault password';
const FAST_KDF = { memoryKiB: 64, iterations: 1, parallelism: 1 };

const password: AdhocConnect = {
  host: HOST ?? 'localhost',
  port: PORT,
  username: USER,
  auth: { kind: 'password' },
  cols: 80,
  rows: 24,
};

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'quqa-e2e-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface HarnessOptions {
  /** Accept host-key prompts automatically (true), refuse (false), or leave them (null). */
  acceptHostKeys?: boolean | null;
  /** Answers credential prompts with this (null: leave them unanswered). */
  answer?: ((event: Extract<SessionEvent, { type: 'prompt' }>) => string[] | null) | null;
  remember?: boolean;
  /** Re-use a vault file (to test persistence). */
  vaultPath?: string;
}

class Harness {
  readonly events: EngineMessage[] = [];
  readonly engine: Engine;
  readonly vaultPath: string;
  private ids = 0;

  constructor(private readonly options: HarnessOptions = {}) {
    this.vaultPath = options.vaultPath ?? join(root, `${randomBytes(6).toString('hex')}.json`);
    this.engine = new Engine(
      (event) => {
        this.events.push(event);
        const accept = this.options.acceptHostKeys ?? true;
        if (event.type === 'host-key' && accept !== null) {
          queueMicrotask(() =>
            this.engine.handle({ type: 'host-key-answer', requestId: event.requestId, accept }),
          );
        }
        if (event.type === 'prompt' && this.options.answer !== null) {
          const answers = (this.options.answer ?? (() => [PASSWORD]))(event);
          queueMicrotask(() =>
            this.engine.handle({
              type: 'prompt-answer',
              requestId: event.requestId,
              answers,
              remember: this.options.remember ?? false,
            }),
          );
        }
      },
      { connectTimeoutMs: 10_000, kdf: FAST_KDF },
    );
  }

  /** Opens (creating if needed) and unlocks the vault. */
  async open(): Promise<this> {
    await this.engine.call('vault.open', { path: this.vaultPath });
    const { state } = await this.engine.call('vault.status', {});
    if (state === 'absent') {
      await this.engine.call('vault.create', { mode: 'password', password: VAULT_PASSWORD });
    } else {
      await this.engine.call('vault.unlock', { password: VAULT_PASSWORD });
    }
    return this;
  }

  connect(request: ConnectRequest = password): string {
    const sessionId = `s${++this.ids}`;
    this.engine.handle({ type: 'connect', sessionId, request });
    return sessionId;
  }

  of(sessionId: string): SessionEvent[] {
    return this.events.filter(
      (e): e is SessionEvent => 'sessionId' in e && e.sessionId === sessionId,
    );
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

  /** Appends a public key to ~/.ssh/authorized_keys over a password session. */
  async install(publicKey: string) {
    const id = this.connect();
    await this.waitFor(id, 'ready');
    this.type(
      id,
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo inst''alled\n`,
    );
    await this.waitForOutput(id, /\binstalled\r?\n/);
    this.engine.handle({ type: 'disconnect', sessionId: id });
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

/** The server's ed25519 host key blob, read without authenticating. */
function scanHostKey(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let key: Buffer | null = null;
    const done = () => (key ? resolve(key) : reject(new Error('no host key')));
    client.on('error', done);
    client.on('close', done);
    client.connect({
      host: password.host,
      port: PORT,
      username: 'scan',
      algorithms: { serverHostKey: ['ssh-ed25519'] },
      hostVerifier: (blob: Buffer) => {
        key = blob;
        return false;
      },
    });
  });
}

const harnesses: Harness[] = [];
async function harness(options?: HarnessOptions) {
  const h = new Harness(options);
  harnesses.push(h);
  return h.open();
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.engine.shutdown();
});

describe.skipIf(!HOST)('SSH engine against a real server', () => {
  it('checks the host key first, then asks for the password, runs a command and resizes', async () => {
    const h = await harness();
    const id = h.connect();
    const prompt = await h.waitFor(id, 'host-key');
    expect(prompt.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(prompt.algorithm).toMatch(/^(ssh-ed25519|ecdsa-|rsa-|ssh-rsa)/);
    const password = await h.waitFor(id, 'prompt');
    expect(password).toMatchObject({ kind: 'password', canRemember: true, message: '' });
    expect(password.title).toContain(`${USER}@`);
    const events = h.of(id).map((e) => e.type);
    expect(events.indexOf('host-key')).toBeLessThan(events.indexOf('prompt'));
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

  it('remembers an accepted host key across an engine restart', async () => {
    const first = await harness();
    await first.waitFor(first.connect(), 'ready');
    const again = first.connect();
    await first.waitFor(again, 'ready');
    expect(first.of(again).some((e) => e.type === 'host-key')).toBe(false);
    const { pins } = await first.engine.call('hostKeys.list', {});
    expect(pins).toEqual([
      expect.objectContaining({ host: password.host.toLowerCase(), port: PORT, source: 'trusted' }),
    ]);
    first.engine.shutdown();

    const second = await harness({ vaultPath: first.vaultPath, acceptHostKeys: null });
    const id = second.connect();
    await second.waitFor(id, 'ready');
    expect(second.of(id).some((e) => e.type === 'host-key')).toBe(false);
  });

  it('blocks a changed host key, shows both fingerprints, and connects after the pin is replaced', async () => {
    const h = await harness({ acceptHostKeys: false });
    // A known_hosts entry pinning some other key for the server.
    const other = utils.parseKey(ed25519Pair().public);
    if (other instanceof Error || Array.isArray(other)) throw new Error('bad key');
    const name = PORT === 22 ? password.host : `[${password.host}]:${PORT}`;
    const file = join(root, `known_hosts-${randomBytes(4).toString('hex')}`);
    await writeFile(file, `${name} ssh-ed25519 ${other.getPublicSSH().toString('base64')}\n`);
    expect(await h.engine.call('hostKeys.importPath', { path: file })).toMatchObject({
      imported: 1,
    });

    const id = h.connect();
    const change = await h.waitFor(id, 'host-key-changed');
    const error = await h.waitFor(id, 'error');
    expect(error.code).toBe('host_key_mismatch');
    expect(error.message).toMatch(/has changed .*SHA256:/);
    expect(change.previous).toHaveLength(1);
    expect(change.previous[0]?.fingerprint).not.toBe(change.fingerprint);
    expect(change.fingerprint).toMatch(/^SHA256:/);
    expect(h.of(id).some((e) => e.type === 'host-key' || e.type === 'prompt')).toBe(false);
    await h.waitFor(id, 'closed');

    // Still blocked on a retry until the user replaces the pin.
    const before = h.of(id).length;
    h.engine.handle({ type: 'reconnect', sessionId: id });
    await until(
      () =>
        h
          .of(id)
          .slice(before)
          .some((e) => e.type === 'closed')
          ? true
          : undefined,
      15_000,
    );
    const retry = h.of(id).slice(before);
    expect(retry.find((e) => e.type === 'error')).toMatchObject({ code: 'host_key_mismatch' });
    const latest = retry.find((e) => e.type === 'host-key-changed');
    if (latest?.type !== 'host-key-changed') throw new Error('no change event');

    // The first token was superseded; the latest one works once.
    await expect(
      h.engine.call('hostKeys.replace', { requestId: change.requestId }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await h.engine.call('hostKeys.replace', { requestId: latest.requestId });
    await expect(
      h.engine.call('hostKeys.replace', { requestId: latest.requestId }),
    ).rejects.toMatchObject({ code: 'not_found' });
    h.engine.handle({ type: 'reconnect', sessionId: id });
    await until(() => (h.of(id).some((e) => e.type === 'ready') ? true : undefined), 15_000);
    const { pins } = await h.engine.call('hostKeys.list', {});
    expect(pins).toEqual([
      expect.objectContaining({ fingerprint: latest.fingerprint, source: 'trusted' }),
    ]);
  });

  it('trusts a hashed known_hosts entry', async () => {
    const blob = await scanHostKey();
    const salt = randomBytes(20);
    const name =
      PORT === 22 ? password.host.toLowerCase() : `[${password.host.toLowerCase()}]:${PORT}`;
    const hash = createHmac('sha1', salt).update(name).digest();
    const file = join(root, `known_hosts-${randomBytes(4).toString('hex')}`);
    await writeFile(
      file,
      `|1|${salt.toString('base64')}|${hash.toString('base64')} ssh-ed25519 ${blob.toString('base64')}\n`,
    );
    const h = await harness({ acceptHostKeys: null });
    expect(await h.engine.call('hostKeys.importPath', { path: file })).toMatchObject({ hashed: 1 });
    const id = h.connect();
    await h.waitFor(id, 'ready');
    expect(h.of(id).some((e) => e.type === 'host-key')).toBe(false);
  });

  it('stops when the user rejects the host key', async () => {
    const h = await harness({ acceptHostKeys: false });
    const id = h.connect();
    expect((await h.waitFor(id, 'error')).code).toBe('host_key_rejected');
    expect(h.of(id).some((e) => e.type === 'ready' || e.type === 'prompt')).toBe(false);
  });

  it('waits for the user on prompts without timing out', async () => {
    const h = new Harness({ acceptHostKeys: null, answer: null });
    harnesses.push(h);
    await h.open();
    // A short connect timeout: prompts must not count against it.
    const engine = h.engine as unknown as { options: { connectTimeoutMs: number } };
    engine.options.connectTimeoutMs = 1000;
    const id = h.connect();
    const hostKey = await h.waitFor(id, 'host-key');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(h.of(id).some((e) => e.type === 'error')).toBe(false);
    h.engine.handle({ type: 'host-key-answer', requestId: hostKey.requestId, accept: true });
    const prompt = await h.waitFor(id, 'prompt');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(h.of(id).some((e) => e.type === 'error')).toBe(false);
    h.engine.handle({
      type: 'prompt-answer',
      requestId: prompt.requestId,
      answers: [PASSWORD],
      remember: false,
    });
    await h.waitFor(id, 'ready');
  });

  it('asks again after a wrong password, and stops when cancelled', async () => {
    let asked = 0;
    const h = await harness({
      answer: () => (++asked === 1 ? ['wrong'] : [PASSWORD]),
    });
    const id = h.connect();
    await h.waitFor(id, 'ready');
    const prompts = h.of(id).filter((e) => e.type === 'prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatchObject({ message: expect.stringMatching(/rejected/) });

    const cancel = await harness({ answer: () => null });
    const cancelled = cancel.connect();
    expect((await cancel.waitFor(cancelled, 'error')).code).toBe('auth_cancelled');
    await cancel.waitFor(cancelled, 'closed');
  });

  it('gives up after three wrong passwords', async () => {
    const h = await harness({ answer: () => ['wrong'] });
    const id = h.connect();
    expect((await h.waitFor(id, 'error', 30_000)).code).toBe('auth_failed');
    expect(h.of(id).filter((e) => e.type === 'prompt')).toHaveLength(3);
  });

  it('saves a password only when asked, and only after it worked', async () => {
    const h = await harness({ remember: true });
    await h.waitFor(h.connect(), 'ready');
    const second = h.connect();
    await h.waitFor(second, 'ready');
    expect(h.of(second).some((e) => e.type === 'prompt')).toBe(false);
  });

  it('logs in with a generated key from the vault', async () => {
    const h = await harness();
    const key = await h.engine.call('keys.generate', { label: 'e2e generated' });
    await h.install(key.publicKey);
    const id = h.connect({ ...password, auth: { kind: 'key', keyId: key.id } });
    await h.waitFor(id, 'ready');
    expect(h.of(id).some((e) => e.type === 'prompt')).toBe(false);
    h.type(id, 'echo key-lo""gin\n');
    await h.waitForOutput(id, /\bkey-login\r?\n/);
  });

  it('logs in with an imported encrypted key, asking for its passphrase once per unlock', async () => {
    const pair = ed25519Pair({
      passphrase: 'correct horse',
      cipher: 'aes256-ctr',
      rounds: 16,
      comment: 'quqa-e2e',
    });
    let wrongFirst = true;
    const h = await harness({
      answer: (event) => {
        if (event.kind !== 'passphrase') return [PASSWORD];
        const answer = wrongFirst ? 'wrong' : 'correct horse';
        wrongFirst = false;
        return [answer];
      },
    });
    await h.install(pair.public);
    const key = await h.engine.call('keys.import', {
      label: 'imported',
      privateKey: pair.private,
      passphrase: 'correct horse',
      savePassphrase: false,
    });
    const id = h.connect({ ...password, auth: { kind: 'key', keyId: key.id } });
    await h.waitFor(id, 'ready');
    const asked = h.of(id).filter((e) => e.type === 'prompt');
    expect(asked.map((e) => e.type === 'prompt' && e.kind)).toEqual(['passphrase', 'passphrase']);
    expect(asked[1]).toMatchObject({ message: expect.stringMatching(/wrong/) });

    // Known for the rest of this unlock: no prompt the second time.
    const again = h.connect({ ...password, auth: { kind: 'key', keyId: key.id } });
    await h.waitFor(again, 'ready');
    expect(h.of(again).some((e) => e.type === 'prompt')).toBe(false);

    // Locking forgets it.
    await h.engine.call('vault.lock', {});
    await h.engine.call('vault.unlock', { password: VAULT_PASSWORD });
    const third = h.connect({ ...password, auth: { kind: 'key', keyId: key.id } });
    await h.waitFor(third, 'ready');
    expect(h.of(third).some((e) => e.type === 'prompt')).toBe(true);
  });

  it('pauses output the terminal has not drawn, and resumes on ack', async () => {
    const h = await harness();
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

  it('reports the shell exit status and reconnects with the password it kept', async () => {
    const h = await harness();
    const id = h.connect();
    await h.waitFor(id, 'ready');
    h.type(id, 'exit 3\n');
    expect((await h.waitFor(id, 'closed')).exitCode).toBe(3);
    expect(h.of(id).some((e) => e.type === 'error')).toBe(false);

    h.engine.handle({ type: 'reconnect', sessionId: id });
    await until(
      () => (h.of(id).filter((e) => e.type === 'ready').length === 2 ? true : undefined),
      15_000,
    );
    expect(h.of(id).filter((e) => e.type === 'prompt')).toHaveLength(1);
  });
});
