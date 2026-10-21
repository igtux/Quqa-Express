/**
 * Runs the SSH engine in an Electron utilityProcess and relays messages. If
 * the engine dies, every open session is reported closed, pending calls fail,
 * and a fresh engine starts (re-opening the vault through `onStart`).
 */
import { utilityProcess, type UtilityProcess } from 'electron';
import Value from 'typebox/value';
import {
  EngineCalls,
  type EngineCommand,
  type EngineMethod,
  type EngineParams,
  type EngineValue,
} from '../shared/engine-protocol.js';
import type { CallResult, SessionEvent, SshErrorCode, VaultState } from '../shared/ipc.js';

const EVENT_TYPES = new Set([
  'host-key',
  'host-key-changed',
  'prompt',
  'ready',
  'tmux-sessions',
  'history',
  'data',
  'error',
  'closed',
]);
const VAULT_STATES = new Set(['absent', 'locked', 'unlocked']);
/** Crash loop guard: at most this many restarts per minute. */
const MAX_RESTARTS_PER_MINUTE = 5;

/** A light shape check of the engine's events (the engine is our own code). */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as { type?: unknown; sessionId?: unknown; data?: unknown };
  if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) return false;
  if (typeof event.sessionId !== 'string') return false;
  return event.type !== 'data' || event.data instanceof Uint8Array;
}

export interface EngineHostEvents {
  onEvent(event: SessionEvent): void;
  onVaultState(state: VaultState): void;
  /** A new engine process started (first start or after a crash). */
  onStart(): void;
}

interface Pending {
  method: EngineMethod;
  resolve: (result: CallResult<unknown>) => void;
}

export class EngineHost {
  private child: UtilityProcess | null = null;
  private readonly open = new Set<string>();
  private readonly pending = new Map<number, Pending>();
  private nextCall = 0;
  private stopping = false;
  private restarts: number[] = [];

  constructor(
    private readonly entry: string,
    private readonly events: EngineHostEvents,
  ) {}

  start(): void {
    this.process();
  }

  send(command: EngineCommand): void {
    if (command.type === 'connect') this.open.add(command.sessionId);
    this.process().postMessage(command);
  }

  /** One request/response call; the result is checked against its schema. */
  call<M extends EngineMethod>(
    method: M,
    params: EngineParams<M>,
  ): Promise<CallResult<EngineValue<M>>> {
    const callId = ++this.nextCall;
    return new Promise((resolve) => {
      this.pending.set(callId, {
        method,
        resolve: resolve as (result: CallResult<unknown>) => void,
      });
      this.process().postMessage({ type: 'call', callId, method, params } satisfies EngineCommand);
    });
  }

  stop(): void {
    this.stopping = true;
    this.child?.postMessage({ type: 'shutdown' } satisfies EngineCommand);
    this.child?.kill();
    this.child = null;
  }

  private receive(message: unknown) {
    if (typeof message !== 'object' || message === null) return;
    const reply = message as { type?: unknown; callId?: unknown; state?: unknown };
    if (reply.type === 'result' && typeof reply.callId === 'number') {
      this.settle(reply.callId, message as CallResult<unknown>);
      return;
    }
    if (reply.type === 'vault-state') {
      if (typeof reply.state === 'string' && VAULT_STATES.has(reply.state)) {
        this.events.onVaultState(reply.state as VaultState);
      }
      return;
    }
    if (!isSessionEvent(message)) return;
    if (message.type === 'closed') this.open.delete(message.sessionId);
    this.events.onEvent(message);
  }

  private settle(callId: number, result: CallResult<unknown>) {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    if (result.ok) {
      // Fail closed if the engine ever answers with fields the schema does not list.
      if (!Value.Check(EngineCalls[pending.method].result, result.value)) {
        console.error('Engine answer failed its schema:', pending.method);
        pending.resolve({ ok: false, code: 'engine', message: 'Something went wrong' });
        return;
      }
      pending.resolve({ ok: true, value: result.value });
    } else {
      pending.resolve({
        ok: false,
        code: typeof result.code === 'string' ? result.code : 'engine',
        message: typeof result.message === 'string' ? result.message : 'Something went wrong',
      });
    }
  }

  private process(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(this.entry, [], {
      serviceName: 'Quqa SSH engine',
      stdio: 'inherit',
    });
    child.on('message', (message: unknown) => this.receive(message));
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      for (const [callId] of this.pending) {
        this.settle(callId, { ok: false, code: 'engine', message: 'The SSH engine stopped' });
      }
      if (this.stopping) return;
      const code: SshErrorCode = 'connection_lost';
      for (const sessionId of this.open) {
        this.events.onEvent({ type: 'error', sessionId, code, message: 'The SSH engine stopped' });
        this.events.onEvent({ type: 'closed', sessionId, exitCode: null });
      }
      this.open.clear();
      this.events.onVaultState('locked');
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 60_000);
      if (this.restarts.length < MAX_RESTARTS_PER_MINUTE) {
        this.restarts.push(now);
        setTimeout(() => {
          if (!this.stopping && !this.child) this.process();
        }, 500);
      }
    });
    this.child = child;
    this.events.onStart();
    return child;
  }
}
