/**
 * Saved hosts, sealed in the vault as `host/<id>` items, and the app's UI
 * state (`settings/ui`). Hosts hold no secrets: a host names a vault key by
 * id or uses password login (the password, if saved, is a separate item).
 *
 * Fields follow Jarvis NG's host form (apps/web/src/machines/HostForms.tsx),
 * same owner, plus what a single-user desktop needs: groups, tags, notes,
 * colour, the tmux switch, per-host look and the jump-host placeholder.
 */
import { randomBytes } from 'node:crypto';
import Value from 'typebox/value';
import {
  HostInfo,
  MAX_HOSTS,
  UiState,
  type HostInput,
  type HostInfo as HostInfoType,
  type UiState as UiStateType,
} from '../shared/ipc.js';
import { CallError } from './errors.js';
import type { Vault } from './vault/vault.js';

export const DEFAULT_UI: UiStateType = {
  scheme: 'default',
  font: 'system',
  zoom: 0,
  notifications: true,
  sound: false,
  restoreTabs: true,
  groupDock: true,
  favorites: [],
  aliases: [],
  forgotten: [],
  layout: { tabs: [], active: -1 },
};

export class HostStore {
  constructor(
    private readonly vault: Vault,
    /** True when a vault key with this id exists. */
    private readonly keyExists: (keyId: string) => boolean,
  ) {}

  list(): HostInfoType[] {
    return this.vault
      .list<HostInfoType>('host')
      .map(({ id, value }) => ({ ...value, id }))
      .filter((host) => Value.Check(HostInfo, host))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  get(id: string): HostInfoType | null {
    const host = this.vault.get<HostInfoType>('host', id);
    if (!host) return null;
    const value = { ...host, id };
    return Value.Check(HostInfo, value) ? value : null;
  }

  require(id: string): HostInfoType {
    const host = this.get(id);
    if (!host) throw new CallError('not_found', 'That host is no longer saved');
    return host;
  }

  async save(id: string | undefined, input: HostInput): Promise<HostInfoType> {
    const host = normalise(input);
    if (host.auth.kind === 'key' && !this.keyExists(host.auth.keyId)) {
      throw new CallError('not_found', 'The chosen key is no longer in the vault');
    }
    if (host.jumpHostId !== null && host.jumpHostId === id) {
      throw new CallError('invalid_request', 'A host cannot jump through itself');
    }
    if (host.jumpHostId !== null && !this.get(host.jumpHostId)) {
      throw new CallError('not_found', 'The jump host is no longer saved');
    }
    let saved: HostInfoType;
    if (id === undefined) {
      if (this.vault.list('host').length >= MAX_HOSTS) {
        throw new CallError('invalid_request', `At most ${MAX_HOSTS} hosts can be saved`);
      }
      saved = {
        ...host,
        id: `h_${randomBytes(8).toString('hex')}`,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        connectCount: 0,
      };
    } else {
      const existing = this.require(id);
      saved = {
        ...host,
        id,
        createdAt: existing.createdAt,
        lastUsedAt: existing.lastUsedAt,
        connectCount: existing.connectCount,
      };
    }
    await this.vault.put('host', saved.id, withoutId(saved));
    return saved;
  }

  async delete(id: string): Promise<HostInfoType> {
    const host = this.require(id);
    await this.vault.delete('host', id);
    // Hosts that jumped through it keep their own settings, without the jump.
    for (const other of this.list()) {
      if (other.jumpHostId === id) {
        await this.vault.put('host', other.id, withoutId({ ...other, jumpHostId: null }));
      }
    }
    return host;
  }

  /** A terminal to the host opened: count it and remember when. */
  async touch(id: string): Promise<void> {
    const host = this.get(id);
    if (!host) return;
    await this.vault.put(
      'host',
      id,
      withoutId({
        ...host,
        lastUsedAt: new Date().toISOString(),
        connectCount: Math.min(host.connectCount + 1, 1_000_000_000),
      }),
    );
  }

  /** Hosts using each key, for "used by N hosts". */
  keyUsage(): Map<string, number> {
    const usage = new Map<string, number>();
    for (const host of this.list()) {
      if (host.auth.kind === 'key') {
        usage.set(host.auth.keyId, (usage.get(host.auth.keyId) ?? 0) + 1);
      }
    }
    return usage;
  }

  ui(): UiStateType {
    const stored = this.vault.get<unknown>('settings', 'ui');
    if (stored === null || typeof stored !== 'object') return DEFAULT_UI;
    // Fields added later keep their defaults; anything invalid falls back as a whole.
    const merged = { ...DEFAULT_UI, ...(stored as object) };
    return Value.Check(UiState, merged) ? merged : DEFAULT_UI;
  }

  async saveUi(state: UiStateType): Promise<void> {
    await this.vault.put('settings', 'ui', state);
  }
}

function normalise(input: HostInput): HostInput {
  const tags = [...new Set(input.tags.map((tag) => tag.toLowerCase()))].sort();
  return {
    ...input,
    name: input.name.trim() || input.address,
    group: input.group.trim(),
    tags,
    notes: input.notes.replace(/\r\n/g, '\n'),
    address: input.address.replace(/^\[(.*)\]$/, '$1'),
  };
}

function withoutId(host: HostInfoType): Omit<HostInfoType, 'id'> {
  const { id: _id, ...rest } = host;
  return rest;
}
