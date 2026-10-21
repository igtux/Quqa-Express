/**
 * Accepted host keys (pins), kept in the vault. A host is trusted when the
 * presented key matches one of its pins, from the trust prompt or imported
 * from known_hosts (plain or hashed entries); unknown when it has none; and
 * a mismatch, which blocks the connection, when it has pins but none match.
 */
import { describeHostKey, fingerprintOf, matchesPin, type PinnedHostKey } from './host-keys.js';
import { hashedMatches, type HashedEntry, type ParsedKnownHosts } from './known-hosts-file.js';

export type HostKeyVerdict = 'trusted' | 'unknown' | 'mismatch';

export function hostId(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}

export interface StoredPin extends PinnedHostKey {
  host: string;
  port: number;
  source: 'trusted' | 'known_hosts';
  addedAt: string;
}

export interface StoredHashedPin extends HashedEntry {
  addedAt: string;
}

/** What is saved in the vault item `known-hosts/pins`. */
export interface KnownHostsData {
  pins: StoredPin[];
  hashed: StoredHashedPin[];
}

export class KnownHosts {
  private pins: StoredPin[] = [];
  private hashed: StoredHashedPin[] = [];

  /** `save` is called after every change (the engine writes the vault). */
  constructor(private readonly save: (data: KnownHostsData) => Promise<void> = async () => {}) {}

  load(data: KnownHostsData | null): void {
    this.pins = data?.pins ?? [];
    this.hashed = data?.hashed ?? [];
  }

  /** Forgets everything in memory (the vault was locked). */
  clear(): void {
    this.pins = [];
    this.hashed = [];
  }

  data(): KnownHostsData {
    return { pins: this.pins, hashed: this.hashed };
  }

  pinsFor(host: string, port: number): PinnedHostKey[] {
    const id = hostId(host, port);
    const own = this.pins.filter((pin) => hostId(pin.host, pin.port) === id);
    const pins: PinnedHostKey[] = own.map(({ algorithm, key }) => ({ algorithm, key }));
    // Hashed imports cannot be matched to a host at import time; they never
    // widen a host the user trusted in the app.
    if (own.some((pin) => pin.source === 'trusted')) return pins;
    for (const entry of this.hashed) {
      if (hashedMatches(entry, host, port)) pins.push(entry.key);
    }
    return pins;
  }

  check(host: string, port: number, presented: Buffer): HostKeyVerdict {
    const pins = this.pinsFor(host, port);
    if (pins.length === 0) return 'unknown';
    return matchesPin(presented, pins) ? 'trusted' : 'mismatch';
  }

  /** Fingerprints of the current pins (for the "host key changed" screen). */
  previous(host: string, port: number): { algorithm: string; fingerprint: string }[] {
    return this.pinsFor(host, port).map((pin) => ({
      algorithm: pin.algorithm,
      fingerprint: fingerprintOf(Buffer.from(pin.key, 'base64')),
    }));
  }

  /** Records a key the user accepted. Never replaces a different existing pin. */
  async accept(host: string, port: number, key: PinnedHostKey): Promise<void> {
    if (this.pinsFor(host, port).some((pin) => pin.key === key.key)) return;
    this.pins.push(stored(host, port, key, 'trusted'));
    await this.save(this.data());
  }

  /** The user confirmed a changed key: drop every pin for the host, then pin the new key. */
  async replace(host: string, port: number, key: PinnedHostKey): Promise<void> {
    this.drop(host, port);
    this.pins.push(stored(host, port, key, 'trusted'));
    await this.save(this.data());
  }

  async forget(host: string, port: number): Promise<void> {
    this.drop(host, port);
    await this.save(this.data());
  }

  /**
   * Adds known_hosts entries. An import never weakens a pin the user made:
   * a host already trusted with another key keeps only that key.
   */
  async import(parsed: ParsedKnownHosts): Promise<{ imported: number; hashed: number }> {
    let imported = 0;
    let hashed = 0;
    for (const entry of parsed.plain) {
      const existing = this.pinsFor(entry.host, entry.port);
      if (existing.some((pin) => pin.key === entry.key.key)) continue;
      // (Several key types per host in known_hosts are fine: they are all imported.)
      if (existing.length > 0 && !this.importedOnly(entry.host, entry.port)) continue;
      this.pins.push(stored(entry.host, entry.port, entry.key, 'known_hosts'));
      imported++;
    }
    const now = new Date().toISOString();
    for (const entry of parsed.hashed) {
      if (this.hashed.some((h) => h.hash === entry.hash && h.key.key === entry.key.key)) continue;
      this.hashed.push({ ...entry, addedAt: now });
      hashed++;
    }
    if (imported + hashed > 0) await this.save(this.data());
    return { imported, hashed };
  }

  list(): { pins: StoredPin[]; hashed: number } {
    return { pins: [...this.pins], hashed: this.hashed.length };
  }

  private importedOnly(host: string, port: number) {
    const id = hostId(host, port);
    return this.pins
      .filter((pin) => hostId(pin.host, pin.port) === id)
      .every((pin) => pin.source === 'known_hosts');
  }

  private drop(host: string, port: number) {
    const id = hostId(host, port);
    this.pins = this.pins.filter((pin) => hostId(pin.host, pin.port) !== id);
    this.hashed = this.hashed.filter((entry) => !hashedMatches(entry, host, port));
  }
}

function stored(
  host: string,
  port: number,
  key: PinnedHostKey,
  source: StoredPin['source'],
): StoredPin {
  // Only the algorithm and blob are pinned, whatever else the caller passed.
  const { algorithm, key: blob } = describeHostKey(Buffer.from(key.key, 'base64'));
  return {
    host: host.toLowerCase(),
    port,
    algorithm,
    key: blob,
    source,
    addedAt: new Date().toISOString(),
  };
}
