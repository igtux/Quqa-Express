/**
 * The vault: one JSON file in the app data folder holding sealed items
 * (private keys, passphrases, saved passwords, host-key pins, settings).
 *
 *   { format: 'quqa-vault', version: 1,
 *     wrap:  { mode, salt, kdf, osBlob, nonce, sealed },   // the data key, sealed by the KEK
 *     items: { '<kind>/<id>': { nonce, sealed } } }        // each sealed by the data key
 *
 * A random 256-bit data key seals every item, with `<kind>/<id>` as the
 * associated data. The data key itself is sealed by a key-encryption key
 * derived (HKDF-SHA256) from the secrets the vault's mode needs: a random
 * OS key kept by Electron safeStorage (DPAPI on Windows), an Argon2id hash of
 * the master password, or both. See docs/adr/0002-vault.md.
 *
 * The data key and every decrypted value live only in this process (the SSH
 * engine) and only while unlocked; `lock()` wipes the key. Writes are atomic
 * (temp file + rename) and keep the previous file as `<name>.bak`.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open as openFile, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import Type, { type Static } from 'typebox';
import Value from 'typebox/value';
import type { VaultMode, VaultSettings } from '../../shared/ipc.js';
import type { VaultState } from '../../shared/protocol.js';
import { CallError } from '../errors.js';
import {
  argon2id,
  DEFAULT_KDF,
  deriveKek,
  fromB64,
  kdfInRange,
  kdfWeakerThan,
  KEY_BYTES,
  open,
  random,
  SALT_BYTES,
  seal,
  type KdfParams,
} from './crypto.js';

export const VAULT_FORMAT = 'quqa-vault';
export const VAULT_VERSION = 1;
/** Largest vault file we read (keys are small; this is thousands of them). */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export type ItemKind = 'key' | 'password' | 'known-hosts' | 'settings' | 'host';
const ITEM_KEY = /^(key|password|known-hosts|settings|host)\/[A-Za-z0-9_.:-]{1,128}$/;

const B64 = Type.String({ maxLength: 16 * 1024 * 1024, pattern: '^[A-Za-z0-9+/]*={0,2}$' });
const SealedBox = Type.Object({ nonce: B64, sealed: B64 }, { additionalProperties: false });
const Kdf = Type.Object(
  {
    name: Type.Literal('argon2id'),
    memoryKiB: Type.Integer(),
    iterations: Type.Integer(),
    parallelism: Type.Integer(),
  },
  { additionalProperties: false },
);
const VaultFileSchema = Type.Object(
  {
    format: Type.Literal(VAULT_FORMAT),
    version: Type.Literal(VAULT_VERSION),
    wrap: Type.Object(
      {
        mode: Type.Union([
          Type.Literal('os'),
          Type.Literal('password'),
          Type.Literal('os+password'),
        ]),
        salt: B64,
        kdf: Type.Union([Kdf, Type.Null()]),
        osBlob: Type.Union([Type.String({ maxLength: 8192 }), Type.Null()]),
        nonce: B64,
        sealed: B64,
      },
      { additionalProperties: false },
    ),
    items: Type.Record(Type.String(), SealedBox),
  },
  { additionalProperties: false },
);
export type VaultFile = Static<typeof VaultFileSchema>;

/**
 * Upgrades of older file versions, keyed by the version they upgrade *from*.
 * Version 1 is the first format, so there are none yet; each future format
 * change adds one step here (and a test with a file of the old version).
 */
export const MIGRATIONS: Record<
  number,
  (file: Record<string, unknown>) => Record<string, unknown>
> = {};

/** Brings a parsed file up to the current version, or explains why it cannot. */
export function migrateVaultFile(
  raw: unknown,
  migrations: typeof MIGRATIONS = MIGRATIONS,
): VaultFile {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { format?: unknown }).format !== VAULT_FORMAT
  ) {
    throw new CallError('corrupt', 'The vault file is not a Quqa Express vault');
  }
  let file = raw as Record<string, unknown>;
  const found = file['version'];
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 0) {
    throw new CallError('corrupt', 'The vault file has no valid version');
  }
  let version: number = found;
  if (version > VAULT_VERSION) {
    throw new CallError(
      'newer_version',
      'The vault was saved by a newer version of Quqa Express; update the app to open it',
    );
  }
  while (version < VAULT_VERSION) {
    const step = migrations[version];
    if (!step) throw new CallError('corrupt', `Vault version ${version} cannot be upgraded`);
    file = step(file);
    if (file['version'] !== version + 1) throw new CallError('corrupt', 'Vault upgrade failed');
    version = version + 1;
  }
  if (!Value.Check(VaultFileSchema, file)) {
    throw new CallError('corrupt', 'The vault file is damaged');
  }
  for (const key of Object.keys(file.items)) {
    if (!ITEM_KEY.test(key)) throw new CallError('corrupt', 'The vault file is damaged');
  }
  const kdf = file.wrap.kdf;
  if (file.wrap.mode !== 'os' && (!kdf || !kdfInRange(kdf))) {
    throw new CallError('corrupt', 'The vault file has invalid key-derivation parameters');
  }
  return file;
}

export interface WrapSecrets {
  mode: VaultMode;
  password?: string | undefined;
  /** base64 of the 32-byte OS key */
  osKey?: string | undefined;
  /** safeStorage's encryption of osKey, kept in the file for main to unwrap. */
  osBlob?: string | undefined;
}

export const DEFAULT_SETTINGS: VaultSettings = { autoLockMinutes: 15, lockOnSleep: true };

export interface VaultOptions {
  /** Argon2id parameters for new wraps (tests use small ones). */
  kdf?: KdfParams;
}

const usesPassword = (mode: VaultMode) => mode !== 'os';
const usesOs = (mode: VaultMode) => mode !== 'password';

export class Vault {
  private file: VaultFile | null = null;
  private dataKey: Uint8Array | null = null;
  private loadError: CallError | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(state: VaultState) => void>();
  private readonly kdf: KdfParams;

  constructor(
    readonly path: string,
    options: VaultOptions = {},
  ) {
    this.kdf = options.kdf ?? DEFAULT_KDF;
  }

  /** Reads the file; a damaged file falls back to the backup of the previous write. */
  async load(): Promise<void> {
    this.lock();
    this.file = null;
    this.loadError = null;
    try {
      this.file = await this.read(this.path);
    } catch (error) {
      if (isMissing(error)) return;
      const failure = toCallError(error);
      if (failure.code === 'newer_version') {
        this.loadError = failure;
        return;
      }
      try {
        this.file = await this.read(`${this.path}.bak`);
        console.error('Vault file damaged; opened the backup of the previous save');
      } catch {
        this.loadError = failure;
      }
    }
  }

  get state(): VaultState {
    this.throwIfBroken();
    if (!this.file) return 'absent';
    return this.dataKey ? 'unlocked' : 'locked';
  }

  get mode(): VaultMode | null {
    return this.file?.wrap.mode ?? null;
  }

  get osBlob(): string | null {
    return this.file?.wrap.osBlob ?? null;
  }

  onChange(listener: (state: VaultState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(secrets: WrapSecrets): Promise<void> {
    this.throwIfBroken();
    if (this.file) throw new CallError('exists', 'A vault already exists');
    const dataKey = random(KEY_BYTES);
    const wrap = await this.wrap(dataKey, secrets);
    this.file = { format: VAULT_FORMAT, version: VAULT_VERSION, wrap, items: {} };
    this.dataKey = dataKey;
    this.putSealed('settings', 'app', DEFAULT_SETTINGS);
    await this.persist();
    this.changed();
  }

  async unlock(secrets: {
    password?: string | undefined;
    osKey?: string | undefined;
  }): Promise<void> {
    const file = this.requireFile();
    if (this.dataKey) return;
    const { mode } = file.wrap;
    const dataKey = await this.unwrap(file.wrap, secrets);
    this.dataKey = dataKey;
    // Re-wrap with today's (stronger) KDF parameters when the file has older ones.
    if (usesPassword(mode) && file.wrap.kdf && kdfWeakerThan(file.wrap.kdf, this.kdf)) {
      file.wrap = await this.wrap(dataKey, {
        mode,
        password: secrets.password,
        osKey: secrets.osKey,
        osBlob: file.wrap.osBlob ?? undefined,
      });
      await this.persist();
    }
    this.changed();
  }

  lock(): void {
    if (!this.dataKey) return;
    this.dataKey.fill(0);
    this.dataKey = null;
    this.changed();
  }

  /** Changes how the data key is protected; items are not re-encrypted. */
  async rewrap(secrets: WrapSecrets & { current?: string | undefined }): Promise<void> {
    const file = this.requireFile();
    const dataKey = this.requireKey();
    if (usesPassword(file.wrap.mode)) {
      if (!secrets.current) {
        throw new CallError('password_required', 'Enter the current master password');
      }
      // Proves the current password; the OS half is not needed for that check.
      await this.verifyPassword(file.wrap, secrets.current, secrets.osKey);
    }
    file.wrap = await this.wrap(dataKey, secrets);
    await this.persist();
  }

  get<T>(kind: ItemKind, id: string): T | null {
    const key = this.requireKey();
    const box = this.requireFile().items[`${kind}/${id}`];
    if (!box) return null;
    const plain = open(key, box, itemContext(kind, id));
    if (!plain) throw new CallError('corrupt', 'A vault item is damaged or was tampered with');
    try {
      return JSON.parse(Buffer.from(plain).toString('utf8')) as T;
    } finally {
      plain.fill(0);
    }
  }

  list<T>(kind: ItemKind): { id: string; value: T }[] {
    const prefix = `${kind}/`;
    return Object.keys(this.requireFile().items)
      .filter((key) => key.startsWith(prefix))
      .map((key) => {
        const id = key.slice(prefix.length);
        return { id, value: this.get<T>(kind, id) as T };
      });
  }

  async put(kind: ItemKind, id: string, value: unknown): Promise<void> {
    this.putSealed(kind, id, value);
    await this.persist();
  }

  async delete(kind: ItemKind, id: string): Promise<boolean> {
    this.requireKey();
    const file = this.requireFile();
    const key = `${kind}/${id}`;
    if (!Object.hasOwn(file.items, key)) return false;
    file.items = Object.fromEntries(Object.entries(file.items).filter(([name]) => name !== key));
    await this.persist();
    return true;
  }

  /** Resolves once every queued write has reached the disk. */
  flush(): Promise<void> {
    return this.writes;
  }

  /* ----- Internals --------------------------------------------------------- */

  private putSealed(kind: ItemKind, id: string, value: unknown) {
    const key = this.requireKey();
    const itemKey = `${kind}/${id}`;
    if (!ITEM_KEY.test(itemKey)) throw new CallError('invalid_request', 'Invalid vault item id');
    const plain = Buffer.from(JSON.stringify(value), 'utf8');
    this.requireFile().items[itemKey] = seal(key, plain, itemContext(kind, id));
    plain.fill(0);
  }

  private async wrap(dataKey: Uint8Array, secrets: WrapSecrets): Promise<VaultFile['wrap']> {
    const { mode } = secrets;
    if (usesPassword(mode) && !secrets.password) {
      throw new CallError('password_required', 'A master password is required');
    }
    if (usesOs(mode) && (!secrets.osKey || !secrets.osBlob)) {
      throw new CallError('os_unavailable', 'The system key store is not available');
    }
    const salt = random(SALT_BYTES);
    const kdf = usesPassword(mode) ? { name: 'argon2id' as const, ...this.kdf } : null;
    const kek = await kekFor(mode, salt, kdf, secrets.password, secrets.osKey);
    const box = seal(kek, dataKey, dataKeyContext(mode));
    kek.fill(0);
    return {
      mode,
      salt: Buffer.from(salt).toString('base64'),
      kdf,
      osBlob: usesOs(mode) ? (secrets.osBlob ?? null) : null,
      ...box,
    };
  }

  private async unwrap(
    wrap: VaultFile['wrap'],
    secrets: { password?: string | undefined; osKey?: string | undefined },
  ): Promise<Uint8Array> {
    const { mode } = wrap;
    if (usesPassword(mode) && !secrets.password) {
      throw new CallError('password_required', 'Enter the master password');
    }
    if (usesOs(mode) && !secrets.osKey) {
      throw new CallError('os_unavailable', 'The system key store is not available');
    }
    const kek = await kekFor(mode, fromB64(wrap.salt), wrap.kdf, secrets.password, secrets.osKey);
    const dataKey = open(kek, wrap, dataKeyContext(mode));
    kek.fill(0);
    if (!dataKey || dataKey.length !== KEY_BYTES) {
      throw usesPassword(mode)
        ? new CallError('wrong_password', 'Wrong master password')
        : new CallError(
            'os_unavailable',
            'This vault was protected for another Windows account or computer and cannot be opened here',
          );
    }
    return dataKey;
  }

  private async verifyPassword(wrap: VaultFile['wrap'], password: string, osKey?: string) {
    if (usesOs(wrap.mode) && !osKey) {
      throw new CallError('os_unavailable', 'The system key store is not available');
    }
    const key = await this.unwrap(wrap, { password, osKey });
    key.fill(0);
  }

  private async read(path: string): Promise<VaultFile> {
    const text = await readFile(path, { encoding: 'utf8' });
    if (text.length > MAX_FILE_BYTES) throw new CallError('corrupt', 'The vault file is too large');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new CallError('corrupt', 'The vault file is damaged');
    }
    return migrateVaultFile(raw);
  }

  /** Queues an atomic write of the current state. */
  private persist(): Promise<void> {
    const text = `${JSON.stringify(this.requireFile(), null, 1)}\n`;
    const run = this.writes.then(() => writeAtomic(this.path, text));
    // Keep the queue alive after a failure; the caller still sees the error.
    this.writes = run.catch(() => undefined);
    return run.catch((error: unknown) => {
      console.error('Vault write failed:', (error as NodeJS.ErrnoException).code ?? 'error');
      throw new CallError('io', 'The vault could not be saved');
    });
  }

  private requireFile(): VaultFile {
    this.throwIfBroken();
    if (!this.file) throw new CallError('absent', 'There is no vault yet');
    return this.file;
  }

  private requireKey(): Uint8Array {
    this.requireFile();
    if (!this.dataKey) throw new CallError('locked', 'The vault is locked');
    return this.dataKey;
  }

  private throwIfBroken() {
    if (this.loadError) throw this.loadError;
  }

  private changed() {
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }
}

async function kekFor(
  mode: VaultMode,
  salt: Uint8Array,
  kdf: KdfParams | null,
  password: string | undefined,
  osKey: string | undefined,
): Promise<Uint8Array> {
  const secrets: Uint8Array[] = [];
  if (usesPassword(mode)) {
    if (!kdf || !password) throw new CallError('password_required', 'Enter the master password');
    secrets.push(await argon2id(password, salt, kdf));
  }
  if (usesOs(mode)) {
    const os = fromB64(osKey ?? '');
    if (os.length !== KEY_BYTES) throw new CallError('os_unavailable', 'Invalid system key');
    secrets.push(os);
  }
  const kek = deriveKek(secrets, salt, `quqa-vault/v1/kek/${mode}`);
  for (const secret of secrets) secret.fill(0);
  return kek;
}

function itemContext(kind: ItemKind, id: string) {
  return `quqa-vault/v1/item/${kind}/${id}`;
}

function dataKeyContext(mode: VaultMode) {
  return `quqa-vault/v1/data-key/${mode}`;
}

/** Temp file + fsync + rename; the previous file is kept as `.bak`. */
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await openFile(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      const backup = `${path}.bak`;
      await copyFile(path, `${backup}.tmp`);
      await rename(`${backup}.tmp`, backup);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function toCallError(error: unknown): CallError {
  if (error instanceof CallError) return error;
  return new CallError('io', 'The vault file could not be read');
}
