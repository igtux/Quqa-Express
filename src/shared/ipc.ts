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
export const USER_PATTERN = '^[A-Za-z0-9._@\\\\][A-Za-z0-9._@\\\\-]{0,63}$';
const SESSION_ID_PATTERN = '^s[0-9]{1,9}$';
const REQUEST_ID_PATTERN = '^k[0-9]{1,9}$';
const PROMPT_ID_PATTERN = '^p[0-9]{1,9}$';
const CHANGE_ID_PATTERN = '^c[0-9]{1,9}$';
export const KEY_ID_PATTERN = '^key_[0-9a-f]{16}$';
export const HOST_ID_PATTERN = '^h_[0-9a-f]{16}$';
/** The only tmux session names the app creates, attaches to or ends. */
export const TMUX_NAME_PATTERN = '^quqa-[0-9a-f]{32}$';
/** Tags a desktop notification with the terminal it is about. */
const NOTIFY_TAG_PATTERN = '^t[0-9]{1,9}$';
/** Colour scheme and font ids (themes.ts). */
const THEME_ID_PATTERN = '^[a-z0-9-]{1,32}$';
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
export const HostId = Type.String({ pattern: HOST_ID_PATTERN });
export const TmuxName = Type.String({ pattern: TMUX_NAME_PATTERN });
export const UserName = Type.String({ pattern: USER_PATTERN });
/** A short single-line text that may be empty (group, alias). */
const ShortText = (max: number) =>
  Type.String({ maxLength: max, pattern: `^[^\\u0000-\\u001f\\u007f]{0,${max}}$` });
/** Multi-line notes: no control characters but tab and newline. */
const NOTES_PATTERN = '^[^\\u0000-\\u0008\\u000b-\\u001f\\u007f]*$';

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

/** An ad-hoc connection (Quick Connect): address, user and login method given here. */
export const AdhocConnect = Type.Object(
  {
    host: Host,
    port: Port,
    username: UserName,
    auth: Auth,
    cols: Cols,
    rows: Rows,
  },
  { additionalProperties: false },
);
export type AdhocConnect = Static<typeof AdhocConnect>;

/**
 * What a connection to a saved host is for. `shell`: a terminal, inside the
 * tmux session `tmux` when the host has resumable sessions on (and tmux is
 * installed), else a plain shell. `list` / `end`: log in, list the host's
 * quqa tmux sessions (after ending `session`), report them and close.
 */
export const HostAction = Type.Union([
  Type.Object(
    { type: Type.Literal('shell'), tmux: Type.Union([TmuxName, Type.Null()]) },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal('list') }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('end'), session: TmuxName }, { additionalProperties: false }),
]);
export type HostAction = Static<typeof HostAction>;

/** A connection to a saved host, by id: the engine takes address, user and login from it. */
export const HostConnect = Type.Object(
  { hostId: HostId, action: HostAction, cols: Cols, rows: Rows },
  { additionalProperties: false },
);
export type HostConnect = Static<typeof HostConnect>;

export const ConnectRequest = Type.Union([AdhocConnect, HostConnect]);
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

/** tmux on a live session's own connection: list sessions, end one, or drive history (copy-mode). */
export const TmuxMessage = Type.Union([
  Type.Object({ sessionId: SessionId, op: Type.Literal('list') }, { additionalProperties: false }),
  Type.Object(
    { sessionId: SessionId, op: Type.Literal('end'), session: TmuxName },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      sessionId: SessionId,
      op: Type.Literal('history'),
      action: Type.Union([Type.Literal('enter'), Type.Literal('exit'), Type.Literal('scroll')]),
      /** Negative scrolls up. */
      lines: Type.Integer({ minimum: -500, maximum: 500 }),
    },
    { additionalProperties: false },
  ),
]);
export type TmuxMessage = Static<typeof TmuxMessage>;

/** A desktop notification about a terminal; clicking it reports `tag` back. */
export const NotifyMessage = Type.Object(
  {
    title: ShortText(120),
    body: ShortText(200),
    tag: Type.String({ pattern: NOTIFY_TAG_PATTERN }),
  },
  { additionalProperties: false },
);
export type NotifyMessage = Static<typeof NotifyMessage>;

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
    /** Saved hosts that log in with this key. */
    usedBy: Type.Integer({ minimum: 0 }),
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

/* ----- Saved hosts ---------------------------------------------------------- */

export const TAG_PATTERN = '^[^\\s,\\u0000-\\u001f\\u007f]{1,32}$';
export const MAX_HOSTS = 1000;
export const MAX_TMUX_SESSIONS = 20;

/** What the user edits; no secrets (a password login asks or uses the saved password). */
export const HostInput = obj({
  name: Label,
  address: Host,
  port: Port,
  username: UserName,
  auth: Auth,
  os: Type.Union([Type.Literal('linux'), Type.Literal('windows')]),
  group: ShortText(64),
  tags: Type.Array(Type.String({ pattern: TAG_PATTERN }), { maxItems: 16 }),
  notes: Type.String({ maxLength: 4000, pattern: NOTES_PATTERN }),
  /** Card accent, `#rrggbb`, or empty. */
  color: Type.String({ pattern: '^(#[0-9a-f]{6})?$' }),
  /** Resumable sessions: run terminals inside tmux when the host has it. */
  tmux: Type.Boolean(),
  /** Phase 4: another saved host to jump through (stored, not used yet). */
  jumpHostId: Type.Union([HostId, Type.Null()]),
  /** Phase 4: `ProxyJump` as read from ~/.ssh/config, kept for later. */
  proxyJump: ShortText(255),
  /** Per-host terminal look; empty = the app default. */
  scheme: Type.String({ pattern: '^([a-z0-9-]{1,32})?$' }),
  font: Type.String({ pattern: '^([a-z0-9-]{1,32})?$' }),
});
export type HostInput = Static<typeof HostInput>;

export const HostInfo = obj({
  id: HostId,
  ...HostInput.properties,
  createdAt: Type.String({ maxLength: 40 }),
  lastUsedAt: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
  connectCount: Type.Integer({ minimum: 0 }),
});
export type HostInfo = Static<typeof HostInfo>;

export const LatencyResult = obj({
  id: HostId,
  /** TCP connect time to the SSH port; null when it failed. */
  ms: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  error: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
});
export type LatencyResult = Static<typeof LatencyResult>;

/** One `Host` entry found in ~/.ssh/config, after wildcard defaults were applied. */
export const SshConfigEntry = obj({
  alias: Type.String({ maxLength: 255 }),
  hostName: Type.String({ maxLength: 255 }),
  user: Type.String({ maxLength: 64 }),
  port: Port,
  identityFile: Type.String({ maxLength: 4096 }),
  proxyJump: Type.String({ maxLength: 255 }),
  /** Why it cannot be imported as is (bad address or user); empty when it can. */
  problem: Type.String({ maxLength: 200 }),
  /** A saved host already has this address, port and user. */
  duplicate: Type.Boolean(),
});
export type SshConfigEntry = Static<typeof SshConfigEntry>;

export const SshConfigPreview = obj({
  found: Type.Boolean(),
  /** Hands the parsed file to `sshConfig.import` (the renderer never names files). */
  token: Type.String({ pattern: '^[0-9a-f]{32}$' }),
  entries: Type.Array(SshConfigEntry, { maxItems: MAX_HOSTS }),
  /** What was not imported: Include, Match, unknown keywords (shown to the user). */
  notes: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 50 }),
});
export type SshConfigPreview = Static<typeof SshConfigPreview>;

export const SshConfigImported = obj({
  hosts: Type.Integer({ minimum: 0 }),
  keys: Type.Integer({ minimum: 0 }),
  /** One line per entry whose key could not be imported (the host uses a password then). */
  problems: Type.Array(Type.String({ maxLength: 300 }), { maxItems: MAX_HOSTS }),
});
export type SshConfigImported = Static<typeof SshConfigImported>;

/* ----- UI state (saved in the vault, no secrets) ---------------------------- */

const ThemeId = Type.String({ pattern: THEME_ID_PATTERN });

export const SavedPane = obj({
  hostId: HostId,
  /** The tmux session to re-attach; null: a fresh shell. */
  session: Type.Union([TmuxName, Type.Null()]),
});
export type SavedPane = Static<typeof SavedPane>;

export const UiState = obj({
  scheme: ThemeId,
  font: ThemeId,
  zoom: Type.Integer({ minimum: -6, maximum: 10 }),
  /** Desktop notifications when a background terminal rings or an agent finishes. */
  notifications: Type.Boolean(),
  /** A short chime with them. */
  sound: Type.Boolean(),
  /** Re-open the last tabs (tmux sessions re-attach) at start. */
  restoreTabs: Type.Boolean(),
  groupDock: Type.Boolean(),
  /** Favorites bar: a session (tmux) or a host (session null). */
  favorites: Type.Array(obj({ hostId: HostId, session: Type.Union([TmuxName, Type.Null()]) }), {
    maxItems: 32,
  }),
  /** Session names chosen by the user. */
  aliases: Type.Array(obj({ session: TmuxName, label: ShortText(60) }), { maxItems: 500 }),
  /** tmux sessions hidden from the dock ("Forget"). */
  forgotten: Type.Array(TmuxName, { maxItems: 500 }),
  layout: obj({
    tabs: Type.Array(
      obj({
        split: Type.Union([Type.Literal('none'), Type.Literal('h'), Type.Literal('v')]),
        panes: Type.Array(SavedPane, { minItems: 1, maxItems: 2 }),
      }),
      { maxItems: 32 },
    ),
    active: Type.Integer({ minimum: -1, maximum: 31 }),
  }),
});
export type UiState = Static<typeof UiState>;

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
  'hosts.list': { params: Empty, result: obj({ hosts: Type.Array(HostInfo) }) },
  /** Creates a host (no `id`) or replaces the editable fields of one. */
  'hosts.save': { params: obj({ id: Type.Optional(HostId), host: HostInput }), result: HostInfo },
  /** `forgetHostKey`: also drop the pinned key, unless another host uses the address. */
  'hosts.delete': { params: obj({ id: HostId, forgetHostKey: Type.Boolean() }), result: Empty },
  /** TCP connect time to each host's SSH port (no login, nothing sent). */
  'hosts.ping': {
    params: obj({ ids: Type.Array(HostId, { minItems: 1, maxItems: 100 }) }),
    result: obj({ results: Type.Array(LatencyResult) }),
  },
  /** Reads ~/.ssh/config (or a chosen file) and returns what could be imported. */
  'sshConfig.preview': { params: obj({ chooseFile: Type.Boolean() }), result: SshConfigPreview },
  /** Imports the chosen entries; `importKeys`: read their IdentityFile into the vault. */
  'sshConfig.import': {
    params: obj({
      token: Type.String({ pattern: '^[0-9a-f]{32}$' }),
      aliases: Type.Array(Type.String({ maxLength: 255 }), { minItems: 1, maxItems: MAX_HOSTS }),
      importKeys: Type.Boolean(),
      tmux: Type.Boolean(),
    }),
    result: SshConfigImported,
  },
  'ui.get': { params: Empty, result: UiState },
  'ui.save': { params: UiState, result: Empty },
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
  /** List, end or scroll (history) tmux sessions over a live session's connection. */
  tmux(message: TmuxMessage): void;
  /** Shows a desktop notification (main skips it while the window has focus). */
  notify(message: NotifyMessage): void;
  /** Called with the tag of a notification the user clicked. */
  onNotificationClick(listener: (tag: string) => void): () => void;
  toggleFullScreen(): void;
  /** Set only when the app was started for the UI smoke test. */
  testHooks: boolean;
}
