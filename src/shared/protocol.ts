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
  /** main → renderer: engine events */
  event: 'ssh:event',
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

/** Failures shown to the user; the message text is safe to display. */
export type SshErrorCode =
  | 'host_key_mismatch'
  | 'host_key_rejected'
  | 'auth_failed'
  | 'invalid_key'
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
  'invalid_key',
  'too_many_sessions',
  'invalid_request',
]);

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
  | { type: 'ready'; sessionId: string }
  | { type: 'data'; sessionId: string; data: Uint8Array }
  | { type: 'error'; sessionId: string; code: SshErrorCode; message: string }
  | { type: 'closed'; sessionId: string; exitCode: number | null };
