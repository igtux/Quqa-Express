import { describe, expect, it } from 'vitest';
import type { ForwardSpec } from '../shared/ipc.js';
import { checkSpec, isLoopback } from './forwards.js';

const spec = (change: Partial<ForwardSpec>): ForwardSpec => ({
  kind: 'local',
  bindAddress: '127.0.0.1',
  bindPort: 8080,
  destHost: 'db',
  destPort: 5432,
  allowPublic: false,
  ...change,
});

describe('forward checks', () => {
  it('knows loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(isLoopback(a)).toBe(true);
    }
    for (const a of ['0.0.0.0', '::', '10.0.0.5', '127.0.0.1.evil.com', 'host']) {
      expect(isLoopback(a)).toBe(false);
    }
  });

  it('needs the explicit opt-in for other addresses', () => {
    expect(() => checkSpec(spec({}))).not.toThrow();
    expect(() => checkSpec(spec({ bindAddress: '0.0.0.0' }))).toThrow(/confirm/);
    expect(() => checkSpec(spec({ bindAddress: '0.0.0.0', allowPublic: true }))).not.toThrow();
  });

  it('checks destinations by kind', () => {
    expect(() => checkSpec(spec({ kind: 'dynamic', destHost: '', destPort: 0 }))).not.toThrow();
    expect(() => checkSpec(spec({ kind: 'dynamic' }))).toThrow();
    expect(() => checkSpec(spec({ destHost: '' }))).toThrow();
    expect(() => checkSpec(spec({ kind: 'remote', destPort: 0 }))).toThrow();
  });
});
