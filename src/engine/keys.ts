/**
 * SSH private keys, sealed in the vault. Generated or imported here and never
 * returned: callers only ever see the public key and fingerprint.
 *
 * Ported from Jarvis NG (apps/ssh-gateway/src/credentials/credential-store.ts),
 * same owner: Ed25519 generation that retries until ssh2 parses the key back,
 * import with a passphrase, `sanitiseComment`. Storage is the vault instead of
 * a database; the passphrase may be saved or asked once per unlock.
 */
import { randomBytes } from 'node:crypto';
import ssh2, { type ParsedKey } from 'ssh2';
import type { KeyInfo } from '../shared/ipc.js';
import { CallError } from './errors.js';
import { fingerprintOf } from './host-keys.js';
import type { Vault } from './vault/vault.js';

const { utils } = ssh2;

/** The vault item `key/<id>`. */
interface StoredKey {
  label: string;
  algorithm: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  /** The key text as generated or imported (still passphrase-protected if it was). */
  privateKey: string;
  encrypted: boolean;
  passphrase?: string;
}

/** What the SSH client needs to authenticate. Stays inside the engine. */
export interface PrivateKeyMaterial {
  privateKey: string;
  encrypted: boolean;
  passphrase?: string;
}

/**
 * A new Ed25519 key pair that ssh2 can read back. About one generated key in
 * a few hundred is written in a form ssh2's own parser rejects ("Malformed
 * OpenSSH private key"), so such keys are discarded and generated again.
 */
export function generateEd25519(comment = ''): { private: string; public: string } {
  for (let attempt = 0; attempt < 10; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519', { comment });
    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  throw new CallError('invalid_key', 'Could not generate a usable key');
}

/** Parses key text; ssh2 returns an array for files with several keys (we take the first). */
export function parsePrivateKey(text: string, passphrase?: string): ParsedKey | Error {
  const parsed = utils.parseKey(text, passphrase);
  if (parsed instanceof Error) return parsed;
  const first = Array.isArray(parsed) ? (parsed[0] as ParsedKey | undefined) : parsed;
  return first ?? new Error('No key found');
}

const ENCRYPTED = /passphrase|encrypted|decrypt|integrity|bad decrypt/i;

export class KeyStore {
  constructor(private readonly vault: Vault) {}

  async generate(label: string): Promise<KeyInfo> {
    return this.store(label, generateEd25519(sanitiseComment(label)).private, undefined, false);
  }

  /** Imports an OpenSSH, PEM or PuTTY private key; the text is sealed and dropped. */
  async import(
    label: string,
    privateKey: string,
    passphrase: string | undefined,
    savePassphrase: boolean,
  ): Promise<KeyInfo> {
    // Is it protected at all? Parsing without a passphrase tells.
    const bare = parsePrivateKey(privateKey);
    const encrypted = bare instanceof Error && ENCRYPTED.test(bare.message);
    if (bare instanceof Error && !encrypted) {
      throw new CallError(
        'invalid_key',
        'Not a usable private key (OpenSSH, PEM or PuTTY .ppk format expected)',
      );
    }
    if (encrypted && !passphrase) {
      throw new CallError('needs_passphrase', 'This key is protected: enter its passphrase');
    }
    const parsed = encrypted ? parsePrivateKey(privateKey, passphrase) : bare;
    if (parsed instanceof Error) {
      throw new CallError('wrong_passphrase', 'The passphrase for this key is wrong');
    }
    if (!parsed.isPrivateKey()) {
      throw new CallError('invalid_key', 'That is a public key; import the private key');
    }
    return this.store(
      label,
      privateKey,
      encrypted && savePassphrase ? passphrase : undefined,
      encrypted,
      parsed,
    );
  }

  list(): KeyInfo[] {
    return this.vault
      .list<StoredKey>('key')
      .map(({ id, value }) => toInfo(id, value))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  has(id: string): boolean {
    return this.vault.get<StoredKey>('key', id) !== null;
  }

  describe(id: string): KeyInfo {
    const stored = this.vault.get<StoredKey>('key', id);
    if (!stored) throw new CallError('not_found', 'That key is no longer in the vault');
    return toInfo(id, stored);
  }

  /** For the SSH client only. */
  material(id: string): PrivateKeyMaterial | null {
    const stored = this.vault.get<StoredKey>('key', id);
    if (!stored) return null;
    return {
      privateKey: stored.privateKey,
      encrypted: stored.encrypted,
      ...(stored.passphrase !== undefined && { passphrase: stored.passphrase }),
    };
  }

  /** Saves a passphrase the user typed at login and asked to remember. */
  async savePassphrase(id: string, passphrase: string): Promise<void> {
    const stored = this.vault.get<StoredKey>('key', id);
    if (!stored?.encrypted) return;
    await this.vault.put('key', id, { ...stored, passphrase });
  }

  async delete(id: string): Promise<void> {
    if (!(await this.vault.delete('key', id))) {
      throw new CallError('not_found', 'That key is no longer in the vault');
    }
  }

  private async store(
    label: string,
    privateKey: string,
    passphrase: string | undefined,
    encrypted: boolean,
    parsed?: ParsedKey,
  ): Promise<KeyInfo> {
    const key = parsed ?? parsePrivateKey(privateKey, passphrase);
    if (key instanceof Error) throw new CallError('invalid_key', 'The key could not be read');
    const publicBlob = key.getPublicSSH();
    const id = `key_${randomBytes(8).toString('hex')}`;
    const stored: StoredKey = {
      label,
      algorithm: key.type,
      publicKey: `${key.type} ${publicBlob.toString('base64')} ${sanitiseComment(label)}`,
      fingerprint: fingerprintOf(publicBlob),
      createdAt: new Date().toISOString(),
      privateKey,
      encrypted,
      ...(passphrase !== undefined && { passphrase }),
    };
    await this.vault.put('key', id, stored);
    return toInfo(id, stored);
  }
}

/** Key comments end up in authorized_keys files; keep them to one safe line. */
export function sanitiseComment(label: string): string {
  return label.replace(/[^\w.@-]+/g, '-').slice(0, 64) || 'quqa';
}

function toInfo(id: string, stored: StoredKey): KeyInfo {
  return {
    id,
    label: stored.label,
    algorithm: stored.algorithm,
    fingerprint: stored.fingerprint,
    publicKey: stored.publicKey,
    createdAt: stored.createdAt,
    encrypted: stored.encrypted,
    passphraseSaved: stored.passphrase !== undefined,
    // Filled in by the engine, which knows the saved hosts.
    usedBy: 0,
  };
}
