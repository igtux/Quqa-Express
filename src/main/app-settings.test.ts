import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SettingsFile, parseSettings } from './app-settings.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('app settings', () => {
  it('defaults to the glass theme with the update check on', () => {
    expect(parseSettings('')).toEqual({
      theme: 'glass',
      autoUpdate: true,
      skippedVersion: null,
      localShell: null,
    });
  });

  it('keeps good fields of a partly bad file and drops unknown ones', () => {
    expect(
      parseSettings('{"theme":"classic","autoUpdate":"yes","extra":1,"skippedVersion":"0.2.0"}'),
    ).toEqual({ theme: 'classic', autoUpdate: true, skippedVersion: '0.2.0', localShell: null });
    expect(parseSettings('{"theme":"neon"}')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('[1]')).toEqual(DEFAULT_SETTINGS);
  });

  it('writes changes and reads them back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quqa-settings-'));
    dirs.push(dir);
    const path = join(dir, 'settings.json');
    const file = new SettingsFile(path);
    expect(file.get().theme).toBe('glass');
    file.update({ theme: 'classic', autoUpdate: false });
    expect(new SettingsFile(path).get()).toMatchObject({ theme: 'classic', autoUpdate: false });
    // Invalid changes are refused.
    file.update({ theme: 'neon' as never });
    expect(JSON.parse(readFileSync(path, 'utf8')).theme).toBe('classic');
    // The default local shell: a shell id or null, nothing else.
    file.update({ localShell: 'pwsh' });
    expect(new SettingsFile(path).get().localShell).toBe('pwsh');
    file.update({ localShell: 'C:\\evil.exe' as never });
    expect(new SettingsFile(path).get().localShell).toBe('pwsh');
    writeFileSync(path, 'not json');
    expect(new SettingsFile(path).get()).toEqual(DEFAULT_SETTINGS);
  });
});
