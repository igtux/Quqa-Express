import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectRequest } from '../shared/ipc.js';
import { Engine, type EngineMessage } from './engine.js';

const request: ConnectRequest = {
  host: '127.0.0.1',
  port: 1,
  username: 'nobody',
  auth: { kind: 'password' },
  cols: 80,
  rows: 24,
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function collect(options: { unlock?: boolean; maxSessions?: number } = {}) {
  const events: EngineMessage[] = [];
  const engine = new Engine((event) => events.push(event), {
    connectTimeoutMs: 2000,
    kdf: { memoryKiB: 64, iterations: 1, parallelism: 1 },
    ...(options.maxSessions !== undefined && { maxSessions: options.maxSessions }),
  });
  const dir = await mkdtemp(join(tmpdir(), 'quqa-engine-'));
  dirs.push(dir);
  await engine.call('vault.open', { path: join(dir, 'vault.json') });
  if (options.unlock !== false) {
    await engine.call('vault.create', { mode: 'password', password: 'engine test' });
  }
  const waitFor = async (predicate: (e: EngineMessage) => boolean, ms = 5000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for an engine event');
  };
  return { engine, events, waitFor, dir };
}

describe('Engine commands', () => {
  it('drops commands that fail the schema', async () => {
    const { engine, events } = await collect();
    events.length = 0;
    engine.handle({ type: 'connect', sessionId: 's1', request: { ...request, host: 'a b' } });
    engine.handle({
      type: 'connect',
      sessionId: 's1',
      request: { ...request, auth: { kind: 'password', password: 'secret' } },
    });
    engine.handle({ type: 'exec', sessionId: 's1' });
    engine.handle({ type: 'prompt-answer', requestId: 'p1', answers: ['x'] });
    engine.handle(null);
    expect(events).toEqual([]);
    expect(engine.sessionCount).toBe(0);
  });

  it('answers calls through handle, and refuses unknown methods and bad parameters', async () => {
    const { engine, waitFor } = await collect();
    engine.handle({ type: 'call', callId: 1, method: 'keys.list', params: {} });
    expect(await waitFor((e) => e.type === 'result' && e.callId === 1)).toEqual({
      type: 'result',
      callId: 1,
      ok: true,
      value: { keys: [] },
    });
    engine.handle({ type: 'call', callId: 2, method: 'constructor', params: {} });
    expect(await waitFor((e) => e.type === 'result' && e.callId === 2)).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    engine.handle({ type: 'call', callId: 3, method: 'keys.generate', params: { label: 'a\nb' } });
    expect(await waitFor((e) => e.type === 'result' && e.callId === 3)).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });

  it('refuses to connect while the vault is locked', async () => {
    const { engine, waitFor } = await collect();
    await engine.call('vault.lock', {});
    engine.handle({ type: 'connect', sessionId: 's1', request });
    expect(await waitFor((e) => e.type === 'error')).toMatchObject({ code: 'vault_locked' });
    await waitFor((e) => e.type === 'closed');
  });

  it('reports a key that is not in the vault without connecting', async () => {
    const { engine, waitFor } = await collect();
    engine.handle({
      type: 'connect',
      sessionId: 's1',
      request: { ...request, auth: { kind: 'key', keyId: 'key_0000000000000000' } },
    });
    expect(await waitFor((e) => e.type === 'error')).toMatchObject({ code: 'invalid_key' });
    await waitFor((e) => e.type === 'closed');
  });

  it('reports a refused TCP connection as unreachable', async () => {
    const { engine, waitFor } = await collect();
    engine.handle({ type: 'connect', sessionId: 's1', request });
    expect(await waitFor((e) => e.type === 'error')).toMatchObject({ code: 'unreachable' });
    expect(await waitFor((e) => e.type === 'closed')).toMatchObject({ exitCode: null });
  });

  it('limits the number of sessions', async () => {
    const { engine, events } = await collect({ maxSessions: 1 });
    engine.handle({ type: 'connect', sessionId: 's1', request });
    engine.handle({ type: 'connect', sessionId: 's2', request });
    expect(events).toContainEqual(
      expect.objectContaining({ sessionId: 's2', type: 'error', code: 'too_many_sessions' }),
    );
    engine.shutdown();
  });

  it('answers a reconnect of an unknown session with a fatal error', async () => {
    const { engine, events } = await collect();
    events.length = 0;
    engine.handle({ type: 'reconnect', sessionId: 's9' });
    expect(events[0]).toMatchObject({ type: 'error', code: 'invalid_request' });
    expect(events[1]).toMatchObject({ type: 'closed' });
  });
});

describe('Engine vault calls', () => {
  it('reports vault state changes and forgets everything on lock', async () => {
    const { engine, events } = await collect({ unlock: false });
    expect(await engine.call('vault.status', {})).toMatchObject({
      state: 'absent',
      settings: null,
    });
    await engine.call('vault.create', { mode: 'password', password: 'engine test' });
    const status = await engine.call('vault.status', {});
    expect(status).toMatchObject({
      state: 'unlocked',
      mode: 'password',
      osBlob: null,
      settings: { autoLockMinutes: 15, lockOnSleep: true },
    });
    await engine.call('keys.generate', { label: 'one' });
    await engine.call('vault.lock', {});
    await expect(engine.call('keys.list', {})).rejects.toMatchObject({ code: 'locked' });
    await expect(engine.call('hostKeys.list', {})).rejects.toMatchObject({ code: 'locked' });
    await expect(engine.call('vault.unlock', { password: 'nope' })).rejects.toMatchObject({
      code: 'wrong_password',
    });
    await engine.call('vault.unlock', { password: 'engine test' });
    expect((await engine.call('keys.list', {})).keys).toHaveLength(1);
    const states = events.flatMap((e) => (e.type === 'vault-state' ? [e.state] : []));
    expect(states).toEqual(['unlocked', 'locked', 'unlocked']);
  });

  it('imports known_hosts from a path and lists pins without key blobs', async () => {
    const { engine, dir } = await collect();
    const missing = await engine.call('hostKeys.importPath', { path: join(dir, 'nope') });
    expect(missing).toEqual({ found: false, imported: 0, hashed: 0, skipped: 0 });
    const blob = 'AAAAC3NzaC1lZDI1NTE5AAAAIF2K8STiP1WH2Lprxl+eGXhAus3a9xSArFcbGbeKFb4Y';
    await writeFile(
      join(dir, 'known_hosts'),
      `server ssh-ed25519 ${blob}\n*.lan ssh-ed25519 ${blob}\n`,
    );
    expect(await engine.call('hostKeys.importPath', { path: join(dir, 'known_hosts') })).toEqual({
      found: true,
      imported: 1,
      hashed: 0,
      skipped: 1,
    });
    const { pins } = await engine.call('hostKeys.list', {});
    expect(pins).toEqual([
      expect.objectContaining({
        host: 'server',
        port: 22,
        fingerprint: 'SHA256:sSVbvq85ZNE3fKJF/ZmlmWM9ILBZmNn0YRBow4EAdEU',
        source: 'known_hosts',
      }),
    ]);
    expect(JSON.stringify(pins)).not.toContain(blob);
    await engine.call('hostKeys.forget', { host: 'server', port: 22 });
    expect((await engine.call('hostKeys.list', {})).pins).toEqual([]);
  });

  it('refuses an unknown host-key change token', async () => {
    const { engine } = await collect();
    await expect(engine.call('hostKeys.replace', { requestId: 'c42' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('reads key files and refuses large ones', async () => {
    const { engine, dir } = await collect();
    await writeFile(join(dir, 'big'), 'x'.repeat(40 * 1024));
    await expect(
      engine.call('keys.importPath', {
        label: 'big',
        path: join(dir, 'big'),
        savePassphrase: false,
      }),
    ).rejects.toMatchObject({ code: 'io' });
    await expect(
      engine.call('keys.importPath', {
        label: 'none',
        path: join(dir, 'none'),
        savePassphrase: false,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
