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
  ResizeMessage,
  Secret,
  SessionId,
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

/** Engine → main messages that are not session events. */
export type EngineReply =
  | { type: 'result'; callId: number; ok: true; value: unknown }
  | { type: 'result'; callId: number; ok: false; code: CallErrorCode; message: string }
  | { type: 'vault-state'; state: VaultState };
