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
  | { type: 'ready'; sessionId: string }
  | { type: 'data'; sessionId: string; data: Uint8Array }
  | { type: 'error'; sessionId: string; code: SshErrorCode; message: string }
  | { type: 'closed'; sessionId: string; exitCode: number | null };

export type VaultState = 'absent' | 'locked' | 'unlocked';
