/**
 * Vault cryptography: XChaCha20-Poly1305 for every sealed value, Argon2id for
 * the master password, HKDF-SHA256 to combine wrapping secrets. All from the
 * audited, dependency-free @noble libraries (pure JavaScript, no native code).
 *
 * Every sealed value is bound to a context string through the AEAD's
 * associated data, so a ciphertext moved to another item (or another vault
 * slot) fails to open: the idea of Jarvis NG's packages/crypto/src/secret-box.ts
 * (same owner), with a 192-bit random nonce instead of GCM's 96-bit one.
 */
import { randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const KEY_BYTES = 32;
export const NONCE_BYTES = 24;
export const SALT_BYTES = 16;

export interface KdfParams {
  /** Argon2id memory in KiB. */
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** Current defaults (OWASP's first Argon2id option is 46 MiB × 1; we use more). Raised over time. */
export const DEFAULT_KDF: KdfParams = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 };

/** Lower bounds a vault file may ask for, so a tampered file cannot make the KDF trivial. */
export const MIN_KDF: KdfParams = { memoryKiB: 8, iterations: 1, parallelism: 1 };
/** Upper bounds, so a tampered file cannot make unlocking exhaust memory. */
export const MAX_KDF: KdfParams = { memoryKiB: 1024 * 1024, iterations: 64, parallelism: 8 };

export interface Sealed {
  nonce: string;
  sealed: string;
}

export function random(bytes: number): Uint8Array {
  return new Uint8Array(randomBytes(bytes));
}

const utf8 = new TextEncoder();

export function seal(key: Uint8Array, plaintext: Uint8Array, context: string): Sealed {
  const nonce = random(NONCE_BYTES);
  const sealed = xchacha20poly1305(key, nonce, utf8.encode(context)).encrypt(plaintext);
  return { nonce: toB64(nonce), sealed: toB64(sealed) };
}

/** Opens a sealed value; returns null when the key, context or bytes are wrong. */
export function open(key: Uint8Array, box: Sealed, context: string): Uint8Array | null {
  try {
    const nonce = fromB64(box.nonce);
    if (nonce.length !== NONCE_BYTES) return null;
    return xchacha20poly1305(key, nonce, utf8.encode(context)).decrypt(fromB64(box.sealed));
  } catch {
    return null;
  }
}

export async function argon2id(
  password: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<Uint8Array> {
  return argon2idAsync(utf8.encode(password.normalize('NFC')), salt, {
    t: params.iterations,
    m: params.memoryKiB,
    p: params.parallelism,
    dkLen: KEY_BYTES,
  });
}

/** The key-encryption key from the wrapping secrets the vault's mode needs. */
export function deriveKek(secrets: Uint8Array[], salt: Uint8Array, info: string): Uint8Array {
  const total = secrets.reduce((n, s) => n + s.length, 0);
  const ikm = new Uint8Array(total);
  let offset = 0;
  for (const secret of secrets) {
    ikm.set(secret, offset);
    offset += secret.length;
  }
  const kek = hkdf(sha256, ikm, salt, utf8.encode(info), KEY_BYTES);
  ikm.fill(0);
  return kek;
}

export function kdfInRange(params: KdfParams): boolean {
  return (
    Number.isInteger(params.memoryKiB) &&
    Number.isInteger(params.iterations) &&
    Number.isInteger(params.parallelism) &&
    params.memoryKiB >= Math.max(MIN_KDF.memoryKiB, 8 * params.parallelism) &&
    params.memoryKiB <= MAX_KDF.memoryKiB &&
    params.iterations >= MIN_KDF.iterations &&
    params.iterations <= MAX_KDF.iterations &&
    params.parallelism >= MIN_KDF.parallelism &&
    params.parallelism <= MAX_KDF.parallelism
  );
}

/** True when `params` is weaker than `target` in any dimension (time to re-wrap). */
export function kdfWeakerThan(params: KdfParams, target: KdfParams): boolean {
  return params.memoryKiB < target.memoryKiB || params.iterations < target.iterations;
}

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function fromB64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}
