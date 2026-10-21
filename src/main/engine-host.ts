/**
 * Runs the SSH engine in an Electron utilityProcess and relays messages. If
 * the engine dies, every open session is reported closed and a fresh engine
 * starts for the next connection.
 */
import { utilityProcess, type UtilityProcess } from 'electron';
import type { EngineCommand } from '../shared/engine-protocol.js';
import type { SessionEvent, SshErrorCode } from '../shared/ipc.js';

const EVENT_TYPES = new Set(['host-key', 'ready', 'data', 'error', 'closed']);

/** A light shape check of the engine's events (the engine is our own code). */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as { type?: unknown; sessionId?: unknown; data?: unknown };
  if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) return false;
  if (typeof event.sessionId !== 'string') return false;
  return event.type !== 'data' || event.data instanceof Uint8Array;
}

export class EngineHost {
  private child: UtilityProcess | null = null;
  private readonly open = new Set<string>();
  private stopping = false;

  constructor(
    private readonly entry: string,
    private readonly onEvent: (event: SessionEvent) => void,
  ) {}

  send(command: EngineCommand): void {
    if (command.type === 'connect') this.open.add(command.sessionId);
    this.process().postMessage(command);
  }

  stop(): void {
    this.stopping = true;
    this.child?.postMessage({ type: 'shutdown' } satisfies EngineCommand);
    this.child?.kill();
    this.child = null;
  }

  private process(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(this.entry, [], {
      serviceName: 'Quqa SSH engine',
      stdio: 'inherit',
    });
    child.on('message', (message: unknown) => {
      if (!isSessionEvent(message)) return;
      if (message.type === 'closed') this.open.delete(message.sessionId);
      this.onEvent(message);
    });
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      const code: SshErrorCode = 'connection_lost';
      for (const sessionId of this.open) {
        this.onEvent({ type: 'error', sessionId, code, message: 'The SSH engine stopped' });
        this.onEvent({ type: 'closed', sessionId, exitCode: null });
      }
      this.open.clear();
    });
    this.child = child;
    return child;
  }
}
