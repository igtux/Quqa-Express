/**
 * One terminal: an xterm.js instance bound to an SSH session in the engine.
 * The transport is the preload bridge (`window.quqa`), not a socket: output
 * arrives as `data` events, and every rendered chunk is acknowledged so the
 * engine can pause a channel whose output outruns the screen.
 *
 * Ported from Jarvis NG (apps/web/src/terminal/connection.ts), same owner:
 * xterm options, fit pipeline, font ladder and zoom, WebGL with DOM fallback,
 * copy on selection, chunked paste, OSC 52 write-only, automatic reconnect
 * with back-off, bell. Sharing, tmux history and agent heuristics are not
 * part of this app.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Auth, QuqaApi } from '../../../shared/ipc.js';
import {
  FATAL_ERRORS,
  type PromptKind,
  type SessionEvent,
  type SshErrorCode,
} from '../../../shared/protocol.js';
import {
  sliceInput,
  PASTE_CHUNK,
  PASTE_INTERVAL_MS,
  reconnectDelayMs,
  RECONNECT_DELAYS_S,
} from './input.js';
import { parseOsc52 } from './osc52.js';
import { pasteRisks, type PasteRisk } from './paste.js';
import {
  clampZoom,
  computeFontSize,
  FONT_FAMILY,
  lineHeight,
  readZoom,
  saveZoom,
  xtermTheme,
  ZOOM_STEP,
} from './themes.js';

export type ConnState =
  | 'connecting'
  /** Waiting for the user to accept the server's host key. */
  | 'host-key'
  | 'connected'
  | 'reconnecting'
  /** Automatic attempts used up; reconnect by hand. */
  | 'disconnected'
  /** Refused for a reason retrying will not fix. */
  | 'denied'
  /** The remote shell exited. */
  | 'ended';

export interface HostKeyPrompt {
  requestId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

/** The engine asks for a password, passphrase or keyboard-interactive answers. */
export interface CredentialPrompt {
  requestId: string;
  kind: PromptKind;
  title: string;
  message: string;
  prompts: { label: string; echo: boolean }[];
  canRemember: boolean;
}

/** The server's key differs from the pinned one; the connection was refused. */
export interface HostKeyChange {
  requestId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  previous: { algorithm: string; fingerprint: string }[];
}

export interface PasteRequest {
  text: string;
  risks: PasteRisk[];
}

export interface ConnSnapshot {
  state: ConnState;
  statusText: string;
  /** The last error, safe to show. */
  reason: string;
  errorCode: SshErrorCode | null;
  attempt: number;
  hostKey: HostKeyPrompt | null;
  prompt: CredentialPrompt | null;
  hostKeyChanged: HostKeyChange | null;
  /** A risky paste waiting for the user's decision. */
  pasteRequest: PasteRequest | null;
  /** Text a remote program asked to put on the clipboard, awaiting the user. */
  clipboardRequest: string | null;
  /** Characters still queued from a large paste. */
  pendingInput: number;
  renderer: 'webgl' | 'dom';
}

export interface Target {
  host: string;
  port: number;
  username: string;
  /** No secrets: a key id, or "password" (the engine asks or uses the saved one). */
  auth: Auth;
}

/** Routes the bridge's single event stream to sessions by id. */
export class SessionEvents {
  private readonly handlers = new Map<string, (event: SessionEvent) => void>();
  /** Events that arrive before `connect` resolved with the session id. */
  private readonly early = new Map<string, SessionEvent[]>();

  constructor(api: QuqaApi) {
    api.onEvent((event) => {
      const handler = this.handlers.get(event.sessionId);
      if (handler) handler(event);
      else {
        const queue = this.early.get(event.sessionId) ?? [];
        if (queue.length < 1000) queue.push(event);
        this.early.set(event.sessionId, queue);
      }
    });
  }

  listen(sessionId: string, handler: (event: SessionEvent) => void): () => void {
    this.handlers.set(sessionId, handler);
    const queued = this.early.get(sessionId) ?? [];
    this.early.delete(sessionId);
    for (const event of queued) handler(event);
    return () => this.handlers.delete(sessionId);
  }
}

const ACK_BATCH_BYTES = 32 * 1024;
const ACK_DELAY_MS = 30;

const FATAL_TEXT: Partial<Record<SshErrorCode, string>> = {
  auth_failed: 'Access denied',
  auth_cancelled: 'Login cancelled',
  vault_locked: 'Vault locked',
  host_key_mismatch: 'Host key changed — refused',
  host_key_rejected: 'Host key not accepted',
  invalid_key: 'Private key unreadable',
  too_many_sessions: 'Too many sessions',
  invalid_request: 'Session unavailable',
};

export class TerminalSession {
  readonly element: HTMLDivElement;
  readonly term: XTerm;
  readonly target: Target;
  private readonly api: QuqaApi;
  private readonly events: SessionEvents;
  private readonly fitAddon = new FitAddon();
  private sessionId: string | null = null;
  private unlisten: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private snapshot: ConnSnapshot = {
    state: 'connecting',
    statusText: 'Connecting…',
    reason: '',
    errorCode: null,
    attempt: 0,
    hostKey: null,
    prompt: null,
    hostKeyChanged: null,
    pasteRequest: null,
    clipboardRequest: null,
    pendingInput: 0,
    renderer: 'dom',
  };
  private opened = false;
  private started = false;
  private disposed = false;
  private zoom = readZoom();
  private lastSize = { cols: 0, rows: 0 };
  private fitTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private pasteTimer: ReturnType<typeof setTimeout> | undefined;
  private copyTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingAck = 0;
  private pasteQueue: string[] = [];
  private lastError: { code: SshErrorCode; message: string } | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(api: QuqaApi, events: SessionEvents, target: Target) {
    this.api = api;
    this.events = events;
    this.target = target;

    this.element = document.createElement('div');
    this.element.className = 'terminal-xterm-host';

    const width = window.innerWidth;
    this.term = new XTerm({
      cursorBlink: true,
      fontSize: computeFontSize(this.zoom, width),
      lineHeight: lineHeight(width),
      letterSpacing: 0,
      fontFamily: FONT_FAMILY,
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      smoothScrollDuration: 0,
      rescaleOverlappingGlyphs: true,
      fastScrollSensitivity: 5,
      scrollOnUserInput: true,
      theme: xtermTheme(),
      scrollback: 10000,
      minimumContrastRatio: 4.5,
      convertEol: false,
      // Remote programs may not open links or windows: no link addon.
    });
    this.term.loadAddon(this.fitAddon);
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = '11';

    // OSC 52: write-only and only after the user agrees; reads are denied.
    this.term.parser.registerOscHandler(52, (data) => {
      const request = parseOsc52(data);
      if (request.kind === 'write') this.update({ clipboardRequest: request.text });
      return true;
    });

    this.term.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.term.onData((data) => this.sendInput(data));
    this.term.onBinary((data) => this.sendRaw(data, 'binary'));
    this.term.onBell(() => {
      this.element.classList.remove('bell');
      void this.element.offsetWidth;
      this.element.classList.add('bell');
      if (!document.hasFocus()) this.api.attention();
    });

    // Selecting copies at once.
    this.term.onSelectionChange(() => {
      clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        const text = this.term.getSelection();
        if (text) void this.api.clipboardWrite(text.slice(0, 1024 * 1024)).catch(() => undefined);
      }, 250);
    });

    // Right-click pastes (as in PuTTY and Windows Terminal).
    this.element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void this.pasteFromClipboard();
    });
    // Every other paste (middle click, drag and drop of text, the browser's
    // own shortcut) goes through the same checks instead of xterm's handler.
    this.element.addEventListener(
      'paste',
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (text) this.pasteText(text);
      },
      { capture: true },
    );
  }

  /* ----- Observing --------------------------------------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ConnSnapshot => this.snapshot;

  private update(change: Partial<ConnSnapshot>) {
    let changed = false;
    for (const key of Object.keys(change) as (keyof ConnSnapshot)[]) {
      if (this.snapshot[key] !== change[key]) changed = true;
    }
    if (!changed) return;
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }

  /** The rendered text of the buffer (for the UI smoke test). */
  text(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  }

  /* ----- Mounting and size ------------------------------------------------- */

  mount(parent: HTMLElement): void {
    if (this.disposed) return;
    if (this.element.parentElement !== parent) parent.appendChild(this.element);
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.element);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          this.update({ renderer: 'dom' });
        });
        this.term.loadAddon(webgl);
        this.update({ renderer: 'webgl' });
      } catch {
        // No WebGL2: xterm keeps its DOM renderer.
      }
      this.resizeObserver = new ResizeObserver(() => this.scheduleFit(50));
      this.resizeObserver.observe(this.element);
    }
    this.fitNow();
  }

  focus(): void {
    if (this.opened) this.term.focus();
  }

  /** Focus after a dialog has closed (closing a modal <dialog> moves focus itself). */
  private refocus(): void {
    setTimeout(() => {
      if (!this.disposed) this.focus();
    }, 0);
  }

  scheduleFit(delay = 100): void {
    clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => this.fitNow(), delay);
  }

  private fitNow() {
    if (!this.opened || this.disposed) return;
    const width = window.innerWidth;
    const size = computeFontSize(this.zoom, width);
    if (this.term.options.fontSize !== size) this.term.options.fontSize = size;
    const lh = lineHeight(width);
    if (this.term.options.lineHeight !== lh) this.term.options.lineHeight = lh;
    // Never fit a hidden or collapsed element.
    if (this.element.clientWidth <= 20 || this.element.clientHeight <= 20) return;
    try {
      this.fitAddon.fit();
    } catch {
      return;
    }
    const { cols, rows } = this.term;
    if (cols !== this.lastSize.cols || rows !== this.lastSize.rows) {
      this.lastSize = { cols, rows };
      if (this.sessionId && this.snapshot.state === 'connected') {
        this.api.resize({ sessionId: this.sessionId, cols, rows });
      }
    }
  }

  setZoom(zoom: number): void {
    this.zoom = clampZoom(zoom);
    saveZoom(this.zoom);
    this.fitNow();
  }

  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    const ctrl = event.ctrlKey || event.metaKey;
    // Ctrl+Shift+V pastes, Ctrl+Shift+C copies the selection.
    if (ctrl && event.shiftKey && event.code === 'KeyV') {
      event.preventDefault();
      void this.pasteFromClipboard();
      return false;
    }
    if (ctrl && event.shiftKey && event.code === 'KeyC') {
      event.preventDefault();
      const text = this.term.getSelection();
      if (text) void this.api.clipboardWrite(text).catch(() => undefined);
      return false;
    }
    // Ctrl+= / Ctrl+- / Ctrl+0: zoom.
    if (ctrl && !event.altKey && (event.key === '=' || event.key === '+')) {
      event.preventDefault();
      this.setZoom(this.zoom + ZOOM_STEP);
      return false;
    }
    if (ctrl && !event.altKey && event.key === '-') {
      event.preventDefault();
      this.setZoom(this.zoom - ZOOM_STEP);
      return false;
    }
    if (ctrl && !event.altKey && event.key === '0') {
      event.preventDefault();
      this.setZoom(0);
      return false;
    }
    return true;
  }

  /* ----- Connection -------------------------------------------------------- */

  /** Opens the session (once). No secrets: the engine asks for what it needs. */
  async connect(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.fitNow();
    this.update({ state: 'connecting', statusText: 'Connecting…', reason: '', errorCode: null });
    try {
      const { sessionId } = await this.api.connect({
        ...this.target,
        cols: Math.max(2, this.term.cols),
        rows: Math.max(1, this.term.rows),
      });
      if (this.disposed) {
        this.api.disconnect(sessionId);
        return;
      }
      this.sessionId = sessionId;
      this.unlisten = this.events.listen(sessionId, (event) => this.receive(event));
    } catch (error) {
      this.update({
        state: 'denied',
        statusText: 'Could not connect',
        reason: friendlyInvokeError(error),
        errorCode: 'invalid_request',
      });
    }
  }

  private receive(event: SessionEvent) {
    switch (event.type) {
      case 'host-key':
        this.update({
          state: 'host-key',
          statusText: 'Verify host key',
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
        this.lastError = null;
        this.lastSize = { cols: 0, rows: 0 };
        this.update({
          state: 'connected',
          statusText: 'Connected',
          reason: '',
          errorCode: null,
          attempt: 0,
          hostKey: null,
          prompt: null,
          hostKeyChanged: null,
        });
        this.fitNow();
        this.flushPaste();
        this.focus();
        break;
      case 'data': {
        const length = event.data.byteLength;
        this.term.write(event.data, () => this.acknowledge(length));
        break;
      }
      case 'error':
        this.lastError = { code: event.code, message: event.message };
        break;
      case 'closed':
        this.handleClosed(event.exitCode);
        break;
    }
  }

  answerHostKey(accept: boolean): void {
    const prompt = this.snapshot.hostKey;
    if (!prompt) return;
    this.api.answerHostKey({ requestId: prompt.requestId, accept });
    this.update({
      hostKey: null,
      state: 'connecting',
      statusText: accept ? 'Connecting…' : 'Host key not accepted',
    });
  }

  /**
   * Sends the user's answer once; the dialog keeps nothing. `null` cancels.
   * The engine holds the secret from here on (for reconnects) until the vault locks.
   */
  answerPrompt(answers: string[] | null, remember: boolean): void {
    const prompt = this.snapshot.prompt;
    if (!prompt) return;
    this.api.answerPrompt({ requestId: prompt.requestId, answers, remember });
    this.update({ prompt: null });
  }

  /** After the user confirmed twice: pin the key the engine saw, then connect again. */
  async replaceHostKey(): Promise<string | null> {
    const change = this.snapshot.hostKeyChanged;
    if (!change) return null;
    const result = await this.api.call('hostKeys.replace', { requestId: change.requestId });
    if (!result.ok) return result.message;
    this.update({ hostKeyChanged: null });
    this.reconnectNow();
    return null;
  }

  answerClipboard(allow: boolean): void {
    const text = this.snapshot.clipboardRequest;
    this.update({ clipboardRequest: null });
    if (allow && text) void this.api.clipboardWrite(text).catch(() => undefined);
    this.refocus();
  }

  private acknowledge(bytes: number) {
    this.pendingAck += bytes;
    if (this.pendingAck >= ACK_BATCH_BYTES) this.sendAck();
    else if (this.ackTimer === undefined) {
      this.ackTimer = setTimeout(() => this.sendAck(), ACK_DELAY_MS);
    }
  }

  private sendAck() {
    clearTimeout(this.ackTimer);
    this.ackTimer = undefined;
    if (this.pendingAck > 0 && this.sessionId) {
      this.api.ack({ sessionId: this.sessionId, bytes: this.pendingAck });
    }
    this.pendingAck = 0;
  }

  private handleClosed(exitCode: number | null) {
    if (this.disposed) return;
    this.cancelPendingInput();
    this.update({ prompt: null, pasteRequest: null });
    this.pendingAck = 0;
    const error = this.lastError;
    this.lastError = null;
    if (!error && exitCode !== null) {
      this.update({
        state: 'ended',
        statusText: 'Session ended',
        reason: exitCode === 0 ? 'The shell exited' : `The shell exited with status ${exitCode}`,
        errorCode: null,
        hostKey: null,
      });
      return;
    }
    if (error && FATAL_ERRORS.has(error.code)) {
      this.update({
        state: 'denied',
        statusText: FATAL_TEXT[error.code] ?? 'Connection refused',
        reason: error.message,
        errorCode: error.code,
        hostKey: null,
      });
      return;
    }
    const attempt = this.snapshot.attempt;
    const delay = reconnectDelayMs(attempt);
    const reason = error?.message ?? 'Connection lost';
    if (delay === null) {
      this.update({
        state: 'disconnected',
        statusText: 'Disconnected',
        reason,
        errorCode: error?.code ?? null,
        hostKey: null,
      });
      return;
    }
    const next = attempt + 1;
    this.update({
      state: 'reconnecting',
      statusText: `Reconnecting (${next}/${RECONNECT_DELAYS_S.length})…`,
      reason,
      attempt: next,
      errorCode: error?.code ?? null,
      hostKey: null,
    });
    this.reconnectTimer = setTimeout(() => this.reopen(), delay);
  }

  /** Reconnects now with the credentials the engine still holds. */
  reconnectNow(): void {
    clearTimeout(this.reconnectTimer);
    this.update({ attempt: 0 });
    this.reopen();
  }

  private reopen() {
    if (this.disposed || !this.sessionId) return;
    this.update({ state: 'connecting', statusText: 'Connecting…', hostKeyChanged: null });
    this.api.reconnect(this.sessionId);
  }

  /* ----- Input ------------------------------------------------------------- */

  private sendRaw(data: string, encoding: 'utf8' | 'binary') {
    if (!this.sessionId || this.snapshot.state !== 'connected' || !data) return;
    this.api.input({ sessionId: this.sessionId, data, encoding });
  }

  /** Keystrokes and pastes; large input goes in 4 KiB slices. */
  sendInput(data: string): void {
    if (data.length <= PASTE_CHUNK && this.pasteQueue.length === 0) {
      this.sendRaw(data, 'utf8');
      return;
    }
    this.pasteQueue.push(...sliceInput(data));
    this.update({ pendingInput: this.queuedLength() });
    this.flushPaste();
  }

  async pasteFromClipboard(): Promise<void> {
    if (this.snapshot.state !== 'connected') return;
    try {
      const text = await this.api.clipboardRead();
      if (text) this.pasteText(text);
    } catch {
      // Clipboard unavailable.
    }
  }

  /** Pastes, asking first when the text could run commands or drive the terminal. */
  pasteText(text: string): void {
    if (this.snapshot.state !== 'connected' || this.snapshot.pasteRequest) return;
    const risks = pasteRisks(text, this.term.modes.bracketedPasteMode);
    if (risks.length > 0) {
      this.update({ pasteRequest: { text, risks } });
      return;
    }
    // xterm adds bracketed-paste markers when the program asked for them.
    this.term.paste(text);
  }

  answerPaste(allow: boolean): void {
    const request = this.snapshot.pasteRequest;
    this.update({ pasteRequest: null });
    if (allow && request && this.snapshot.state === 'connected') this.term.paste(request.text);
    this.refocus();
  }

  private queuedLength() {
    return this.pasteQueue.reduce((n, chunk) => n + chunk.length, 0);
  }

  private flushPaste() {
    clearTimeout(this.pasteTimer);
    if (this.pasteQueue.length === 0 || this.snapshot.state !== 'connected') return;
    const chunk = this.pasteQueue.shift() ?? '';
    this.sendRaw(chunk, 'utf8');
    this.update({ pendingInput: this.queuedLength() });
    if (this.pasteQueue.length > 0) {
      this.pasteTimer = setTimeout(() => this.flushPaste(), PASTE_INTERVAL_MS);
    }
  }

  cancelPendingInput(): void {
    this.pasteQueue = [];
    clearTimeout(this.pasteTimer);
    this.update({ pendingInput: 0 });
  }

  /* ----- Closing ----------------------------------------------------------- */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.fitTimer);
    clearTimeout(this.ackTimer);
    clearTimeout(this.pasteTimer);
    clearTimeout(this.copyTimer);
    if (this.sessionId) this.api.disconnect(this.sessionId);
    this.unlisten?.();
    this.resizeObserver?.disconnect();
    this.term.dispose();
    this.element.remove();
    this.listeners.clear();
  }
}

function friendlyInvokeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Electron prefixes errors from ipcMain.handle with the channel name.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
