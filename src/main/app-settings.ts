/**
 * App settings that are not secret and are needed before the vault opens:
 * the app theme and the update check. Kept in `settings.json` in the profile
 * folder; an unreadable or odd file means the defaults. Kept free of
 * Electron imports so tests can load it.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import Type, { type Static } from 'typebox';
import Value from 'typebox/value';
import { AppTheme } from '../shared/ipc.js';

const StoredSettings = Type.Object(
  {
    theme: AppTheme,
    autoUpdate: Type.Boolean(),
    skippedVersion: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type StoredSettings = Static<typeof StoredSettings>;

export const DEFAULT_SETTINGS: StoredSettings = {
  theme: 'glass',
  autoUpdate: true,
  skippedVersion: null,
};

export function parseSettings(text: string): StoredSettings {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS };
  // Field by field, so one bad value does not reset the others.
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const stored = value as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const candidate = { ...merged, [key]: stored[key] };
    if (Value.Check(StoredSettings, candidate)) merged[key] = stored[key];
  }
  return merged as StoredSettings;
}

export class SettingsFile {
  private value: StoredSettings;

  constructor(private readonly path: string) {
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // First start: the defaults.
    }
    this.value = parseSettings(text);
  }

  get(): StoredSettings {
    return { ...this.value };
  }

  update(change: Partial<StoredSettings>): StoredSettings {
    const next = { ...this.value, ...change };
    if (!Value.Check(StoredSettings, next)) return this.get();
    this.value = next;
    try {
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
    } catch {
      // Kept for this run; the next start uses the defaults again.
    }
    return this.get();
  }
}
