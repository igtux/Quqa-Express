/**
 * The renderer ↔ main contract. The renderer is untrusted: everything it
 * sends is checked against these schemas in the main process before it is
 * acted on or passed to the SSH engine. The renderer sends intents (connect,
 * type, resize, accept a host key, use key `key_…`); it never receives a
 * stored key, passphrase or password, and it sends a secret only when the
 * user typed or pasted it, once, with the intent that needs it.
 */
import Type, { type Static, type TSchema } from 'typebox';

import {
  MAX_CLIPBOARD_LENGTH,
  MAX_INPUT_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_PRIVATE_KEY_LENGTH,
  MAX_PROMPTS,
  type CallResult,
  type SessionEvent,
  type VaultState,
} from './protocol.js';

export * from './protocol.js';

/** Hostname, IPv4 or IPv6 literal; no spaces, no URL syntax. */
export const HOST_PATTERN =
  '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\\.?|\\[?[0-9A-Fa-f:.]{2,45}\\]?)$';
/** POSIX-ish user names, plus the `DOMAIN\\user` and `user@domain` forms Windows servers use. */
const USER_PATTERN = '^[A-Za-z0-9._@\\\\][A-Za-z0-9._@\\\\-]{0,63}$';
const SESSION_ID_PATTERN = '^s[0-9]{1,9}$';
const REQUEST_ID_PATTERN = '^k[0-9]{1,9}$';
const PROMPT_ID_PATTERN = '^p[0-9]{1,9}$';
const CHANGE_ID_PATTERN = '^c[0-9]{1,9}$';
export const KEY_ID_PATTERN = '^key_[0-9a-f]{16}$';
/** One line of printable text (labels end up in key comments and the UI). */
const LABEL_PATTERN = '^[^\\u0000-\\u001f\\u007f]{1,64}$';

export const SessionId = Type.String({ pattern: SESSION_ID_PATTERN });
export const KeyId = Type.String({ pattern: KEY_ID_PATTERN });
export const Host = Type.String({ minLength: 1, maxLength: 253, pattern: HOST_PATTERN });
export const Port = Type.Integer({ minimum: 1, maximum: 65535 });
export const Cols = Type.Integer({ minimum: 2, maximum: 1000 });
export const Rows = Type.Integer({ minimum: 1, maximum: 500 });
export const Secret = Type.String({ minLength: 1, maxLength: MAX_PASSWORD_LENGTH });
export const Label = Type.String({ pattern: LABEL_PATTERN });

/** Log in with a password: the engine uses the saved one or asks the user. */
export const PasswordAuth = Type.Object(
  { kind: Type.Literal('password') },
  { additionalProperties: false },
);

/** Log in with a key from the vault, by id. */
export const KeyAuth = Type.Object(
  { kind: Type.Literal('key'), keyId: KeyId },
  { additionalProperties: false },
);

export const Auth = Type.Union([PasswordAuth, KeyAuth]);
export type Auth = Static<typeof Auth>;

export const ConnectRequest = Type.Object(
  {
    host: Host,
    port: Port,
    username: Type.String({ pattern: USER_PATTERN }),
    auth: Auth,
    cols: Cols,
    rows: Rows,
  },
  { additionalProperties: false },
);
export type ConnectRequest = Static<typeof ConnectRequest>;

export const ConnectResult = Type.Object({ sessionId: SessionId }, { additionalProperties: false });
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

/** The user's answer to a credential prompt; `answers: null` cancels. Sent once, never stored. */
export const PromptAnswer = Type.Object(
  {
    requestId: Type.String({ pattern: PROMPT_ID_PATTERN }),
    answers: Type.Union([
      Type.Array(Type.String({ maxLength: MAX_PASSWORD_LENGTH }), { maxItems: MAX_PROMPTS }),
      Type.Null(),
    ]),
    remember: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type PromptAnswer = Static<typeof PromptAnswer>;

export const ClipboardText = Type.String({ maxLength: MAX_CLIPBOARD_LENGTH });

/* ----- Vault, keys and host keys (one `app:call` channel) ------------------ */

export const VaultMode = Type.Union([
  /** The data key is wrapped by the OS key store (DPAPI / Keychain / libsecret). */
  Type.Literal('os'),
  /** Master password only: the vault opens on any machine ("portable"). */
  Type.Literal('password'),
  /** Both the OS key store and the master password are needed. */
  Type.Literal('os+password'),
]);
export type VaultMode = Static<typeof VaultMode>;

export const VaultSettings = Type.Object(
  {
    /** Lock after this many minutes without keyboard or mouse input; 0 = never. */
    autoLockMinutes: Type.Integer({ minimum: 0, maximum: 1440 }),
    /** Lock when the computer sleeps or the screen locks. */
    lockOnSleep: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type VaultSettings = Static<typeof VaultSettings>;

export const VaultStatus = Type.Object(
  {
    state: Type.Union([Type.Literal('absent'), Type.Literal('locked'), Type.Literal('unlocked')]),
    mode: Type.Union([VaultMode, Type.Null()]),
    /** The OS key store is usable (false on Linux without a keyring). */
    osAvailable: Type.Boolean(),
    /** Known only while unlocked. */
    settings: Type.Union([VaultSettings, Type.Null()]),
  },
  { additionalProperties: false },
);
export type VaultStatus = Static<typeof VaultStatus>;

/** Public data about a stored key. Never the private key or its passphrase. */
export const KeyInfo = Type.Object(
  {
    id: KeyId,
    label: Type.String({ maxLength: 64 }),
    algorithm: Type.String({ maxLength: 64 }),
    fingerprint: Type.String({ maxLength: 128 }),
    /** OpenSSH one-line public key, for `authorized_keys`. */
    publicKey: Type.String({ maxLength: 16 * 1024 }),
    createdAt: Type.String({ maxLength: 40 }),
    /** The stored private key is protected by a passphrase. */
    encrypted: Type.Boolean(),
    /** That passphrase is saved in the vault (otherwise asked once per unlock). */
    passphraseSaved: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type KeyInfo = Static<typeof KeyInfo>;

export const PinInfo = Type.Object(
  {
    host: Type.String({ maxLength: 253 }),
    port: Port,
    algorithm: Type.String({ maxLength: 64 }),
    fingerprint: Type.String({ maxLength: 128 }),
    source: Type.Union([Type.Literal('trusted'), Type.Literal('known_hosts')]),
    addedAt: Type.String({ maxLength: 40 }),
  },
  { additionalProperties: false },
);
export type PinInfo = Static<typeof PinInfo>;

export const ImportSummary = Type.Object(
  {
    /** False when there was no known_hosts file (or the dialog was cancelled). */
    found: Type.Boolean(),
    imported: Type.Integer({ minimum: 0 }),
    hashed: Type.Integer({ minimum: 0 }),
    skipped: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type ImportSummary = Static<typeof ImportSummary>;

const Empty = Type.Object({}, { additionalProperties: false });
const obj = <P extends Record<string, TSchema>>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });

/**
 * Every renderer → main call: its parameters and its result. Main checks the
 * parameters before acting and the result before answering, so a field that
 * is not listed here (a key, a passphrase) can never reach the renderer.
 */
export const AppCalls = {
  'vault.status': { params: Empty, result: VaultStatus },
  /** No password: protected by the OS key store. `portable`: password only. */
  'vault.create': {
    params: obj({ password: Type.Optional(Secret), portable: Type.Optional(Type.Boolean()) }),
    result: VaultStatus,
  },
  'vault.unlock': { params: obj({ password: Type.Optional(Secret) }), result: VaultStatus },
  'vault.lock': { params: Empty, result: VaultStatus },
  /** Set, change or remove (no `password`) the master password. */
  'vault.changePassword': {
    params: obj({
      current: Type.Optional(Secret),
      password: Type.Optional(Secret),
      portable: Type.Optional(Type.Boolean()),
    }),
    result: VaultStatus,
  },
  'vault.updateSettings': { params: VaultSettings, result: VaultStatus },
  'keys.list': { params: Empty, result: obj({ keys: Type.Array(KeyInfo) }) },
  'keys.generate': { params: obj({ label: Label }), result: KeyInfo },
  /** Pasted key text; sent once, sealed by the engine, never returned. */
  'keys.import': {
    params: obj({
      label: Label,
      privateKey: Type.String({ minLength: 1, maxLength: MAX_PRIVATE_KEY_LENGTH }),
      passphrase: Type.Optional(Secret),
      savePassphrase: Type.Boolean(),
    }),
    result: KeyInfo,
  },
  /** Main shows an open-file dialog; the engine reads the file. `imported: null` = cancelled. */
  'keys.importFile': {
    params: obj({
      label: Label,
      passphrase: Type.Optional(Secret),
      savePassphrase: Type.Boolean(),
    }),
    result: obj({ imported: Type.Union([KeyInfo, Type.Null()]) }),
  },
  'keys.delete': { params: obj({ id: KeyId }), result: Empty },
  /** Main shows a save dialog and writes `<label>.pub`. */
  'keys.exportPublic': { params: obj({ id: KeyId }), result: obj({ saved: Type.Boolean() }) },
  'hostKeys.list': {
    params: Empty,
    result: obj({ pins: Type.Array(PinInfo), hashed: Type.Integer({ minimum: 0 }) }),
  },
  /** `chooseFile: false` reads ~/.ssh/known_hosts (%USERPROFILE%\.ssh\known_hosts). */
  'hostKeys.importKnownHosts': {
    params: obj({ chooseFile: Type.Boolean() }),
    result: ImportSummary,
  },
  'hostKeys.forget': { params: obj({ host: Host, port: Port }), result: Empty },
  /** Pin the key the engine saw in a `host-key-changed` event, dropping the old pins. */
  'hostKeys.replace': {
    params: obj({ requestId: Type.String({ pattern: CHANGE_ID_PATTERN }) }),
    result: Empty,
  },
} as const satisfies Record<string, { params: TSchema; result: TSchema }>;

export type AppMethod = keyof typeof AppCalls;
export type CallParams<M extends AppMethod> = Static<(typeof AppCalls)[M]['params']>;
export type CallValue<M extends AppMethod> = Static<(typeof AppCalls)[M]['result']>;

/** What the preload script exposes as `window.quqa`. */
export interface QuqaApi {
  connect(request: ConnectRequest): Promise<ConnectResult>;
  input(message: InputMessage): void;
  resize(message: ResizeMessage): void;
  ack(message: AckMessage): void;
  disconnect(sessionId: string): void;
  reconnect(sessionId: string): void;
  answerHostKey(answer: HostKeyAnswer): void;
  answerPrompt(answer: PromptAnswer): void;
  call<M extends AppMethod>(method: M, params: CallParams<M>): Promise<CallResult<CallValue<M>>>;
  /** Subscribes to engine events; returns the unsubscribe function. */
  onEvent(listener: (event: SessionEvent) => void): () => void;
  /** Called when the vault locks, unlocks or is created. */
  onVaultChange(listener: (state: VaultState) => void): () => void;
  clipboardWrite(text: string): Promise<void>;
  clipboardRead(): Promise<string>;
  attention(): void;
  /** Set only when the app was started for the UI smoke test. */
  testHooks: boolean;
}
