import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../shared/ipc.js';
import {
  HIGH_WATER_BYTES,
  LOW_WATER_BYTES,
  MAX_LOCAL_SESSIONS,
  PtyEngine,
  type PtyProcess,
  type PtySpawnOptions,
} from './pty-engine.js';

class FakePty implements PtyProcess {
  readonly pid = 4242;
  written: (string | Buffer)[] = [];
  sizes: [number, number][] = [];
  paused = false;
  killed = false;
  private data: ((text: string) => void) | null = null;
  private exit: ((event: { exitCode: number }) => void) | null = null;

  onData(listener: (text: string) => void) {
    this.data = listener;
    return { dispose: () => (this.data = null) };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exit = listener;
    return { dispose: () => (this.exit = null) };
  }
  write(data: string | Buffer) {
    this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  kill() {
    this.killed = true;
  }
  output(text: string) {
    this.data?.(text);
  }
  end(exitCode: number) {
    this.exit?.({ exitCode });
  }
}

const SPAWN = {
  type: 'spawn',
  sessionId: 's1',
  file: '/bin/bash',
  args: [],
  cwd: '/home/me',
  env: { TERM: 'xterm-256color' },
  cols: 80,
  rows: 24,
} as const;

function harness(spawn?: (file: string, args: string[], options: PtySpawnOptions) => FakePty) {
  const events: SessionEvent[] = [];
  const ptys: FakePty[] = [];
  const calls: { file: string; args: string[]; options: PtySpawnOptions }[] = [];
  const engine = new PtyEngine(
    (file, args, options) => {
      calls.push({ file, args, options });
      const pty = spawn ? spawn(file, args, options) : new FakePty();
      ptys.push(pty);
      return pty;
    },
    (event) => events.push(event),
  );
  return { engine, events, ptys, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PtyEngine', () => {
  it('spawns what main sent, reports ready, relays output as UTF-8 bytes', () => {
    const { engine, events, ptys, calls } = harness();
    engine.handle(SPAWN);
    expect(calls).toEqual([
      {
        file: '/bin/bash',
        args: [],
        options: {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: '/home/me',
          env: { TERM: 'xterm-256color' },
        },
      },
    ]);
    expect(events).toEqual([{ type: 'ready', sessionId: 's1', tmux: null }]);
    ptys[0]?.output('გამარჯობა');
    const data = events[1];
    expect(data?.type).toBe('data');
    if (data?.type !== 'data') return;
    expect(Buffer.from(data.data).toString('utf8')).toBe('გამარჯობა');
    expect(data.data.byteLength).toBe(27);
  });

  it('writes input (binary as bytes), resizes, and ignores unknown sessions', () => {
    const { engine, ptys } = harness();
    engine.handle(SPAWN);
    engine.handle({ type: 'input', sessionId: 's1', data: 'echo ქ\r', encoding: 'utf8' });
    engine.handle({ type: 'input', sessionId: 's1', data: '\x1b[M\xff', encoding: 'binary' });
    engine.handle({ type: 'input', sessionId: 's9', data: 'x', encoding: 'utf8' });
    engine.handle({ type: 'resize', sessionId: 's1', cols: 120, rows: 40 });
    const pty = ptys[0];
    expect(pty?.written[0]).toBe('echo ქ\r');
    expect(Buffer.isBuffer(pty?.written[1])).toBe(true);
    expect([...(pty?.written[1] as Buffer)]).toEqual([0x1b, 0x5b, 0x4d, 0xff]);
    expect(pty?.written).toHaveLength(2);
    expect(pty?.sizes).toEqual([[120, 40]]);
  });

  it('rejects hostile or malformed commands', () => {
    const { engine, calls } = harness();
    const bad: unknown[] = [
      null,
      'spawn',
      { ...SPAWN, extra: true },
      { ...SPAWN, sessionId: 'l1' },
      { ...SPAWN, sessionId: 's1; rm -rf /' },
      { ...SPAWN, file: '' },
      { ...SPAWN, file: '/bin/sh\0' },
      { ...SPAWN, args: ['-c', 'x\0y'] },
      { ...SPAWN, args: Array.from({ length: 17 }, () => 'a') },
      { ...SPAWN, cols: 0 },
      { ...SPAWN, rows: 501 },
      { ...SPAWN, env: { PATH: 1 } },
      { type: 'exec', sessionId: 's1', command: 'calc.exe' },
      { type: 'input', sessionId: 's1', data: '', encoding: 'utf8' },
      { type: 'input', sessionId: 's1', data: 'x', encoding: 'utf16' },
    ];
    for (const message of bad) engine.handle(message);
    expect(calls).toEqual([]);
  });

  it('pauses past the high-water mark and resumes once acknowledged', () => {
    const { engine, ptys } = harness();
    engine.handle(SPAWN);
    const pty = ptys[0] as FakePty;
    const chunk = 'x'.repeat(64 * 1024);
    for (let sent = 0; sent <= HIGH_WATER_BYTES; sent += chunk.length) pty.output(chunk);
    expect(pty.paused).toBe(true);
    engine.handle({ type: 'ack', sessionId: 's1', bytes: HIGH_WATER_BYTES - LOW_WATER_BYTES });
    expect(pty.paused).toBe(true);
    engine.handle({ type: 'ack', sessionId: 's1', bytes: 128 * 1024 });
    expect(pty.paused).toBe(false);
  });

  it('reports the exit code after a short flush, and kills on request', () => {
    vi.useFakeTimers();
    const { engine, events, ptys } = harness();
    engine.handle(SPAWN);
    ptys[0]?.end(3);
    engine.handle({ type: 'input', sessionId: 's1', data: 'late', encoding: 'utf8' });
    expect(ptys[0]?.written).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(events.at(-1)).toEqual({ type: 'closed', sessionId: 's1', exitCode: 3 });
    expect(engine.size).toBe(0);

    engine.handle({ ...SPAWN, sessionId: 's2' });
    engine.handle({ type: 'kill', sessionId: 's2' });
    expect(ptys[1]?.killed).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'closed', sessionId: 's2', exitCode: null });
  });

  it('keeps node-pty error text (it can hold the command line) out of the event', () => {
    const { engine, events } = harness(() => {
      throw new Error('File not found: C:\\secret\\path.exe --token abc');
    });
    engine.handle(SPAWN);
    expect(events).toEqual([
      {
        type: 'error',
        sessionId: 's1',
        code: 'unreachable',
        message: 'The shell could not be started',
      },
      { type: 'closed', sessionId: 's1', exitCode: null },
    ]);
  });

  it('limits the number of local terminals', () => {
    const { engine, events, calls } = harness();
    for (let i = 1; i <= MAX_LOCAL_SESSIONS + 1; i++)
      engine.handle({ ...SPAWN, sessionId: `s${i}` });
    expect(calls).toHaveLength(MAX_LOCAL_SESSIONS);
    expect(events.at(-2)).toMatchObject({ type: 'error', code: 'too_many_sessions' });
  });

  it('shutdown kills every shell', () => {
    const { engine, ptys } = harness();
    engine.handle(SPAWN);
    engine.handle({ ...SPAWN, sessionId: 's2' });
    engine.handle({ type: 'shutdown' });
    expect(ptys.every((p) => p.killed)).toBe(true);
    expect(engine.size).toBe(0);
  });
});
