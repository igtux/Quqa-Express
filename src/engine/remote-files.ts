/**
 * File operations on a remote host over one SFTP channel. Every path is
 * normalised and, after resolving symlinks, must lie under one of the host's
 * file roots (none: anywhere).
 *
 * Ported from Jarvis NG (apps/ssh-gateway/src/files/remote-files.ts), same
 * owner: resolve-then-check, folders first, posix-rename for overwrites,
 * bounded recursive delete. The connection pool is replaced by the session's
 * own SFTP channel; resumable transfers live in transfers.ts.
 */
import { posix } from 'node:path';
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import type { FileEntry } from '../shared/ipc.js';
import { CallError } from './errors.js';
import {
  assertValidName,
  assertWithinRoots,
  effectiveRoots,
  normaliseAbsolutePath,
} from './remote-paths.js';

const MAX_LISTED_ENTRIES = 10_000;
const MAX_RECURSIVE_DELETE = 10_000;
const MAX_MKDIR_DEPTH = 32;

export class RemoteFiles {
  constructor(
    readonly sftp: SFTPWrapper,
    readonly roots: readonly string[],
  ) {}

  /** The login's home folder (SFTP starts there). */
  async home(): Promise<string> {
    return sftpCall<string>((done) => this.sftp.realpath('.', done)).catch((error: unknown) => {
      throw translate(error);
    });
  }

  /** Expands `~` and `~/…` against the home folder. */
  async expand(path: string): Promise<string> {
    if (path === '~') return this.home();
    if (path.startsWith('~/')) return posix.join(await this.home(), path.slice(2));
    return path;
  }

  /** Where browsing starts: the home folder when allowed, else the first root. */
  async start(): Promise<string> {
    const home = await this.home();
    try {
      assertWithinRoots(normaliseAbsolutePath(home), this.roots);
      return home;
    } catch {
      return effectiveRoots(this.roots)[0] ?? '/';
    }
  }

  async list(path: string): Promise<{ path: string; entries: FileEntry[] }> {
    const directory = await this.resolveExisting(path);
    const listing = await sftpCall<FileEntryWithStats[]>((done) =>
      this.sftp.readdir(directory, done),
    ).catch((error: unknown) => {
      throw translate(error);
    });
    if (listing.length > MAX_LISTED_ENTRIES) {
      throw new CallError('io', 'This folder has too many entries to list');
    }
    const entries = listing
      .map((item) => toEntry(item.filename, posix.join(directory, item.filename), item.attrs))
      .sort(byTypeThenName);
    return { path: directory, entries };
  }

  async stat(path: string): Promise<FileEntry> {
    const resolved = await this.resolveExisting(path);
    const stats = await this.statOf(resolved);
    return toEntry(posix.basename(resolved) || '/', resolved, stats);
  }

  async mkdir(parent: string, name: string): Promise<FileEntry> {
    const path = await this.resolveNew(parent, name);
    await sftpCall((done) => this.sftp.mkdir(path, done)).catch((error: unknown) => {
      throw translate(error, `"${name}" already exists`);
    });
    return toEntry(name, path, await this.statOf(path));
  }

  /** `mkdir -p` for the upload folder; every step stays under the roots. */
  async ensureDirectory(path: string): Promise<string> {
    const target = normaliseAbsolutePath(await this.expand(path));
    const parts = target.split('/').filter(Boolean);
    if (parts.length > MAX_MKDIR_DEPTH) throw new CallError('invalid_request', 'Path too deep');
    let current = '/';
    for (const part of parts) {
      const next = posix.join(current, part);
      const stats = await this.lstatOrNull(next);
      if (!stats) {
        assertWithinRoots(next, this.roots);
        await sftpCall((done) => this.sftp.mkdir(next, { mode: 0o700 }, done)).catch(
          (error: unknown) => {
            throw translate(error);
          },
        );
      }
      current = next;
    }
    return this.resolveExisting(current);
  }

  /** Renames or moves within the roots. Refuses to replace unless `overwrite`. */
  async rename(from: string, toParent: string, toName: string, overwrite: boolean) {
    const source = await this.resolveExisting(from, { followFinalSymlink: false });
    const destination = await this.resolveNew(toParent, toName);
    if (destination === source) return { path: destination };
    if (destination.startsWith(`${source}/`)) {
      throw new CallError('invalid_request', 'A folder cannot be moved into itself');
    }
    await this.moveInto(source, destination, overwrite);
    return { path: destination };
  }

  /** Deletes a file, symlink or (when `recursive`) a folder tree. */
  async delete(path: string, recursive: boolean): Promise<{ deleted: number }> {
    const resolved = await this.resolveExisting(path, { followFinalSymlink: false });
    if (resolved === '/' || effectiveRoots(this.roots).includes(resolved)) {
      throw new CallError('permission_denied', 'A root folder cannot be deleted');
    }
    const stats = await sftpCall<Stats>((done) => this.sftp.lstat(resolved, done)).catch(
      (error: unknown) => {
        throw translate(error);
      },
    );
    try {
      if (stats.isDirectory()) {
        if (!recursive) {
          const entries = await sftpCall<FileEntryWithStats[]>((done) =>
            this.sftp.readdir(resolved, done),
          );
          if (entries.length > 0) throw new CallError('exists', 'The folder is not empty');
          await sftpCall((done) => this.sftp.rmdir(resolved, done));
          return { deleted: 1 };
        }
        return {
          deleted: await this.deleteTree(resolved, { remaining: MAX_RECURSIVE_DELETE }),
        };
      }
      await sftpCall((done) => this.sftp.unlink(resolved, done));
      return { deleted: 1 };
    } catch (error) {
      throw translate(error);
    }
  }

  /* ----- Path resolution ------------------------------------------------- */

  /** Resolves an existing path (following symlinks unless told not to) and checks the roots. */
  async resolveExisting(
    path: string,
    options: { followFinalSymlink?: boolean } = {},
  ): Promise<string> {
    const normalised = normaliseAbsolutePath(path);
    let resolved: string;
    try {
      if (options.followFinalSymlink === false && normalised !== '/') {
        // Resolve the parent and keep the final component itself, so a
        // symlink is renamed or deleted, never its target.
        const parent = await sftpCall<string>((done) =>
          this.sftp.realpath(posix.dirname(normalised), done),
        );
        resolved = posix.join(parent, posix.basename(normalised));
        await sftpCall<Stats>((done) => this.sftp.lstat(resolved, done));
      } else {
        resolved = await sftpCall<string>((done) => this.sftp.realpath(normalised, done));
        await sftpCall<Stats>((done) => this.sftp.stat(resolved, done));
      }
    } catch (error) {
      throw translate(error);
    }
    assertWithinRoots(normaliseAbsolutePath(resolved), this.roots);
    return resolved;
  }

  /** A path for something about to be created: real parent folder + validated name. */
  async resolveNew(parent: string, name: string): Promise<string> {
    assertValidName(name);
    const directory = await this.resolveExisting(parent);
    const stats = await this.statOf(directory);
    if (!stats.isDirectory()) throw new CallError('invalid_request', 'That is not a folder');
    return posix.join(directory, name);
  }

  async moveInto(from: string, to: string, overwrite: boolean): Promise<void> {
    const exists = (await this.lstatOrNull(to)) !== null;
    if (exists && !overwrite) {
      throw new CallError('exists', `"${posix.basename(to)}" already exists`);
    }
    try {
      if (exists) {
        // OpenSSH's posix-rename replaces atomically; plain SFTP rename refuses.
        await sftpCall((done) => this.sftp.ext_openssh_rename(from, to, done));
      } else {
        await sftpCall((done) => this.sftp.rename(from, to, done));
      }
    } catch (error) {
      throw translate(error);
    }
  }

  async lstatOrNull(path: string): Promise<Stats | null> {
    try {
      return await sftpCall<Stats>((done) => this.sftp.lstat(path, done));
    } catch (error) {
      if (sftpCode(error) === NO_SUCH_FILE) return null;
      throw translate(error);
    }
  }

  async sizeOrZero(path: string): Promise<number> {
    return (await this.lstatOrNull(path))?.size ?? 0;
  }

  private async statOf(path: string): Promise<Stats> {
    return sftpCall<Stats>((done) => this.sftp.stat(path, done)).catch((error: unknown) => {
      throw translate(error);
    });
  }

  private async deleteTree(path: string, budget: { remaining: number }): Promise<number> {
    let deleted = 0;
    const entries = await sftpCall<FileEntryWithStats[]>((done) => this.sftp.readdir(path, done));
    for (const entry of entries) {
      if (--budget.remaining < 0) {
        throw new CallError('io', 'Too many files to delete at once');
      }
      const child = posix.join(path, entry.filename);
      if (entry.attrs.isDirectory()) {
        deleted += await this.deleteTree(child, budget);
      } else {
        await sftpCall((done) => this.sftp.unlink(child, done));
        deleted++;
      }
    }
    await sftpCall((done) => this.sftp.rmdir(path, done));
    return deleted + 1;
  }
}

/* ----- Helpers -------------------------------------------------------------- */

export const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const FAILURE = 4;

/** Promisifies an ssh2 SFTP callback. */
export function sftpCall<T = void>(
  invoke: (done: (error: Error | null | undefined, value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      invoke((error, value) => (error ? reject(error) : resolve(value)));
    } catch (error) {
      reject(error as Error);
    }
  });
}

export function sftpCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code: unknown }).code === undefined
      ? undefined
      : Number((error as { code: unknown }).code)
    : undefined;
}

/** Maps an SFTP failure to a message safe to show (never the server's raw text). */
export function translate(error: unknown, exists?: string): Error {
  if (error instanceof CallError) return error;
  switch (sftpCode(error)) {
    case NO_SUCH_FILE:
      return new CallError('not_found', 'No such file or folder');
    case PERMISSION_DENIED:
      return new CallError('permission_denied', 'The remote account is not allowed to do that');
    case FAILURE:
      // OpenSSH answers a mkdir onto an existing name with a plain failure.
      return exists
        ? new CallError('exists', exists)
        : new CallError('io', 'The remote file operation failed');
    default:
      return new CallError('io', 'The remote file operation failed');
  }
}

export function toEntry(name: string, path: string, stats: Stats): FileEntry {
  return {
    name,
    path,
    type: stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : stats.isSymbolicLink()
          ? 'symlink'
          : 'other',
    size: Math.max(0, stats.size),
    modifiedAt: new Date(Number.isFinite(stats.mtime) ? stats.mtime * 1000 : 0).toISOString(),
    mode: stats.mode & 0o7777,
  };
}

function byTypeThenName(a: FileEntry, b: FileEntry): number {
  if ((a.type === 'directory') !== (b.type === 'directory')) return a.type === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name);
}
