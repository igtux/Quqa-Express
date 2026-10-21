/**
 * A `hold` connection to a saved host: logged in, no shell. The file browser,
 * tunnels and "install my key" use it when no terminal to the host is open.
 * Host-key and credential prompts are answered like a terminal's (shown by
 * ProbeDialogs); a dropped connection reconnects with the same back-off.
 */
import type { QuqaApi } from '../../../shared/ipc.js';
import { FATAL_ERRORS, type SessionEvent, type SshErrorCode } from '../../../shared/protocol.js';
import {
  friendlyInvokeError,
  type CredentialPrompt,
  type HostKeyChange,
  type HostKeyPrompt,
  type SessionEvents,
} from './connection.js';
import { reconnectDelayMs } from './input.js';

export interface LinkSnapshot {
  state: 'connecting' | 'connected' | 'reconnecting' | 'failed';
  error: string | null;
  hostKey: HostKeyPrompt | null;
  prompt: CredentialPrompt | null;
  hostKeyChanged: HostKeyChange | null;
  /** Mirrors HostProbe's snapshot for ProbeDialogs. */
  done: boolean;
}

/** What ProbeDialogs needs from a probe or a link. */
export interface PromptSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    hostKey: HostKeyPrompt | null;
    prompt: CredentialPrompt | null;
    hostKeyChanged: HostKeyChange | null;
  };
  answerHostKey(accept: boolean): void;
  answerPrompt(answers: string[] | null, remember: boolean): void;
  replaceHostKey(): Promise<string | null>;
}

export class HostLink implements PromptSource {
  sessionId: string | null = null;
  private unlisten: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private lastError: { code: SshErrorCode; message: string } | null = null;
  private disposed = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiters: { resolve: (id: string) => void; reject: (e: Error) => void }[] = [];
  private snapshot: LinkSnapshot = {
    state: 'connecting',
    error: null,
    hostKey: null,
    prompt: null,
    hostKeyChanged: null,
    done: false,
  };

  constructor(
    private readonly api: QuqaApi,
    private readonly events: SessionEvents,
    readonly hostId: string,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LinkSnapshot => this.snapshot;

  private update(change: Partial<LinkSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }

  get disposedNow(): boolean {
    return this.disposed;
  }

  /** The session id once connected (connecting first if needed). */
  ready(): Promise<string> {
    if (this.snapshot.state === 'connected' && this.sessionId) {
      return Promise.resolve(this.sessionId);
    }
    if (this.snapshot.state === 'failed') this.reconnect();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async start(): Promise<void> {
    try {
      const { sessionId } = await this.api.connect({
        hostId: this.hostId,
        action: { type: 'hold' },
        cols: 80,
        rows: 24,
      });
      if (this.disposed) {
        this.api.disconnect(sessionId);
        return;
      }
      this.sessionId = sessionId;
      this.unlisten = this.events.listen(sessionId, (event) => this.receive(event));
    } catch (error) {
      this.fail(friendlyInvokeError(error));
    }
  }

  private fail(message: string) {
    this.update({
      state: 'failed',
      error: message,
      hostKey: null,
      prompt: null,
      done: true,
    });
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(message));
  }

  private receive(event: SessionEvent) {
    switch (event.type) {
      case 'host-key':
        this.update({
          hostKey: {
            requestId: event.requestId,
            host: event.host,
            port: event.port,
            algorithm: event.algorithm,
            fingerprint: event.fingerprint,
          },
        });
        break;
      case 'prompt':
        this.update({
          prompt: {
            requestId: event.requestId,
            kind: event.kind,
            title: event.title,
            message: event.message,
            prompts: event.prompts,
            canRemember: event.canRemember,
          },
        });
        break;
      case 'host-key-changed':
        this.update({
          hostKeyChanged: {
            requestId: event.requestId,
            host: event.host,
            port: event.port,
            algorithm: event.algorithm,
            fingerprint: event.fingerprint,
            previous: event.previous,
          },
        });
        break;
      case 'ready':
        this.attempt = 0;
        this.lastError = null;
        this.update({
          state: 'connected',
          error: null,
          hostKey: null,
          prompt: null,
          hostKeyChanged: null,
          done: false,
        });
        for (const waiter of this.waiters.splice(0)) waiter.resolve(event.sessionId);
        break;
      case 'error':
        this.lastError = { code: event.code, message: event.message };
        break;
      case 'closed': {
        if (this.disposed) return;
        const error = this.lastError;
        this.lastError = null;
        if (error && FATAL_ERRORS.has(error.code)) {
          this.fail(error.message);
          return;
        }
        const delay = reconnectDelayMs(this.attempt);
        if (delay === null) {
          this.fail(error?.message ?? 'Connection lost');
          return;
        }
        this.attempt++;
        this.update({ state: 'reconnecting', error: error?.message ?? 'Connection lost' });
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.reopen(), delay);
        break;
      }
      default:
        break;
    }
  }

  private reopen() {
    if (this.disposed || !this.sessionId) return;
    this.update({ state: 'connecting' });
    this.api.reconnect(this.sessionId);
  }

  /** Try again now (after a failure or while waiting to retry). */
  reconnect(): void {
    clearTimeout(this.timer);
    this.attempt = 0;
    if (!this.sessionId) {
      this.update({ state: 'connecting', error: null, done: false });
      void this.start();
      return;
    }
    this.update({ error: null, done: false, hostKeyChanged: null });
    this.reopen();
  }

  answerHostKey(accept: boolean): void {
    const prompt = this.snapshot.hostKey;
    if (!prompt) return;
    this.api.answerHostKey({ requestId: prompt.requestId, accept });
    this.update({ hostKey: null });
  }

  answerPrompt(answers: string[] | null, remember: boolean): void {
    const prompt = this.snapshot.prompt;
    if (!prompt) return;
    this.api.answerPrompt({ requestId: prompt.requestId, answers, remember });
    this.update({ prompt: null });
  }

  async replaceHostKey(): Promise<string | null> {
    const change = this.snapshot.hostKeyChanged;
    if (!change) return null;
    const result = await this.api.call('hostKeys.replace', { requestId: change.requestId });
    if (!result.ok) return result.message;
    this.update({ hostKeyChanged: null });
    this.reconnect();
    return null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Closed'));
    if (this.sessionId) this.api.disconnect(this.sessionId);
    this.unlisten?.();
    this.listeners.clear();
  }
}
