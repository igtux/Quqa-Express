import { describe, expect, it } from 'vitest';
import {
  algorithmOf,
  describeHostKey,
  fingerprintOf,
  hostKeyAlgorithmsFor,
  matchesPin,
} from './host-keys.js';
import { KnownHosts } from './known-hosts.js';

// Vectors produced with `ssh-keygen -lf` (OpenSSH 9).
const ED25519 = Buffer.from(
  'AAAAC3NzaC1lZDI1NTE5AAAAIF2K8STiP1WH2Lprxl+eGXhAus3a9xSArFcbGbeKFb4Y',
  'base64',
);
const ED25519_FP = 'SHA256:sSVbvq85ZNE3fKJF/ZmlmWM9ILBZmNn0YRBow4EAdEU';
const RSA = Buffer.from(
  'AAAAB3NzaC1yc2EAAAADAQABAAABAQCw/jW9l/kTAUbgXo5LyCYJH4kvIahOcF5R0/mFIxOc9HuALLd/mE5fMnAGFW1i4Ek2YY4soGU1svlVbR9b9MkhmZEAEnxeYYnn/b4TWBSsvogoLzwSs2bn69YOJBzZokE60xWE321Tz5tYoCgK2UAyq2UFwiRgkHGghDxKGAIfQL9B99EwHVupYYWXvO6ViXPwVfFbgcY/e86Vs+gmuSuLZpk9E7NVk/YcrkKTQavu1MG+cqjFt526kBV+BlOrrfnIUiSa9GHIAwo+eM6i9u+S5wCeZuZdKQW4IWG1E5iCX35J5iVexJj0b6sBPwT2sDLYIspDlhVi1jcnGaBVaPst',
  'base64',
);
const RSA_FP = 'SHA256:HHq7dsaWqGOw5XkB7ObOfG6x0nHpjAJPlAA9pnK3khM';

describe('host key fingerprints', () => {
  it('matches ssh-keygen for ed25519 and RSA keys', () => {
    expect(fingerprintOf(ED25519)).toBe(ED25519_FP);
    expect(fingerprintOf(RSA)).toBe(RSA_FP);
  });

  it('reads the algorithm from the key blob', () => {
    expect(algorithmOf(ED25519)).toBe('ssh-ed25519');
    expect(algorithmOf(RSA)).toBe('ssh-rsa');
    expect(describeHostKey(ED25519)).toEqual({
      algorithm: 'ssh-ed25519',
      key: ED25519.toString('base64'),
      fingerprint: ED25519_FP,
    });
  });

  it('rejects truncated and malformed blobs', () => {
    expect(() => algorithmOf(Buffer.alloc(2))).toThrow(/Truncated/);
    expect(() => algorithmOf(Buffer.from([0, 0, 0, 200, 1, 2]))).toThrow(/Malformed/);
    expect(() => algorithmOf(Buffer.from([0, 0, 0, 0]))).toThrow(/Malformed/);
    expect(() => algorithmOf(Buffer.from([0, 0, 0, 2, 0x0a, 0x0d]))).toThrow(/Malformed/);
  });
});

describe('pin comparison', () => {
  const pin = { algorithm: 'ssh-ed25519', key: ED25519.toString('base64') };

  it('matches the exact key only', () => {
    expect(matchesPin(ED25519, [pin])).toBe(true);
    expect(matchesPin(RSA, [pin])).toBe(false);
    const flipped = Buffer.from(ED25519);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(matchesPin(flipped, [pin])).toBe(false);
    expect(matchesPin(ED25519.subarray(0, 20), [pin])).toBe(false);
    expect(matchesPin(ED25519, [])).toBe(false);
  });

  it('offers only the pinned key types, RSA with SHA-2 signatures', () => {
    expect(hostKeyAlgorithmsFor([pin])).toEqual(['ssh-ed25519']);
    expect(hostKeyAlgorithmsFor([{ algorithm: 'ssh-rsa', key: '' }])).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256',
    ]);
  });
});

describe('KnownHosts', () => {
  it('distinguishes unknown, trusted and changed keys per host and port', async () => {
    const hosts = new KnownHosts();
    expect(hosts.check('Example.com', 22, ED25519)).toBe('unknown');
    await hosts.accept('Example.com', 22, describeHostKey(ED25519));
    expect(hosts.check('example.com', 22, ED25519)).toBe('trusted');
    expect(hosts.check('example.com', 22, RSA)).toBe('mismatch');
    expect(hosts.check('example.com', 2222, RSA)).toBe('unknown');
    await hosts.accept('example.com', 22, describeHostKey(ED25519));
    expect(hosts.pinsFor('example.com', 22)).toHaveLength(1);
    await hosts.forget('example.com', 22);
    expect(hosts.check('example.com', 22, ED25519)).toBe('unknown');
  });
});
