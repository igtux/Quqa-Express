/**
 * Main ↔ SSH engine (utilityProcess) messages. Main validates renderer input
 * first; the engine checks every command again before acting on it.
 *
 * Besides the per-session commands, main makes request/response calls
 * (`type: 'call'`) for the vault, keys and host keys. Some exist only here
 * (opening the vault file, the OS wrapping key, file paths); the renderer's
 * calls (AppCalls in ipc.ts) are translated by main.
 */
import Type, { type Static, type TSchema } from 'typebox';
import {
  AckMessage,
  AppCalls,
  ConnectRequest,
  Host,
  HostKeyAnswer,
  ImportSummary,
  InputMessage,
  KeyId,
  KeyInfo,
  Label,
  PinInfo,
  Port,
  PromptAnswer,
  RemotePath,
  ResizeMessage,
  Secret,
  SessionId,
  TmuxMessage,
  VaultMode,
  VaultSettings,
} from './ipc.js';
import { MAX_PRIVATE_KEY_LENGTH, type CallErrorCode, type VaultState } from './protocol.js';

/** 32 random bytes, base64: the key the OS key store protects. */
const OsKey = Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' });
/** What `safeStorage.encryptString(osKey)` returned, base64; opaque to the engine. */
const OsBlob = Type.String({ minLength: 4, maxLength: 8192, pattern: '^[A-Za-z0-9+/]+={0,2}$' });
const FilePath = Type.String({ minLength: 1, maxLength: 4096 });

const Empty = Type.Object({}, { additionalProperties: false });
const obj = <P extends Record<string, TSchema>>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });

export const EngineVaultStatus = obj({
  state: Type.Union([Type.Literal('absent'), Type.Literal('locked'), Type.Literal('unlocked')]),
  mode: Type.Union([VaultMode, Type.Null()]),
  /** Main unwraps it with safeStorage to unlock an `os` vault. */
  osBlob: Type.Union([OsBlob, Type.Null()]),
  settings: Type.Union([VaultSettings, Type.Null()]),
});
export type EngineVaultStatus = Static<typeof EngineVaultStatus>;

const WrapParams = {
  mode: VaultMode,
  password: Type.Optional(Secret),
  osKey: Type.Optional(OsKey),
  osBlob: Type.Optional(OsBlob),
};

export const EngineCalls = {
  /** The vault file's path (in the app data folder); sent once after the engine starts. */
  'vault.open': { params: obj({ path: FilePath }), result: Empty },
  'vault.status': { params: Empty, result: EngineVaultStatus },
  'vault.create': { params: obj(WrapParams), result: Empty },
  'vault.unlock': {
    params: obj({ password: Type.Optional(Secret), osKey: Type.Optional(OsKey) }),
    result: Empty,
  },
  'vault.lock': { params: Empty, result: Empty },
  /**
   * "Start over": a vault that is not unlocked is moved to
   * `vault-backups/<timestamp>/` next to it and a new one can be created.
   * `backup`: that folder (null: there was no vault file).
   */
  'vault.reset': {
    params: Empty,
    result: obj({ backup: Type.Union([FilePath, Type.Null()]) }),
  },
  /** Re-wraps the data key (password set, changed or removed); `current` proves the old password. */
  'vault.rewrap': {
    params: obj({ current: Type.Optional(Secret), ...WrapParams }),
    result: Empty,
  },
  'vault.updateSettings': { params: VaultSettings, result: Empty },
  'keys.list': { params: Empty, result: obj({ keys: Type.Array(KeyInfo) }) },
  'keys.generate': { params: obj({ label: Label }), result: KeyInfo },
  'keys.import': {
    params: obj({
      label: Label,
      privateKey: Type.String({ minLength: 1, maxLength: MAX_PRIVATE_KEY_LENGTH }),
      passphrase: Type.Optional(Secret),
      savePassphrase: Type.Boolean(),
    }),
    result: KeyInfo,
  },
  /** Reads a key file chosen in main's open dialog. */
  'keys.importPath': {
    params: obj({
      label: Label,
      path: FilePath,
      passphrase: Type.Optional(Secret),
      savePassphrase: Type.Boolean(),
    }),
    result: KeyInfo,
  },
  'keys.delete': { params: obj({ id: KeyId }), result: Empty },
  'keys.describe': { params: obj({ id: KeyId }), result: KeyInfo },
  'hostKeys.list': {
    params: Empty,
    result: obj({ pins: Type.Array(PinInfo), hashed: Type.Integer({ minimum: 0 }) }),
  },
  'hostKeys.importPath': { params: obj({ path: FilePath }), result: ImportSummary },
  'hostKeys.forget': { params: obj({ host: Host, port: Port }), result: Empty },
  'hostKeys.replace': {
    params: obj({ requestId: Type.String({ pattern: '^c[0-9]{1,9}$' }) }),
    result: Empty,
  },
  'hosts.list': AppCalls['hosts.list'],
  'hosts.save': AppCalls['hosts.save'],
  'hosts.delete': AppCalls['hosts.delete'],
  'hosts.ping': AppCalls['hosts.ping'],
  /** Parses an ssh config file chosen (or located) by main. */
  'sshConfig.readPath': {
    params: obj({ path: FilePath }),
    result: AppCalls['sshConfig.preview'].result,
  },
  'sshConfig.import': AppCalls['sshConfig.import'],
  'ui.get': AppCalls['ui.get'],
  'ui.save': AppCalls['ui.save'],
  'hosts.setOsc52': AppCalls['hosts.setOsc52'],
  'files.list': AppCalls['files.list'],
  'files.mkdir': AppCalls['files.mkdir'],
  'files.rename': AppCalls['files.rename'],
  'files.delete': AppCalls['files.delete'],
  /** Local files main resolved from grants (or wrote from the clipboard). */
  'files.upload': {
    params: obj({
      sessionId: SessionId,
      directory: Type.Union([RemotePath, Type.Null()]),
      files: Type.Array(
        obj({ path: FilePath, name: Type.String({ minLength: 1, maxLength: 255 }) }),
        { minItems: 1, maxItems: 100 },
      ),
      conflict: AppCalls['files.upload'].params.properties.conflict,
      wait: Type.Boolean(),
    }),
    result: AppCalls['files.upload'].result,
  },
  /** Into a local folder chosen in main's dialog. */
  'files.download': {
    params: obj({
      sessionId: SessionId,
      paths: AppCalls['files.download'].params.properties.paths,
      folder: FilePath,
    }),
    result: AppCalls['files.download'].result,
  },
  'transfers.cancel': AppCalls['transfers.cancel'],
  'transfers.resume': AppCalls['transfers.resume'],
  'forwards.start': AppCalls['forwards.start'],
  'forwards.stop': AppCalls['forwards.stop'],
  'forwards.list': AppCalls['forwards.list'],
  'agent.list': AppCalls['agent.list'],
  'keys.install': AppCalls['keys.install'],
} as const satisfies Record<string, { params: TSchema; result: TSchema }>;

export type EngineMethod = keyof typeof EngineCalls;
export type EngineParams<M extends EngineMethod> = Static<(typeof EngineCalls)[M]['params']>;
export type EngineValue<M extends EngineMethod> = Static<(typeof EngineCalls)[M]['result']>;

export const EngineCommand = Type.Union([
  obj({ type: Type.Literal('connect'), sessionId: SessionId, request: ConnectRequest }),
  obj({ type: Type.Literal('input'), ...InputMessage.properties }),
  obj({ type: Type.Literal('resize'), ...ResizeMessage.properties }),
  obj({ type: Type.Literal('ack'), ...AckMessage.properties }),
  obj({ type: Type.Literal('disconnect'), sessionId: SessionId }),
  obj({ type: Type.Literal('reconnect'), sessionId: SessionId }),
  obj({ type: Type.Literal('host-key-answer'), ...HostKeyAnswer.properties }),
  obj({ type: Type.Literal('prompt-answer'), ...PromptAnswer.properties }),
  obj({ type: Type.Literal('tmux'), message: TmuxMessage }),
  obj({
    type: Type.Literal('call'),
    callId: Type.Integer({ minimum: 1 }),
    method: Type.String({ maxLength: 64 }),
    /** Checked against EngineCalls[method].params by the engine. */
    params: Type.Unknown(),
  }),
  obj({ type: Type.Literal('shutdown') }),
]);
export type EngineCommand = Static<typeof EngineCommand>;

/** Calls that may take long (SFTP, forwards, agents): run at once, not after the calls before them. */
export const CONCURRENT_CALLS: ReadonlySet<string> = new Set([
  'files.list',
  'files.mkdir',
  'files.rename',
  'files.delete',
  'files.upload',
  'files.download',
  'transfers.cancel',
  'transfers.resume',
  'forwards.start',
  'forwards.stop',
  'forwards.list',
  'agent.list',
  'keys.install',
]);

/** Engine → main messages that are not session events. */
export type EngineReply =
  | { type: 'result'; callId: number; ok: true; value: unknown }
  | { type: 'result'; callId: number; ok: false; code: CallErrorCode; message: string }
  | { type: 'vault-state'; state: VaultState };
