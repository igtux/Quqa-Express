/**
 * One terminal: an xterm.js instance bound to an SSH session in the engine.
 * The transport is the preload bridge (`window.quqa`), not a socket: output
 * arrives as `data` events, and every rendered chunk is acknowledged so the
 * engine can pause a channel whose output outruns the screen.
 *
 * Ported from Jarvis NG (apps/web/src/terminal/connection.ts), same owner:
 * xterm options, fit pipeline, font ladder and zoom, WebGL with DOM fallback,
 * copy on selection, chunked paste, OSC 52 write-only, automatic reconnect
 * with back-off, bell, unread / attention / agent-busy marks, hover preview
 * lines, tmux history (copy-mode) scrolling with the Live button. Sharing is
 * not part of this app.
 */
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Auth, Osc52Policy, QuqaApi } from '../../../shared/ipc.js';
import {
  FATAL_ERRORS,
  type PromptKind,
  type SessionEvent,
  type SshErrorCode,
  type TmuxSessionInfo,
} from '../../../shared/protocol.js';
import { ActivityTracker } from './activity.js';
import {
  sliceInput,
  PASTE_CHUNK,
  PASTE_INTERVAL_MS,
  reconnectDelayMs,
  RECONNECT_DELAYS_S,
} from './input.js';
import { clipboardAction } from './keys.js';
import { parseOsc52 } from './osc52.js';
import { pasteRisks, type PasteRisk } from './paste.js';
import {
  computeFontSize,
  fontById,
  fontFamily,
  lineHeight,
  loadGeorgianFonts,
  schemeById,
  xtermTheme,
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
  /** The tmux session the terminal runs in (null: plain shell). */
  tmux: string | null;
  /** New output arrived while the terminal was not on screen. */
  unread: boolean;
  /** A background terminal rang, or an agent finished / asks something. */
  attention: boolean;
  /** An agent is working in it. */
  busy: boolean;
  /** Scrolled away from the newest output (local scrollback or tmux history). */
  scrolledBack: boolean;
  /** Output arrived while scrolled back. */
  historyUnread: boolean;
  /** tmux copy-mode is showing history. */
  history: boolean;
  /** Wheel scrolling drives tmux history (tmux sessions only). */
  historyMode: boolean;
  /** A short notice (e.g. the tmux session had ended and a new one started). */
  notice: string | null;
}

/** A saved host (the engine takes address, user and login from it) or an ad-hoc target. */
export type Target =
  | { kind: 'host'; hostId: string; title: string }
  | {
      kind: 'adhoc';
      host: string;
      port: number;
      username: string;
      /** No secrets: a key id, or "password" (the engine asks or uses the saved one). */
      auth: Auth;
      title: string;
    };

export interface SessionCallbacks {
  onBell?(session: TerminalSession): void;
  onAttention?(session: TerminalSession, reason: 'finished' | 'choice'): void;
  onTmuxSessions?(session: TerminalSession, available: boolean, sessions: TmuxSessionInfo[]): void;
  /** The session reached `ready`. */
  onReady?(session: TerminalSession): void;
  /** Ctrl+V of an image (or of copied files): upload and type the paths. */
  onUploadPaste?(session: TerminalSession): void;
  /** What the host lets programs do with the clipboard (OSC 52). */
  osc52Policy?(session: TerminalSession): Osc52Policy;
  /** The user chose "remember for this host" in the clipboard dialog. */
  onRememberOsc52?(session: TerminalSession, policy: Osc52Policy): void;
  /** A program's clipboard write went through (allowed). */
  onClipboardWritten?(session: TerminalSession, text: string): void;
}

export interface Look {
  scheme: string;
  font: string;
  zoom: number;
}

type SharedEvent = Extract<SessionEvent, { type: 'transfer' | 'forwards' }>;

/** Routes the bridge's single event stream to sessions by id. */
export class SessionEvents {
  private readonly handlers = new Map<string, (event: SessionEvent) => void>();
  /** Events that arrive before `connect` resolved with the session id. */
  private readonly early = new Map<string, SessionEvent[]>();
  /** Transfers and forwards go to the workspace whichever session they belong to. */
  private readonly shared = new Set<(event: SharedEvent) => void>();

  constructor(api: QuqaApi) {
    api.onEvent((event) => {
      if (event.type === 'transfer' || event.type === 'forwards') {
        for (const listener of this.shared) listener(event);
        return;
      }
      const handler = this.handlers.get(event.sessionId);
      if (handler) handler(event);
      else {
        const queue = this.early.get(event.sessionId) ?? [];
        if (queue.length < 1000) queue.push(event);
        this.early.set(event.sessionId, queue);
      }
    });
  }

  onShared(listener: (event: SharedEvent) => void): () => void {
    this.shared.add(listener);
    return () => this.shared.delete(listener);
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
/** Lines one wheel notch scrolls tmux history. */
const WHEEL_LINES = 3;

export const FATAL_TEXT: Partial<Record<SshErrorCode, string>> = {
  auth_failed: 'Access denied',
  auth_cancelled: 'Login cancelled',
  vault_locked: 'Vault locked',
  host_key_mismatch: 'Host key changed — refused',
  host_key_rejected: 'Host key not accepted',
  invalid_key: 'Private key unreadable',
  too_many_sessions: 'Too many sessions',
  invalid_request: 'Session unavailable',
};

let nextTag = 0;

export class TerminalSession {
  /** Names this terminal in the UI and in notifications (`t<n>`). */
  readonly tag = `t${++nextTag}`;
  readonly element: HTMLDivElement;
  readonly term: XTerm;
  readonly target: Target;
  readonly createdAt = new Date().toISOString();
  /** The tmux session to create or re-attach (host targets with tmux on). */
  readonly requestedTmux: string | null;
  /** Re-opened from the saved layout (a missing tmux session is then worth a notice). */
  wasRestored = false;
  /** The bell and notifications are on for this terminal (header toggle). */
  private bell = true;
  private readonly api: QuqaApi;
  private readonly events: SessionEvents;
  private readonly callbacks: SessionCallbacks;
  private readonly fitAddon = new FitAddon();
  private readonly searchAddon = new SearchAddon();
  private readonly activity: ActivityTracker;
  private readonly decoder = new TextDecoder();
  private sessionId: string | null = null;
  private unlisten: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private snapshot: ConnSnapshot;
  private opened = false;
  private started = false;
  private disposed = false;
  private visible = false;
  private look: Look;
  private lastSize = { cols: 0, rows: 0 };
  private fitTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private pasteTimer: ReturnType<typeof setTimeout> | undefined;
  private copyTimer: ReturnType<typeof setTimeout> | undefined;
  private busyTimer: ReturnType<typeof setInterval> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingAck = 0;
  private pasteQueue: string[] = [];
  /** Typed while leaving tmux history; sent once tmux is out of copy-mode. */
  private afterHistory: string[] = [];
  private afterHistoryTimer: ReturnType<typeof setTimeout> | undefined;
  private wheelRest = 0;
  private lastError: { code: SshErrorCode; message: string } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private webgl: WebglAddon | null = null;
  /** A font finished loading: glyphs drawn with a fallback are drawn again. */
  private readonly onFontsLoaded = () => this.redrawGlyphs();

  constructor(
    api: QuqaApi,
    events: SessionEvents,
    target: Target,
    options: { tmux?: string | null; look: Look; callbacks?: SessionCallbacks },
  ) {
    this.api = api;
    this.events = events;
    this.target = target;
    this.requestedTmux = options.tmux ?? null;
    this.look = options.look;
    this.callbacks = options.callbacks ?? {};
    this.snapshot = {
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
      tmux: null,
      unread: false,
      attention: false,
      busy: false,
      scrolledBack: false,
      historyUnread: false,
      history: false,
      historyMode: false,
      notice: null,
    };
    this.activity = new ActivityTracker({
      busy: (busy) => {
        this.update({ busy });
        clearInterval(this.busyTimer);
        this.busyTimer = busy ? setInterval(() => this.activity.tick(), 1000) : undefined;
      },
      finished: () => this.raiseAttention('finished'),
      choice: () => this.raiseAttention('choice'),
    });

    this.element = document.createElement('div');
    this.element.className = 'terminal-xterm-host';

    const width = window.innerWidth;
    this.term = new XTerm({
      cursorBlink: true,
      fontSize: computeFontSize(this.look.zoom, width),
      lineHeight: lineHeight(width),
      letterSpacing: 0,
      fontFamily: fontFamily(fontById(this.look.font)),
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      smoothScrollDuration: 0,
      rescaleOverlappingGlyphs: true,
      fastScrollSensitivity: 5,
      scrollOnUserInput: true,
      theme: xtermTheme(schemeById(this.look.scheme)),
      scrollback: 10000,
      minimumContrastRatio: 4.5,
      convertEol: false,
      // OSC 8 hyperlinks can show one address and open another: they stay inert.
      linkHandler: { activate: () => undefined },
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.searchAddon);
    // Addresses printed in the output open in the system browser on Ctrl+click
    // (a plain click selects); main opens only http(s) links.
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey || event.metaKey) this.api.openExternal(uri);
      }),
    );
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = '11';

    // OSC 52: write-only and only after the user agrees; reads are denied.
    this.term.parser.registerOscHandler(52, (data) => {
      const request = parseOsc52(data);
      if (request.kind !== 'write') return true;
      const policy = this.callbacks.osc52Policy?.(this) ?? 'ask';
      if (policy === 'allow') {
        void this.api.clipboardWrite(request.text).then(
          () => this.callbacks.onClipboardWritten?.(this, request.text),
          () => undefined,
        );
      } else if (policy === 'ask') {
        this.update({ clipboardRequest: request.text });
      }
      return true;
    });

    this.term.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.term.onData((data) => this.sendInput(data));
    this.term.onBinary((data) => this.sendRaw(data, 'binary'));
    this.term.onBell(() => {
      this.element.classList.remove('bell');
      void this.element.offsetWidth;
      this.element.classList.add('bell');
      if (!this.isWatched()) {
        if (!this.snapshot.attention) this.update({ attention: true });
        this.callbacks.onBell?.(this);
      }
    });
    this.term.onScroll(() => this.checkScrolled());
    this.term.onWriteParsed(() => this.checkScrolled());

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
        const data = event.clipboardData;
        // An image (or copied files) uploads to the host and types its path (Jarvis 01b §8.2).
        const items = [...(data?.items ?? [])];
        const text = data?.getData('text/plain') ?? '';
        const image = items.some((item) => item.kind === 'file' && item.type.startsWith('image/'));
        const files = items.some((item) => item.kind === 'file');
        if (
          (image || (files && !text)) &&
          this.snapshot.state === 'connected' &&
          this.callbacks.onUploadPaste
        ) {
          this.callbacks.onUploadPaste(this);
          return;
        }
        if (text) this.pasteText(text);
      },
      { capture: true },
    );
    // In tmux history mode the wheel drives copy-mode on the host.
    this.element.addEventListener('wheel', (event) => this.onWheel(event), {
      capture: true,
      passive: false,
    });
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

  get bellOn(): boolean {
    return this.bell;
  }

  setBell(on: boolean): void {
    this.bell = on;
  }

  /** The engine session, once `connect` returned it. */
  get id(): string | null {
    return this.sessionId;
  }

  get hostId(): string | null {
    return this.target.kind === 'host' ? this.target.hostId : null;
  }

  get isDisposed(): boolean {
    return this.disposed;
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

  /** The last ≤ 18 non-empty lines of the screen, for the dock preview. */
  previewLines(max = 18): string[] {
    if (!this.opened) return [];
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = buffer.baseY + this.term.rows - 1; y >= 0 && lines.length < max; y--) {
      const text = buffer.getLine(y)?.translateToString(true) ?? '';
      if (text.trim()) lines.unshift(text);
    }
    return lines;
  }

  /* ----- Mounting, size and look ------------------------------------------- */

  mount(parent: HTMLElement): void {
    if (this.disposed) return;
    if (this.element.parentElement !== parent) parent.appendChild(this.element);
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.element);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => this.useDomRenderer());
        this.term.loadAddon(webgl);
        this.webgl = webgl;
        this.update({ renderer: 'webgl' });
      } catch {
        // No WebGL2: xterm keeps its DOM renderer.
      }
      this.resizeObserver = new ResizeObserver(() => this.scheduleFit(50));
      this.resizeObserver.observe(this.element);
      // Georgian comes from bundled unicode-range fonts; once they are in,
      // the WebGL atlas must drop any glyph it cached from a fallback font.
      document.fonts.addEventListener('loadingdone', this.onFontsLoaded);
      void loadGeorgianFonts().then(this.onFontsLoaded);
    }
    this.fitNow();
  }

  focus(): void {
    if (this.opened) this.term.focus();
  }

  /** xterm's DOM renderer (WebGL context lost; the UI test also checks it). */
  useDomRenderer(): void {
    this.webgl?.dispose();
    this.webgl = null;
    this.update({ renderer: 'dom' });
  }

  private redrawGlyphs() {
    if (!this.opened || this.disposed) return;
    this.term.clearTextureAtlas();
    this.term.refresh(0, this.term.rows - 1);
    this.scheduleFit(30);
  }

  /** On screen in the focused window (the user sees it). */
  isWatched(): boolean {
    return this.visible && document.hasFocus() && !document.hidden;
  }

  /** The workspace shows or hides the terminal (tab switch, split). */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.clearAttention();
      this.scheduleFit(30);
    }
  }

  clearAttention(): void {
    this.update({ attention: false, unread: false });
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
    const size = computeFontSize(this.look.zoom, width);
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

  /** Colour scheme, font and zoom (the theme dialog, per-host looks, Ctrl+= / Ctrl+-). */
  setLook(look: Look): void {
    const changed =
      look.scheme !== this.look.scheme ||
      look.font !== this.look.font ||
      look.zoom !== this.look.zoom;
    this.look = look;
    if (!changed) return;
    this.term.options.theme = xtermTheme(schemeById(look.scheme));
    this.term.options.fontFamily = fontFamily(fontById(look.font));
    this.fitNow();
    this.scheduleFit(120);
  }

  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    // Ctrl+V / Ctrl+Shift+V / Shift+Insert paste; Ctrl+Shift+C / Ctrl+Insert, and
    // Ctrl+C while text is selected, copy. By physical key, for every layout.
    // The key's default is cancelled, so the page's own paste never runs as well:
    // main reads the clipboard (text, or an image / copied files to upload).
    const action = clipboardAction(event, this.term.hasSelection());
    if (action === 'paste') {
      event.preventDefault();
      if (!event.repeat) void this.pasteFromClipboard();
      return false;
    }
    if (action === 'copy') {
      event.preventDefault();
      const text = this.term.getSelection();
      if (text) void this.api.clipboardWrite(text).catch(() => undefined);
      // Ctrl+C copied: drop the selection so the next Ctrl+C interrupts again.
      if (!event.shiftKey && event.code !== 'Insert') this.term.clearSelection();
      return false;
    }
    return true;
  }

  /* ----- Search ------------------------------------------------------------ */

  /** Finds the next (or previous) match in the scrollback; false when there is none. */
  find(query: string, previous = false): boolean {
    if (!query) {
      this.searchAddon.clearDecorations();
      return false;
    }
    const options = {
      caseSensitive: false,
      decorations: {
        matchBackground: '#6366f155',
        matchOverviewRuler: '#6366f1',
        activeMatchBackground: '#eab30888',
        activeMatchColorOverviewRuler: '#eab308',
      },
    };
    return previous
      ? this.searchAddon.findPrevious(query, options)
      : this.searchAddon.findNext(query, options);
  }

  clearSearch(): void {
    this.searchAddon.clearDecorations();
    this.term.clearSelection();
  }

  /* ----- Scrolling and tmux history ---------------------------------------- */

  private checkScrolled() {
    const buffer = this.term.buffer.active;
    const back = buffer.viewportY < buffer.baseY;
    const scrolledBack = back || this.snapshot.history;
    if (scrolledBack !== this.snapshot.scrolledBack) {
      this.update({ scrolledBack, ...(!scrolledBack && { historyUnread: false }) });
    }
  }

  /** Scroll mode: the wheel scrolls local scrollback (auto) or tmux history. */
  setHistoryMode(on: boolean): void {
    if (on && !this.snapshot.tmux) return;
    this.update({ historyMode: on });
    if (!on && this.snapshot.history) this.history('exit');
  }

  private onWheel(event: WheelEvent) {
    if (!this.snapshot.historyMode || !this.snapshot.tmux || this.snapshot.state !== 'connected') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const notches = event.deltaMode === 1 ? event.deltaY / 3 : event.deltaY / 100;
    this.wheelRest += notches * WHEEL_LINES;
    const lines = Math.trunc(this.wheelRest);
    if (lines === 0) return;
    this.wheelRest -= lines;
    if (!this.snapshot.history) {
      if (lines > 0) return;
      this.history('enter');
    }
    this.history('scroll', lines);
  }

  private history(action: 'enter' | 'exit' | 'scroll', lines = 0) {
    if (!this.sessionId) return;
    this.api.tmux({ sessionId: this.sessionId, op: 'history', action, lines });
  }

  /** Back to the newest output: leave tmux history and scroll local scrollback down. */
  goLive(): void {
    if (this.snapshot.history) this.history('exit');
    this.term.scrollToBottom();
    this.update({ historyUnread: false });
    this.checkScrolled();
    this.focus();
  }

  /* ----- tmux sessions on the host ----------------------------------------- */

  /** Asks the engine to list the host's tmux sessions over this terminal's connection. */
  refreshTmuxSessions(): boolean {
    if (!this.sessionId || this.snapshot.state !== 'connected' || this.hostId === null) {
      return false;
    }
    this.api.tmux({ sessionId: this.sessionId, op: 'list' });
    return true;
  }

  endTmuxSession(name: string): boolean {
    if (!this.sessionId || this.snapshot.state !== 'connected' || this.hostId === null) {
      return false;
    }
    this.api.tmux({ sessionId: this.sessionId, op: 'end', session: name });
    return true;
  }

  /* ----- Connection -------------------------------------------------------- */

  /** Opens the session (once). No secrets: the engine asks for what it needs. */
  async connect(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.fitNow();
    this.update({ state: 'connecting', statusText: 'Connecting…', reason: '', errorCode: null });
    const size = { cols: Math.max(2, this.term.cols), rows: Math.max(1, this.term.rows) };
    try {
      const { sessionId } = await this.api.connect(
        this.target.kind === 'host'
          ? {
              hostId: this.target.hostId,
              action: { type: 'shell', tmux: this.requestedTmux },
              ...size,
            }
          : {
              host: this.target.host,
              port: this.target.port,
              username: this.target.username,
              auth: this.target.auth,
              ...size,
            },
      );
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
        this.raiseAttention('choice');
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
        this.raiseAttention('choice');
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
      case 'tmux-sessions':
        // Re-attaching a session the host no longer has starts a new one: say so.
        if (
          this.wasRestored &&
          this.requestedTmux &&
          this.snapshot.state !== 'connected' &&
          event.available &&
          !event.sessions.some((s) => s.name === this.requestedTmux)
        ) {
          this.wasRestored = false;
          this.showNotice('The session had ended on the host; a new one was started');
        }
        this.callbacks.onTmuxSessions?.(this, event.available, event.sessions);
        break;
      case 'history':
        this.update({ history: event.inMode });
        if (!event.inMode && this.afterHistory.length > 0) this.flushAfterHistory();
        this.checkScrolled();
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
          tmux: event.tmux,
          history: false,
          ...(event.tmux === null && { historyMode: false }),
        });
        this.fitNow();
        this.flushPaste();
        if (this.visible) this.focus();
        this.callbacks.onReady?.(this);
        break;
      case 'data': {
        const length = event.data.byteLength;
        this.term.write(event.data, () => this.acknowledge(length));
        if (!this.visible && !this.snapshot.unread) this.update({ unread: true });
        if (this.snapshot.scrolledBack && !this.snapshot.historyUnread) {
          this.update({ historyUnread: true });
        }
        this.activity.output(this.decoder.decode(event.data, { stream: true }));
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

  private showNotice(text: string) {
    clearTimeout(this.noticeTimer);
    this.update({ notice: text });
    this.noticeTimer = setTimeout(() => this.update({ notice: null }), 8000);
  }

  private raiseAttention(reason: 'finished' | 'choice') {
    if (this.isWatched()) return;
    if (!this.snapshot.attention) this.update({ attention: true });
    this.callbacks.onAttention?.(this, reason);
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

  answerClipboard(allow: boolean, remember = false): void {
    const text = this.snapshot.clipboardRequest;
    this.update({ clipboardRequest: null });
    if (allow && text) {
      void this.api.clipboardWrite(text).then(
        () => this.callbacks.onClipboardWritten?.(this, text),
        () => undefined,
      );
    }
    if (remember) this.callbacks.onRememberOsc52?.(this, allow ? 'allow' : 'deny');
    this.refocus();
  }

  /** Types text as a paste (bracketed when the program asked), e.g. uploaded paths. */
  typePaste(text: string): void {
    if (this.snapshot.state !== 'connected' || !text) return;
    this.term.paste(text);
    this.focus();
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
    this.activity.reset();
    this.afterHistory = [];
    this.update({ prompt: null, pasteRequest: null, history: false });
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
    // Keys never act as copy-mode commands: leave history first.
    if (this.snapshot.history) {
      if (this.afterHistory.length === 0) {
        this.history('exit');
        clearTimeout(this.afterHistoryTimer);
        this.afterHistoryTimer = setTimeout(() => this.flushAfterHistory(), 1500);
      }
      if (this.afterHistory.length < 256) this.afterHistory.push(data);
      return;
    }
    if (data.length <= PASTE_CHUNK && this.pasteQueue.length === 0) {
      this.sendRaw(data, 'utf8');
      return;
    }
    this.pasteQueue.push(...sliceInput(data));
    this.update({ pendingInput: this.queuedLength() });
    this.flushPaste();
  }

  private flushAfterHistory() {
    clearTimeout(this.afterHistoryTimer);
    const queued = this.afterHistory;
    this.afterHistory = [];
    this.update({ history: false });
    for (const data of queued) this.sendInput(data);
  }

  async pasteFromClipboard(): Promise<void> {
    if (this.snapshot.state !== 'connected') return;
    try {
      const text = await this.api.clipboardRead();
      if (text) this.pasteText(text);
      // No text: maybe an image or copied files, which main reads itself.
      else this.callbacks.onUploadPaste?.(this);
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

  /** Closes the SSH channel and frees xterm. A tmux session keeps running on the host. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.fitTimer);
    clearTimeout(this.ackTimer);
    clearTimeout(this.pasteTimer);
    clearTimeout(this.copyTimer);
    clearTimeout(this.noticeTimer);
    clearTimeout(this.afterHistoryTimer);
    clearInterval(this.busyTimer);
    if (this.sessionId) this.api.disconnect(this.sessionId);
    this.unlisten?.();
    this.resizeObserver?.disconnect();
    document.fonts.removeEventListener('loadingdone', this.onFontsLoaded);
    this.term.dispose();
    this.element.remove();
    this.listeners.clear();
  }
}

/** What a host probe shows: its prompts, then the host's tmux sessions. */
export interface ProbeSnapshot {
  hostKey: HostKeyPrompt | null;
  prompt: CredentialPrompt | null;
  hostKeyChanged: HostKeyChange | null;
  done: boolean;
  error: string | null;
  available: boolean;
  sessions: TmuxSessionInfo[];
}

/**
 * A one-shot connection to a saved host that lists (or ends, then lists) its
 * tmux sessions, for hosts without an open terminal. Host-key and credential
 * prompts are answered like a terminal's.
 */
export class HostProbe {
  private sessionId: string | null = null;
  private unlisten: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private lastError: string | null = null;
  private disposed = false;
  private snapshot: ProbeSnapshot = {
    hostKey: null,
    prompt: null,
    hostKeyChanged: null,
    done: false,
    error: null,
    available: false,
    sessions: [],
  };

  constructor(
    private readonly api: QuqaApi,
    private readonly events: SessionEvents,
    readonly hostId: string,
    readonly end: string | null,
    private readonly onResult: (available: boolean, sessions: TmuxSessionInfo[]) => void,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ProbeSnapshot => this.snapshot;

  private update(change: Partial<ProbeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }

  async start(): Promise<void> {
    try {
      const { sessionId } = await this.api.connect({
        hostId: this.hostId,
        action: this.end ? { type: 'end', session: this.end } : { type: 'list' },
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
      this.update({ done: true, error: friendlyInvokeError(error) });
    }
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
      case 'tmux-sessions':
        this.update({ available: event.available, sessions: event.sessions });
        this.onResult(event.available, event.sessions);
        break;
      case 'error':
        this.lastError = event.message;
        break;
      case 'closed':
        this.update({ done: true, error: this.lastError, hostKey: null, prompt: null });
        this.dispose();
        break;
      default:
        break;
    }
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
    return null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sessionId) this.api.disconnect(this.sessionId);
    this.unlisten?.();
  }
}

export function friendlyInvokeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Electron prefixes errors from ipcMain.handle with the channel name.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
