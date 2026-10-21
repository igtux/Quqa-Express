/**
 * Accepted host keys. Phase 1 keeps them in memory for the life of the app;
 * a later phase persists them (an encrypted local store).
 */
import { matchesPin, type PinnedHostKey } from './host-keys.js';

export type HostKeyVerdict = 'trusted' | 'unknown' | 'mismatch';

export function hostId(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}

export class KnownHosts {
  private readonly pins = new Map<string, PinnedHostKey[]>();

  pinsFor(host: string, port: number): readonly PinnedHostKey[] {
    return this.pins.get(hostId(host, port)) ?? [];
  }

  check(host: string, port: number, presented: Buffer): HostKeyVerdict {
    const pins = this.pinsFor(host, port);
    if (pins.length === 0) return 'unknown';
    return matchesPin(presented, pins) ? 'trusted' : 'mismatch';
  }

  /** Records a key the user accepted. Never replaces a different existing pin. */
  accept(host: string, port: number, key: PinnedHostKey): void {
    const id = hostId(host, port);
    const pins = this.pins.get(id) ?? [];
    if (!pins.some((pin) => pin.key === key.key)) pins.push(key);
    this.pins.set(id, pins);
  }

  forget(host: string, port: number): void {
    this.pins.delete(hostId(host, port));
  }
}
