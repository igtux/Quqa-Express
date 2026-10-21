/**
 * The dependency-free half of the IPC contract (channel names, limits, error
 * codes, events), so the sandboxed preload and the renderer can import it
 * without pulling in the schema library. The schemas are in ipc.ts.
 */
/** IPC channel names. Keep this list short; every channel is an attack surface. */
export const Channel = {
  /** invoke: open a session → { sessionId } */
  connect: 'ssh:connect',
  /** send: keystrokes / paste for a session */
  input: 'ssh:input',
  /** send: the terminal's new size */
  resize: 'ssh:resize',
  /** send: output bytes the terminal has rendered (flow control) */
  ack: 'ssh:ack',
  /** send: close a session */
  disconnect: 'ssh:disconnect',
  /** send: reconnect a lost session with the credentials the engine still holds */
  reconnect: 'ssh:reconnect',
  /** send: the user's answer to a host-key prompt */
  hostKeyAnswer: 'ssh:host-key-answer',
  /** send: the user's answer to a password / passphrase / keyboard-interactive prompt */
  promptAnswer: 'ssh:prompt-answer',
  /** main → renderer: engine events */
  event: 'ssh:event',
  /** invoke: one vault, key or host-key operation (see AppCalls in ipc.ts) */
  call: 'app:call',
  /** main → renderer: the vault was locked, unlocked or created */
  vaultEvent: 'vault:event',
  /** invoke: write text to the system clipboard */
  clipboardWrite: 'clipboard:write',
  /** invoke: read text from the system clipboard (explicit paste only) */
  clipboardRead: 'clipboard:read',
  /** send: flash the taskbar entry (terminal bell while unfocused) */
  attention: 'window:attention',
  /** send: list / end / scroll tmux sessions over a live session's connection */
  tmux: 'ssh:tmux',
  /** send: show a desktop notification about a terminal */
  notify: 'window:notify',
  /** main → renderer: the user clicked a notification (its tag) */
  notificationClick: 'window:notification-click',
  /** send: toggle full screen */
  fullScreen: 'window:full-screen',
  /**
   * invoke (preload only): local paths of files the user dropped, which main
   * checks and turns into upload grants. The page cannot name a path itself:
   * the preload reads it from a real drop with `webUtils.getPathForFile`.
   */
  grantFiles: 'files:grant',
  /** send: open an http(s) link in the system browser (main checks it) */
  openExternal: 'window:open-external',
} as const;

export const MAX_PASSWORD_LENGTH = 1024;
export const MAX_PRIVATE_KEY_LENGTH = 32 * 1024;
/** One input message; the renderer slices larger pastes. */
export const MAX_INPUT_LENGTH = 64 * 1024;
export const MAX_CLIPBOARD_LENGTH = 1024 * 1024;
/** Answers in one keyboard-interactive round. */
export const MAX_PROMPTS = 10;

/** Failures shown to the user; the message text is safe to display. */
export type SshErrorCode =
  | 'host_key_mismatch'
  | 'host_key_rejected'
  | 'auth_failed'
  | 'auth_cancelled'
  | 'invalid_key'
  | 'vault_locked'
  | 'unreachable'
  | 'timeout'
  | 'connection_lost'
  | 'too_many_sessions'
  | 'invalid_request';

/** Errors that retrying will not fix. */
export const FATAL_ERRORS: ReadonlySet<SshErrorCode> = new Set([
  'host_key_mismatch',
  'host_key_rejected',
  'auth_failed',
  'auth_cancelled',
  'invalid_key',
  'vault_locked',
  'too_many_sessions',
  'invalid_request',
]);

/** Failures of an `app:call`; the message text is safe to display. */
export type CallErrorCode =
  | 'locked'
  | 'absent'
  | 'exists'
  | 'wrong_password'
  | 'password_required'
  | 'os_unavailable'
  | 'corrupt'
  | 'newer_version'
  | 'invalid_key'
  | 'needs_passphrase'
  | 'wrong_passphrase'
  | 'not_found'
  | 'io'
  | 'invalid_request'
  /** The session is not connected (yet, or any more). */
  | 'not_connected'
  /** The remote account may not do that, or the path is outside the host's file roots. */
  | 'permission_denied'
  | 'engine';

export type CallResult<T> =
  { ok: true; value: T } | { ok: false; code: CallErrorCode; message: string };

export type PromptKind = 'password' | 'passphrase' | 'keyboard-interactive';

/** Engine → renderer events (relayed by main on `Channel.event`). */
export type SessionEvent =
  | {
      type: 'host-key';
      sessionId: string;
      requestId: string;
      host: string;
      port: number;
      algorithm: string;
      fingerprint: string;
    }
  | {
      /** The server presented a key that differs from the pinned one; the connection is refused. */
      type: 'host-key-changed';
      sessionId: string;
      /** Token for `hostKeys.replace`; the engine keeps the presented key. */
      requestId: string;
      host: string;
      port: number;
      algorithm: string;
      fingerprint: string;
      previous: { algorithm: string; fingerprint: string }[];
    }
  | {
      /** The engine needs a secret from the user (it never sends one). */
      type: 'prompt';
      sessionId: string;
      requestId: string;
      kind: PromptKind;
      title: string;
      /** Why it asks again (e.g. the password was rejected), or server instructions. */
      message: string;
      prompts: { label: string; echo: boolean }[];
      /** The answer may be saved in the vault. */
      canRemember: boolean;
    }
  | {
      type: 'ready';
      sessionId: string;
      /** The tmux session the terminal runs in, or null for a plain shell. */
      tmux: string | null;
    }
  | {
      /** The host's quqa tmux sessions (after connecting, or on request). */
      type: 'tmux-sessions';
      sessionId: string;
      /** tmux is installed on the host. */
      available: boolean;
      sessions: TmuxSessionInfo[];
    }
  | {
      /** tmux copy-mode state after a history action. */
      type: 'history';
      sessionId: string;
      inMode: boolean;
      position: number;
      size: number;
    }
  | { type: 'data'; sessionId: string; data: Uint8Array }
  | {
      /** An upload or download over the session's connection changed state or progressed. */
      type: 'transfer';
      sessionId: string;
      transfer: TransferEvent;
    }
  | {
      /** The session's port forwards (all of them, after any change). */
      type: 'forwards';
      sessionId: string;
      forwards: ForwardEvent[];
    }
  | { type: 'error'; sessionId: string; code: SshErrorCode; message: string }
  | { type: 'closed'; sessionId: string; exitCode: number | null };

export type VaultState = 'absent' | 'locked' | 'unlocked';

/** One tmux session on a host, as `tmux list-sessions` reports it. */
export interface TmuxSessionInfo {
  name: string;
  /** Clients attached right now (another window, another computer). */
  attached: number;
  createdAt: string;
  /** Seconds since the last activity. */
  idleSeconds: number;
  /** Folder and program of the active pane. */
  path: string;
  command: string;
}

export type TransferState = 'running' | 'interrupted' | 'done' | 'failed' | 'cancelled';

/** One upload or download (TransferInfo in ipc.ts is its schema). */
export interface TransferEvent {
  id: string;
  sessionId: string;
  direction: 'upload' | 'download';
  /** The file name (remote for uploads' target, local for downloads' result). */
  name: string;
  /** The remote file (its final path for uploads). */
  remotePath: string;
  bytes: number;
  total: number;
  state: TransferState;
  /** Why it failed or was interrupted; safe to show. */
  error: string;
}

export type ForwardKind = 'local' | 'remote' | 'dynamic';
export type ForwardState = 'starting' | 'listening' | 'paused' | 'failed';

/** One port forward (ForwardInfo in ipc.ts is its schema). */
export interface ForwardEvent {
  id: string;
  sessionId: string;
  hostId: string | null;
  /** The saved forward of the host it was started from, if any. */
  savedId: string | null;
  kind: ForwardKind;
  bindAddress: string;
  bindPort: number;
  destHost: string;
  destPort: number;
  state: ForwardState;
  error: string;
  /** Open connections through it right now. */
  connections: number;
  bytesIn: number;
  bytesOut: number;
}
