import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CallError } from '../errors.js';
import { open, seal } from './crypto.js';
import { migrateVaultFile, Vault, VAULT_VERSION, type VaultFile } from './vault.js';

/** Small Argon2id parameters keep the tests fast; production uses DEFAULT_KDF. */
const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 };
const PASSWORD = 'correct horse battery staple';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quqa-vault-'));
  path = join(dir, 'vault.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const osSecrets = () => ({
  osKey: randomBytes(32).toString('base64'),
  osBlob: Buffer.from('opaque safeStorage output').toString('base64'),
});

async function fresh(options = { kdf: FAST }) {
  const vault = new Vault(path, options);
  await vault.load();
  return vault;
}

async function rejects(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(CallError);
  await expect(promise).rejects.toMatchObject({ code });
}

const readFileJson = async () => JSON.parse(await readFile(path, 'utf8')) as VaultFile;

describe('vault round trip', () => {
  it('seals items with a master password and opens them after a restart', async () => {
    const vault = await fresh();
    expect(vault.state).toBe('absent');
    await vault.create({ mode: 'password', password: PASSWORD });
    expect(vault.state).toBe('unlocked');
    await vault.put('key', 'key_0123456789abcdef', { privateKey: 'PRIVATE-MATERIAL', n: 1 });

    const again = await fresh();
    expect(again.state).toBe('locked');
    expect(again.mode).toBe('password');
    await again.unlock({ password: PASSWORD });
    expect(again.get('key', 'key_0123456789abcdef')).toEqual({
      privateKey: 'PRIVATE-MATERIAL',
      n: 1,
    });
    expect(again.list('key')).toHaveLength(1);
  });

  it('never writes plaintext, and versions the file', async () => {
    const vault = await fresh();
    await vault.create({ mode: 'password', password: PASSWORD });
    await vault.put('password', 'abc', { password: 'hunter2-SECRET' });
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain('hunter2-SECRET');
    expect(text).not.toContain(PASSWORD);
    const file = JSON.parse(text) as VaultFile;
    expect(file.format).toBe('quqa-vault');
    expect(file.version).toBe(VAULT_VERSION);
    expect(file.wrap.kdf).toMatchObject({ name: 'argon2id', ...FAST });
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('opens an OS-protected vault with the OS key only', async () => {
    const secrets = osSecrets();
    const vault = await fresh();
    await vault.create({ mode: 'os', ...secrets });
    await vault.put('settings', 'app', { autoLockMinutes: 5, lockOnSleep: false });

    const again = await fresh();
    expect(again.osBlob).toBe(secrets.osBlob);
    await rejects(again.unlock({}), 'os_unavailable');
    await rejects(again.unlock({ osKey: randomBytes(32).toString('base64') }), 'os_unavailable');
    await again.unlock({ osKey: secrets.osKey });
    expect(again.get('settings', 'app')).toEqual({ autoLockMinutes: 5, lockOnSleep: false });
  });

  it('needs both secrets in os+password mode', async () => {
    const secrets = osSecrets();
    const vault = await fresh();
    await vault.create({ mode: 'os+password', password: PASSWORD, ...secrets });
    const again = await fresh();
    await rejects(again.unlock({ osKey: secrets.osKey }), 'password_required');
    await rejects(again.unlock({ password: PASSWORD }), 'os_unavailable');
    await rejects(again.unlock({ password: 'wrong', osKey: secrets.osKey }), 'wrong_password');
    await rejects(
      again.unlock({ password: PASSWORD, osKey: randomBytes(32).toString('base64') }),
      'wrong_password',
    );
    await again.unlock({ password: PASSWORD, osKey: secrets.osKey });
    expect(again.state).toBe('unlocked');
  });

  it('refuses to create over an existing vault', async () => {
    const vault = await fresh();
    await vault.create({ mode: 'password', password: PASSWORD });
    await rejects(vault.create({ mode: 'password', password: 'other' }), 'exists');
  });
});

describe('wrong secrets and tampering', () => {
  it('rejects a wrong password and stays locked', async () => {
    const vault = await fresh();
    await vault.create({ mode: 'password', password: PASSWORD });
    const again = await fresh();
    await rejects(again.unlock({ password: 'correct horse battery stapl' }), 'wrong_password');
    await rejects(again.unlock({ password: `${PASSWORD} ` }), 'wrong_password');
    await rejects(again.unlock({}), 'password_required');
    expect(again.state).toBe('locked');
    expect(() => again.get('key', 'x')).toThrow(/locked/);
  });

  it('detects a modified item', async () => {
    const vault = await fresh();
    await vault.create({ mode: 'password', password: PASSWORD });
    await vault.put('key', 'a', { secret: 'one' });
    const file = await readFileJson();
    const box = file.items['key/a'];
    if (!box) throw new Error('missing item');
    const bytes = Buffer.from(box.sealed, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    box.sealed = bytes.toString('base64');
    await writeFile(path, JSON.stringify(file));

    const again = await fresh();
    await again.unlock({ password: PASSWORD });
    expect(() => again.get('key', 'a')).toThrow(/tampered/);
  });

  it('refuses an item moved to another id or kind (the id is associated data)', async () => {
    const vault = await fresh();
    await vault.create({ mode: 'password', password: PASSWORD });
    await vault.put('key', 'a', { secret: 'one' });
    await vault.put('key', 'b', { secret: 'two' });
    const file = await readFileJson();
    file.items['key/b'] = file.items['key/a'] as VaultFile['items'][string];
    file.items['password/a'] = file.items['key/a'] as VaultFile['items'][string];
    await writeFile(path, JSON.stringify(file));

    const again = await fresh();
    await again.unlock({ password: PASSWORD });
    expect(again.get('key', 'a')).toEqual({ secret: 'one' });
    expect(() => again.get('key', 'b')).toThrow(/tampered/);
    expect(() => again.get('password', 'a')).toThrow(/tampered/);
  });

  it('refuses a wrap whose mode was changed (no downgrade to os-only)', async () => {
    const secrets = osSecrets();
    const vault = await fresh();
    await vault.create({ mode: 'os+password', password: PASSWORD, ...secrets });
    const file = await readFileJson();
    file.wrap.mode = 'os';
    file.wrap.kdf = null;
    await writeFile(path, JSON.stringify(file));
    const again = await fresh();
    await rejects(again.unlock({ osKey: secrets.osKey }), 'os_unavailable');
  });

  it('refuses tampered key-derivation parameters', async () => {
    const vault = await fresh();
    await vault.create({ mode: 'password', password: PASSWORD });
    const file = await readFileJson();
    file.wrap.kdf = { name: 'argon2id', memoryKiB: 1, iterations: 1, parallelism: 1 };
    await writeFile(path, JSON.stringify(file));
    await rm(`${path}.bak`, { force: true });
    const again = await fresh();
    expect(() => again.state).toThrow(/key-derivation/);
  });

  it('binds the seal to its context', () => {
    const key = new Uint8Array(randomBytes(32));
    const box = seal(key, new TextEncoder().encode('x'), 'ctx-a');
    expect(open(key, box, 'ctx-a')).not.toBeNull();
    expect(open(key, box, 'ctx-b')).toBeNull();
    expect(open(new Uint8Array(randomBytes(32)), box, 'ctx-a')).toBeNull();
    expect(open(key, { ...box, nonce: 'AAAA' }, 'ctx-a')).toBeNull();
  });
});

describe('files, backups and versions', () => {
  it('writes atomically and keeps the previous file as a backup', async () => {
    const vault = await fresh();
    await vault.create({ mode: 'password', password: PASSWORD });
    await vault.put('key', 'a', { n: 1 });
    await vault.put('key', 'a', { n: 2 });
    const backup = JSON.parse(await readFile(`${path}.bak`, 'utf8')) as VaultFile;
    expect(Object.keys(backup.items)).toContain('key/a');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    // A damaged file (e.g. a crash mid-write on a filesystem without atomic rename) opens the backup.
    await writeFile(path, '{"format":"quqa-vault","vers');
    const again = await fresh();
    await again.unlock({ password: PASSWORD });
    expect(again.get('key', 'a')).toEqual({ n: 1 });
  });

  it('reports a damaged file without a backup instead of starting over', async () => {
    await writeFile(path, 'not json');
    const vault = await fresh();
    expect(() => vault.state).toThrow(/damaged/);
    await rejects(vault.create({ mode: 'password', password: PASSWORD }), 'corrupt');
  });

  it('refuses a file from a newer version', async () => {
    const vault = await fresh();
    await vault.create({ mode: 'password', password: PASSWORD });
    const file = await readFileJson();
    await writeFile(path, JSON.stringify({ ...file, version: VAULT_VERSION + 1 }));
    const again = await fresh();
    expect(() => again.state).toThrow(/newer version/);
  });

  it('upgrades older versions step by step', () => {
    const v1 = {
      format: 'quqa-vault',
      version: 1,
      wrap: { mode: 'os', salt: '', kdf: null, osBlob: null, nonce: '', sealed: '' },
      items: {},
    };
    const legacy = { format: 'quqa-vault', version: 0, wrapped: v1.wrap };
    const migrations = {
      0: (old: Record<string, unknown>) => ({ ...v1, wrap: old['wrapped'] }),
    };
    expect(migrateVaultFile(legacy, migrations)).toEqual(v1);
    expect(() => migrateVaultFile(legacy)).toThrow(/cannot be upgraded/);
    expect(() => migrateVaultFile({ format: 'other', version: 1 })).toThrow(/not a quqa-express/);
    expect(() => migrateVaultFile({ ...v1, extra: true })).toThrow(/damaged/);
    expect(() =>
      migrateVaultFile({ ...v1, items: { 'bad kind/x': { nonce: '', sealed: '' } } }),
    ).toThrow(/damaged/);
  });

  it('re-wraps with stronger KDF parameters when unlocking an older vault', async () => {
    const weak = await fresh();
    await weak.create({ mode: 'password', password: PASSWORD });
    await weak.put('key', 'a', { n: 1 });
    const stronger = { memoryKiB: 128, iterations: 2, parallelism: 1 };
    const upgraded = await fresh({ kdf: stronger });
    await upgraded.unlock({ password: PASSWORD });
    expect((await readFileJson()).wrap.kdf).toMatchObject(stronger);
    const again = await fresh({ kdf: stronger });
    await again.unlock({ password: PASSWORD });
    expect(again.get('key', 'a')).toEqual({ n: 1 });
  });
});

describe('lock and re-wrap', () => {
  it('locks, wipes the key and tells listeners', async () => {
    const vault = await fresh();
    const states: string[] = [];
    vault.onChange((state) => states.push(state));
    await vault.create({ mode: 'password', password: PASSWORD });
    await vault.put('key', 'a', { n: 1 });
    vault.lock();
    expect(vault.state).toBe('locked');
    expect(() => vault.get('key', 'a')).toThrow(/locked/);
    await expect(vault.put('key', 'b', {})).rejects.toMatchObject({ code: 'locked' });
    await vault.unlock({ password: PASSWORD });
    expect(vault.get('key', 'a')).toEqual({ n: 1 });
    expect(states).toEqual(['unlocked', 'locked', 'unlocked']);
  });

  it('changes the master password after proving the current one', async () => {
    const vault = await fresh();
    await vault.create({ mode: 'password', password: PASSWORD });
    await vault.put('key', 'a', { n: 1 });
    await rejects(
      vault.rewrap({ mode: 'password', password: 'new password 1' }),
      'password_required',
    );
    await rejects(
      vault.rewrap({ mode: 'password', password: 'new password 1', current: 'nope' }),
      'wrong_password',
    );
    await vault.rewrap({ mode: 'password', password: 'new password 1', current: PASSWORD });

    const again = await fresh();
    await rejects(again.unlock({ password: PASSWORD }), 'wrong_password');
    await again.unlock({ password: 'new password 1' });
    expect(again.get('key', 'a')).toEqual({ n: 1 });
  });

  it('moves between OS-only and password protection', async () => {
    const secrets = osSecrets();
    const vault = await fresh();
    await vault.create({ mode: 'os', ...secrets });
    await vault.rewrap({ mode: 'os+password', password: PASSWORD, ...secrets });
    const both = await fresh();
    await rejects(both.unlock({ osKey: secrets.osKey }), 'password_required');
    await both.unlock({ password: PASSWORD, osKey: secrets.osKey });
    // Portable: the password alone.
    await both.rewrap({ mode: 'password', password: PASSWORD, current: PASSWORD, ...secrets });
    const portable = await fresh();
    expect(portable.osBlob).toBeNull();
    await portable.unlock({ password: PASSWORD });
    expect(portable.state).toBe('unlocked');
  });
});
