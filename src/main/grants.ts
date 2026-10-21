/**
 * Upload grants: local files the user chose in an open dialog or dropped on
 * the window, each behind a random token. The renderer uploads by token, so
 * it can never name a local path of its own choosing; main checks every file
 * when it is granted (absolute, exists, a regular file) and the engine reads
 * it only when the upload starts.
 */
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { UploadGrant } from '../shared/ipc.js';

const GRANT_TTL_MS = 30 * 60_000;
const MAX_GRANTS = 500;
const MAX_PATH = 4096;

interface Grant {
  path: string;
  name: string;
  size: number;
  expires: number;
}

/** A local file name as the remote side should see it: printable, one component. */
export function remoteNameOf(path: string): string {
  const name = basename(path.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255);
  return name === '' || name === '.' || name === '..' ? 'file' : name;
}

export class Grants {
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Grants each path that is an existing regular file; others are skipped. */
  async grant(paths: readonly string[]): Promise<UploadGrant[]> {
    this.prune();
    const granted: UploadGrant[] = [];
    for (const path of paths) {
      if (typeof path !== 'string' || path.length > MAX_PATH || !isAbsolute(path)) continue;
      if (path.includes('\0')) continue;
      let size: number;
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        size = info.size;
      } catch {
        continue;
      }
      const token = `g${randomBytes(12).toString('hex')}`;
      const name = remoteNameOf(path);
      this.grants.set(token, { path, name, size, expires: this.now() + GRANT_TTL_MS });
      granted.push({ token, name, size });
    }
    while (this.grants.size > MAX_GRANTS) {
      const oldest = this.grants.keys().next().value;
      if (oldest === undefined) break;
      this.grants.delete(oldest);
    }
    return granted;
  }

  /** The files behind the tokens; null if any is unknown or expired. */
  resolve(tokens: readonly string[]): { path: string; name: string }[] | null {
    this.prune();
    const files: { path: string; name: string }[] = [];
    for (const token of tokens) {
      const grant = this.grants.get(token);
      if (!grant) return null;
      files.push({ path: grant.path, name: grant.name });
    }
    return files;
  }

  private prune() {
    const now = this.now();
    for (const [token, grant] of this.grants) {
      if (grant.expires < now) this.grants.delete(token);
    }
  }
}
