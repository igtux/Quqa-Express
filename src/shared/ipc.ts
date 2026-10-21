/**
 * The renderer ↔ main contract. The renderer is untrusted: everything it
 * sends is checked against these schemas in the main process before it is
 * acted on or passed to the SSH engine. The renderer sends intents (connect,
 * type, resize, accept a host key); it never sees a stored key or password.
 */
import Type, { type Static } from 'typebox';

import {
  MAX_CLIPBOARD_LENGTH,
  MAX_INPUT_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_PRIVATE_KEY_LENGTH,
  type SessionEvent,
} from './protocol.js';

export * from './protocol.js';

/** Hostname, IPv4 or IPv6 literal; no spaces, no URL syntax. */
const HOST_PATTERN =
  '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\\.?|\\[?[0-9A-Fa-f:.]{2,45}\\]?)$';
/** POSIX-ish user names, plus the `DOMAIN\\user` and `user@domain` forms Windows servers use. */
const USER_PATTERN = '^[A-Za-z0-9._@\\\\][A-Za-z0-9._@\\\\-]{0,63}$';
const SESSION_ID_PATTERN = '^s[0-9]{1,9}$';
const REQUEST_ID_PATTERN = '^k[0-9]{1,9}$';

export const SessionId = Type.String({ pattern: SESSION_ID_PATTERN });
export const Cols = Type.Integer({ minimum: 2, maximum: 1000 });
export const Rows = Type.Integer({ minimum: 1, maximum: 500 });

export const PasswordAuth = Type.Object(
  {
    kind: Type.Literal('password'),
    password: Type.String({ minLength: 1, maxLength: MAX_PASSWORD_LENGTH }),
  },
  { additionalProperties: false },
);

export const KeyAuth = Type.Object(
  {
    kind: Type.Literal('key'),
    privateKey: Type.String({ minLength: 1, maxLength: MAX_PRIVATE_KEY_LENGTH }),
    passphrase: Type.Optional(Type.String({ maxLength: MAX_PASSWORD_LENGTH })),
  },
  { additionalProperties: false },
);

export const Auth = Type.Union([PasswordAuth, KeyAuth]);
export type Auth = Static<typeof Auth>;

export const ConnectRequest = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 253, pattern: HOST_PATTERN }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    username: Type.String({ pattern: USER_PATTERN }),
    auth: Auth,
    cols: Cols,
    rows: Rows,
  },
  { additionalProperties: false },
);
export type ConnectRequest = Static<typeof ConnectRequest>;

export const ConnectResult = Type.Object({ sessionId: SessionId });
export type ConnectResult = Static<typeof ConnectResult>;

export const InputMessage = Type.Object(
  {
    sessionId: SessionId,
    data: Type.String({ minLength: 1, maxLength: MAX_INPUT_LENGTH }),
    /** `binary`: one byte per character (xterm's onBinary, e.g. mouse reports). */
    encoding: Type.Union([Type.Literal('utf8'), Type.Literal('binary')]),
  },
  { additionalProperties: false },
);
export type InputMessage = Static<typeof InputMessage>;

export const ResizeMessage = Type.Object(
  { sessionId: SessionId, cols: Cols, rows: Rows },
  { additionalProperties: false },
);
export type ResizeMessage = Static<typeof ResizeMessage>;

export const AckMessage = Type.Object(
  { sessionId: SessionId, bytes: Type.Integer({ minimum: 1, maximum: 64 * 1024 * 1024 }) },
  { additionalProperties: false },
);
export type AckMessage = Static<typeof AckMessage>;

export const SessionMessage = Type.Object(
  { sessionId: SessionId },
  { additionalProperties: false },
);
export type SessionMessage = Static<typeof SessionMessage>;

export const HostKeyAnswer = Type.Object(
  { requestId: Type.String({ pattern: REQUEST_ID_PATTERN }), accept: Type.Boolean() },
  { additionalProperties: false },
);
export type HostKeyAnswer = Static<typeof HostKeyAnswer>;

export const ClipboardText = Type.String({ maxLength: MAX_CLIPBOARD_LENGTH });

/** What the preload script exposes as `window.quqa`. */
export interface QuqaApi {
  connect(request: ConnectRequest): Promise<ConnectResult>;
  input(message: InputMessage): void;
  resize(message: ResizeMessage): void;
  ack(message: AckMessage): void;
  disconnect(sessionId: string): void;
  reconnect(sessionId: string): void;
  answerHostKey(answer: HostKeyAnswer): void;
  /** Subscribes to engine events; returns the unsubscribe function. */
  onEvent(listener: (event: SessionEvent) => void): () => void;
  clipboardWrite(text: string): Promise<void>;
  clipboardRead(): Promise<string>;
  attention(): void;
  /** Set only when the app was started for the UI smoke test. */
  testHooks: boolean;
}
