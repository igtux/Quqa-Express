/**
 * The local terminal process (ADR 0007): one pseudo-terminal per session,
 * through node-pty (ConPTY on Windows). It runs in its own Electron
 * utilityProcess, apart from the SSH engine and the vault, and is plain Node
 * so tests drive it directly with the real node-pty.
 *
 * Main decides what runs: every `spawn` names a program, arguments, folder
 * and environment that main computed from a detected shell. This process
 * checks each command against its schema again and only does what it says.
 * Output is flow-controlled like an SSH channel: past `HIGH_WATER_BYTES`
 * that the renderer has not acknowledged, the PTY is paused until the
 * renderer catches up.
 */
import Value from 'typebox/value';
import type { SessionEvent } from '../shared/ipc.js';
import { PtyCommand, type PtySpawn } from '../shared/pty-protocol.js';

export const HIGH_WATER_BYTES = 1024 * 1024;
export const LOW_WATER_BYTES = 256 * 1024;
export const MAX_LOCAL_SESSIONS = 32;
const EXIT_FLUSH_MS = 150;

interface Disposable {
  dispose(): void;
}

/** The part of node-pty's `IPty` the engine uses. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type SpawnPty = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

interface Session {
  pty: PtyProcess;
  unacked: number;
  paused: boolean;
  exited: boolean;
  listeners: Disposable[];
}

const encoder = new TextEncoder();

export class PtyEngine {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly spawnPty: SpawnPty,
    private readonly emit: (event: SessionEvent) => void,
  ) {}

  /** One command from main; anything that does not match the schema is dropped. */
  handle(message: unknown): void {
    if (!Value.Check(PtyCommand, message)) return;
    switch (message.type) {
      case 'spawn':
        this.spawn(message);
        break;
      case 'input': {
        const session = this.sessions.get(message.sessionId);
        if (!session || session.exited) return;
        // Mouse reports from xterm's onBinary are one byte per character.
        session.pty.write(
          message.encoding === 'binary' ? Buffer.from(message.data, 'latin1') : message.data,
        );
        break;
      }
      case 'resize': {
        const session = this.sessions.get(message.sessionId);
        if (!session || session.exited) return;
        try {
          session.pty.resize(message.cols, message.rows);
        } catch {
          // Exited meanwhile.
        }
        break;
      }
      case 'ack': {
        const session = this.sessions.get(message.sessionId);
        if (!session) return;
        session.unacked = Math.max(0, session.unacked - message.bytes);
        if (session.paused && session.unacked <= LOW_WATER_BYTES) {
          session.paused = false;
          if (!session.exited) session.pty.resume();
        }
        break;
      }
      case 'kill':
        this.kill(message.sessionId);
        break;
      case 'shutdown':
        for (const sessionId of [...this.sessions.keys()]) this.kill(sessionId);
        break;
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  private spawn(request: PtySpawn) {
    const { sessionId } = request;
    if (this.sessions.has(sessionId)) return;
    if (this.sessions.size >= MAX_LOCAL_SESSIONS) {
      this.fail(sessionId, 'too_many_sessions', 'Too many local terminals are open');
      return;
    }
    let pty: PtyProcess;
    try {
      pty = this.spawnPty(request.file, request.args, {
        name: 'xterm-256color',
        cols: request.cols,
        rows: request.rows,
        cwd: request.cwd,
        env: request.env,
      });
    } catch {
      // node-pty's message may hold the whole command line; keep it out of the UI and logs.
      this.fail(sessionId, 'unreachable', 'The shell could not be started');
      return;
    }
    const session: Session = { pty, unacked: 0, paused: false, exited: false, listeners: [] };
    this.sessions.set(sessionId, session);
    session.listeners.push(
      pty.onData((text) => {
        if (this.sessions.get(sessionId) !== session) return;
        const data = encoder.encode(text);
        if (data.byteLength === 0) return;
        session.unacked += data.byteLength;
        this.emit({ type: 'data', sessionId, data });
        if (!session.paused && session.unacked > HIGH_WATER_BYTES) {
          session.paused = true;
          try {
            pty.pause();
          } catch {
            // Exited meanwhile.
          }
        }
      }),
      pty.onExit(({ exitCode }) => {
        session.exited = true;
        // The last output can trail the exit by a moment (ConPTY flushes late).
        setTimeout(() => {
          for (const listener of session.listeners) listener.dispose();
          if (this.sessions.get(sessionId) !== session) return;
          this.sessions.delete(sessionId);
          this.emit({
            type: 'closed',
            sessionId,
            exitCode: Number.isInteger(exitCode) ? exitCode : null,
          });
        }, EXIT_FLUSH_MS);
      }),
    );
    this.emit({ type: 'ready', sessionId, tmux: null });
  }

  private kill(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (session.exited) return;
    try {
      session.pty.kill();
    } catch {
      // Already gone.
    }
    this.emit({ type: 'closed', sessionId, exitCode: null });
  }

  private fail(
    sessionId: string,
    code: Extract<SessionEvent, { type: 'error' }>['code'],
    message: string,
  ) {
    this.emit({ type: 'error', sessionId, code, message });
    this.emit({ type: 'closed', sessionId, exitCode: null });
  }
}
