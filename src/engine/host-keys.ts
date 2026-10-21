/**
 * Host-key fingerprints and comparison.
 *
 * Ported from Jarvis NG (apps/ssh-gateway/src/ssh/host-keys.ts), same owner.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ServerHostKeyAlgorithm } from 'ssh2';

/** A server host key as pinned after the user accepted it. */
export interface PinnedHostKey {
  /** e.g. `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa` */
  algorithm: string;
  /** Base64 of the SSH wire-format public key blob. */
  key: string;
}

export interface DescribedHostKey extends PinnedHostKey {
  fingerprint: string;
}

/** OpenSSH-style fingerprint: `SHA256:` + unpadded base64 of the blob's digest. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Reads the algorithm name from the start of an SSH public key blob. */
export function algorithmOf(blob: Buffer): string {
  if (blob.length < 4) throw new Error('Truncated host key');
  const length = blob.readUInt32BE(0);
  if (length === 0 || length > 64 || blob.length < 4 + length) {
    throw new Error('Malformed host key');
  }
  const name = blob.subarray(4, 4 + length).toString('ascii');
  if (!/^[A-Za-z0-9@._-]+$/.test(name)) throw new Error('Malformed host key');
  return name;
}

export function describeHostKey(blob: Buffer): DescribedHostKey {
  return {
    algorithm: algorithmOf(blob),
    key: blob.toString('base64'),
    fingerprint: fingerprintOf(blob),
  };
}

/** True if the presented key matches one of the pins exactly. */
export function matchesPin(presented: Buffer, pins: readonly PinnedHostKey[]): boolean {
  return pins.some((pin) => {
    const pinned = Buffer.from(pin.key, 'base64');
    return pinned.length === presented.length && timingSafeEqual(pinned, presented);
  });
}

/**
 * Signature algorithms to offer for pinned key types, so a server with a
 * pinned key cannot pick a different, unpinned one (RSA keys sign with SHA-2).
 */
export function hostKeyAlgorithmsFor(pins: readonly PinnedHostKey[]): ServerHostKeyAlgorithm[] {
  const algorithms = new Set<ServerHostKeyAlgorithm>();
  for (const { algorithm } of pins) {
    if (algorithm === 'ssh-rsa') {
      algorithms.add('rsa-sha2-512');
      algorithms.add('rsa-sha2-256');
    } else {
      algorithms.add(algorithm as ServerHostKeyAlgorithm);
    }
  }
  return [...algorithms];
}
