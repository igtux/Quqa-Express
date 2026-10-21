import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupName, moveVaultAside } from './reset.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'quqa-reset-'));
  dirs.push(dir);
  return dir;
}

describe('moving the vault aside', () => {
  it('moves the vault, its backup and write leftovers, and nothing else', async () => {
    const dir = folder();
    for (const name of [
      'vault.json',
      'vault.json.bak',
      'vault.json.0123456789ab.tmp',
      'window-state.json',
      'settings.json',
      'vault.json.evil',
    ]) {
      writeFileSync(join(dir, name), name);
    }
    const now = new Date('2026-10-21T08:35:05.123Z');
    const target = await moveVaultAside(join(dir, 'vault.json'), now);
    expect(target).toBe(join(dir, 'vault-backups', '2026-10-21T08-35-05Z'));
    expect(readdirSync(target as string).sort()).toEqual([
      'vault.json',
      'vault.json.0123456789ab.tmp',
      'vault.json.bak',
    ]);
    expect(readFileSync(join(target as string, 'vault.json'), 'utf8')).toBe('vault.json');
    expect(readdirSync(dir).sort()).toEqual([
      'settings.json',
      'vault-backups',
      'vault.json.evil',
      'window-state.json',
    ]);
  });

  it('keeps earlier backups and reports when there is nothing to move', async () => {
    const dir = folder();
    const now = new Date('2026-10-21T08:35:05Z');
    writeFileSync(join(dir, 'vault.json'), 'first');
    const first = await moveVaultAside(join(dir, 'vault.json'), now);
    writeFileSync(join(dir, 'vault.json.bak'), 'second');
    const second = await moveVaultAside(join(dir, 'vault.json'), now);
    expect(second).not.toBe(first);
    expect(readFileSync(join(first as string, 'vault.json'), 'utf8')).toBe('first');
    expect(readFileSync(join(second as string, 'vault.json.bak'), 'utf8')).toBe('second');
    expect(await moveVaultAside(join(dir, 'vault.json'), now)).toBeNull();
  });

  it('names folders without characters Windows forbids', () => {
    expect(backupName(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03-04-05Z');
  });
});
