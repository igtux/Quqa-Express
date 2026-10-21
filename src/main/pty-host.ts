/**
 * Runs the local terminal process (src/pty, ADR 0007) in its own Electron
 * utilityProcess, started the first time a local terminal opens. If it dies,
 * its sessions are reported closed; the next local terminal starts a fresh one.
 */
import { utilityProcess, type UtilityProcess } from 'electron';
import type { SessionEvent } from '../shared/ipc.js';
import type { PtyCommand } from '../shared/pty-protocol.js';
import { isSessionEvent } from './engine-host.js';

/** The only events the PTY process sends. */
const PTY_EVENTS = new Set(['ready', 'data', 'error', 'closed']);

export class PtyHost {
  private child: UtilityProcess | null = null;
  private readonly open = new Set<string>();
  private stopping = false;

  constructor(
    private readonly entry: string,
    private readonly onEvent: (event: SessionEvent) => void,
  ) {}

  /** Sessions this process runs (main routes their input here, not to the SSH engine). */
  has(sessionId: string): boolean {
    return this.open.has(sessionId);
  }

  send(command: PtyCommand): void {
    if (this.stopping) return;
    if (command.type === 'spawn') this.open.add(command.sessionId);
    else if (command.type !== 'shutdown' && !this.open.has(command.sessionId)) return;
    this.process().postMessage(command);
  }

  stop(): void {
    this.stopping = true;
    this.child?.postMessage({ type: 'shutdown' } satisfies PtyCommand);
    const child = this.child;
    this.child = null;
    // Give the shells a moment to be closed before the process goes.
    setTimeout(() => child?.kill(), 200).unref();
  }

  private receive(message: unknown) {
    if (!isSessionEvent(message) || !PTY_EVENTS.has(message.type)) return;
    if (!this.open.has(message.sessionId)) return;
    if (message.type === 'closed') this.open.delete(message.sessionId);
    this.onEvent(message);
  }

  private process(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(this.entry, [], {
      serviceName: 'Quqa local terminals',
      stdio: 'inherit',
    });
    child.on('message', (message: unknown) => this.receive(message));
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      for (const sessionId of this.open) {
        this.onEvent({
          type: 'error',
          sessionId,
          code: 'connection_lost',
          message: 'The local terminal process stopped',
        });
        this.onEvent({ type: 'closed', sessionId, exitCode: null });
      }
      this.open.clear();
    });
    this.child = child;
    return child;
  }
}
