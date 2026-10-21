import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import Value from 'typebox/value';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeyInfo } from '../shared/ipc.js';
import { fingerprintOf } from './host-keys.js';
import { generateEd25519, KeyStore, sanitiseComment } from './keys.js';
import { Vault } from './vault/vault.js';

const { utils } = ssh2;

let dir: string;
let vault: Vault;
let keys: KeyStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quqa-keys-'));
  vault = new Vault(join(dir, 'vault.json'), {
    kdf: { memoryKiB: 64, iterations: 1, parallelism: 1 },
  });
  await vault.load();
  await vault.create({ mode: 'password', password: 'test password' });
  keys = new KeyStore(vault);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('key generation', () => {
  // Ported from Jarvis NG apps/ssh-gateway/src/credentials/generate.test.ts.
  it('only returns keys ssh2 can parse (its generator sometimes writes unreadable ones)', () => {
    for (let i = 0; i < 500; i++) {
      expect(utils.parseKey(generateEd25519('t').private)).not.toBeInstanceOf(Error);
    }
  });

  it('stores a generated key and returns public data only', async () => {
    const info = await keys.generate('laptop 2026');
    expect(Value.Check(KeyInfo, info)).toBe(true);
    expect(info).toMatchObject({
      label: 'laptop 2026',
      algorithm: 'ssh-ed25519',
      encrypted: false,
    });
    expect(info.publicKey).toMatch(/^ssh-ed25519 AAAA[A-Za-z0-9+/=]+ laptop-2026$/);
    const blob = Buffer.from(info.publicKey.split(' ')[1] ?? '', 'base64');
    expect(info.fingerprint).toBe(fingerprintOf(blob));
    expect(JSON.stringify(info)).not.toMatch(/PRIVATE KEY/);
    expect(keys.list()).toEqual([info]);
    expect(keys.material(info.id)?.privateKey).toMatch(/BEGIN OPENSSH PRIVATE KEY/);
    // Sealed at rest.
    expect(await readFile(join(dir, 'vault.json'), 'utf8')).not.toMatch(/PRIVATE KEY/);
  });
});

describe('key import', () => {
  it('imports an OpenSSH key', async () => {
    const pair = utils.generateKeyPairSync('ed25519', { comment: 'x' });
    const info = await keys.import('imported', pair.private, undefined, false);
    expect(info.publicKey.split(' ').slice(0, 2).join(' ')).toBe(
      pair.public.split(' ').slice(0, 2).join(' '),
    );
  });

  it('imports a PEM RSA key', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const info = await keys.import('rsa', privateKey, undefined, false);
    expect(info.algorithm).toBe('ssh-rsa');
  });

  it('needs the passphrase of a protected key and can save it or not', async () => {
    const pair = utils.generateKeyPairSync('ed25519', {
      passphrase: 'open sesame',
      cipher: 'aes256-ctr',
      rounds: 16,
    });
    await expect(keys.import('k', pair.private, undefined, false)).rejects.toMatchObject({
      code: 'needs_passphrase',
    });
    await expect(keys.import('k', pair.private, 'wrong', false)).rejects.toMatchObject({
      code: 'wrong_passphrase',
    });
    const asked = await keys.import('asked', pair.private, 'open sesame', false);
    expect(asked).toMatchObject({ encrypted: true, passphraseSaved: false });
    expect(keys.material(asked.id)).toEqual({ privateKey: pair.private, encrypted: true });

    const saved = await keys.import('saved', pair.private, 'open sesame', true);
    expect(saved).toMatchObject({ encrypted: true, passphraseSaved: true });
    expect(keys.material(saved.id)?.passphrase).toBe('open sesame');
    expect(await readFile(join(dir, 'vault.json'), 'utf8')).not.toContain('open sesame');

    await keys.savePassphrase(asked.id, 'open sesame');
    expect(keys.describe(asked.id).passphraseSaved).toBe(true);
  });

  it('refuses public keys and garbage', async () => {
    const pair = utils.generateKeyPairSync('ed25519');
    await expect(keys.import('pub', pair.public, undefined, false)).rejects.toMatchObject({
      code: 'invalid_key',
    });
    await expect(keys.import('junk', 'hello', undefined, false)).rejects.toMatchObject({
      code: 'invalid_key',
    });
    expect(keys.list()).toEqual([]);
  });

  it('deletes keys', async () => {
    const info = await keys.generate('gone');
    await keys.delete(info.id);
    expect(keys.list()).toEqual([]);
    expect(keys.material(info.id)).toBeNull();
    await expect(keys.delete(info.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps key comments to one safe line', () => {
    expect(sanitiseComment('a b\nc;rm -rf /')).toBe('a-b-c-rm--rf-');
    expect(sanitiseComment('')).toBe('quqa');
  });
});
