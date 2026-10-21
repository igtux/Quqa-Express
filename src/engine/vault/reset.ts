/**
 * "Forgot password? Start over": the vault file and its backup are moved,
 * never deleted, into `<folder>/vault-backups/<timestamp>/` next to the vault,
 * so a remembered password can still open them later. Only the vault's own
 * files move (vault.json, vault.json.bak and leftovers of an interrupted
 * write); nothing outside the app data folder is touched.
 */
import { mkdir, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const BACKUP_FOLDER = 'vault-backups';

/** `2026-10-21T08-35-05Z`: sortable and valid on every file system. */
export function backupName(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll(':', '-');
}

/**
 * Moves the vault's files aside. Returns the folder they went to, or null
 * when there was nothing to move.
 */
export async function moveVaultAside(path: string, now = new Date()): Promise<string | null> {
  const folder = dirname(path);
  const name = basename(path);
  const own = (entry: string) =>
    entry === name ||
    entry === `${name}.bak` ||
    entry === `${name}.bak.tmp` ||
    (entry.startsWith(`${name}.`) && /^[0-9a-f]{12}\.tmp$/.test(entry.slice(name.length + 1)));
  const files = (await readdir(folder).catch(() => [] as string[])).filter(own).sort();
  if (files.length === 0) return null;
  let target = join(folder, BACKUP_FOLDER, backupName(now));
  // Two resets within a second get their own folders.
  for (let n = 2; ; n += 1) {
    try {
      await mkdir(target, { recursive: false, mode: 0o700 });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        continue;
      }
      if (code !== 'EEXIST' || n > 50) throw error;
      target = join(folder, BACKUP_FOLDER, `${backupName(now)}-${n}`);
    }
  }
  for (const file of files) await rename(join(folder, file), join(target, file));
  return target;
}
