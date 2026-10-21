import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../shared/ipc.js';
import { Engine } from './engine.js';

const request = {
  host: '127.0.0.1',
  port: 1,
  username: 'nobody',
  auth: { kind: 'password' as const, password: 'x' },
  cols: 80,
  rows: 24,
};

function collect() {
  const events: SessionEvent[] = [];
  const engine = new Engine((event) => events.push(event), undefined, { connectTimeoutMs: 2000 });
  const waitFor = async (predicate: (e: SessionEvent) => boolean, ms = 5000) => {
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

describe('Engine', () => {
  it('drops commands that fail the schema', () => {
    const { engine, events } = collect();
    engine.handle({ type: 'connect', sessionId: 's1', request: { ...request, host: 'a b' } });
    engine.handle({ type: 'exec', sessionId: 's1' });
    engine.handle(null);
    expect(events).toEqual([]);
    expect(engine.sessionCount).toBe(0);
  });

  it('reports an unreadable private key without connecting', async () => {
    const { engine, waitFor } = collect();
    engine.handle({
      type: 'connect',
      sessionId: 's1',
      request: { ...request, auth: { kind: 'key', privateKey: 'not a key' } },
    });
    const error = await waitFor((e) => e.type === 'error');
    expect(error).toMatchObject({ code: 'invalid_key' });
    await waitFor((e) => e.type === 'closed');
  });

  it('reports a refused TCP connection as unreachable', async () => {
    const { engine, waitFor } = collect();
    engine.handle({ type: 'connect', sessionId: 's1', request });
    expect(await waitFor((e) => e.type === 'error')).toMatchObject({ code: 'unreachable' });
    expect(await waitFor((e) => e.type === 'closed')).toMatchObject({ exitCode: null });
  });

  it('limits the number of sessions', async () => {
    const events: SessionEvent[] = [];
    const engine = new Engine((event) => events.push(event), undefined, { maxSessions: 1 });
    engine.handle({ type: 'connect', sessionId: 's1', request });
    engine.handle({ type: 'connect', sessionId: 's2', request });
    expect(events).toContainEqual(
      expect.objectContaining({ sessionId: 's2', type: 'error', code: 'too_many_sessions' }),
    );
    engine.shutdown();
  });

  it('answers a reconnect of an unknown session with a fatal error', () => {
    const { engine, events } = collect();
    engine.handle({ type: 'reconnect', sessionId: 's9' });
    expect(events[0]).toMatchObject({ type: 'error', code: 'invalid_request' });
    expect(events[1]).toMatchObject({ type: 'closed' });
  });
});
