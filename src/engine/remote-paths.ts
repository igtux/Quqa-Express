/**
 * Remote path rules: absolute, normalised, and (after symlinks are resolved
 * by the caller) under one of the host's file roots.
 *
 * Ported from Jarvis NG (apps/ssh-gateway/src/files/remote-paths.ts), same
 * owner. Errors are CallErrors so they reach the user as they are.
 */
import { posix } from 'node:path';
import { CallError } from './errors.js';

const MAX_PATH_LENGTH = 4096;
const MAX_NAME_LENGTH = 255;

/** Absolute, normalised, no NUL bytes, no trailing slash (except "/"). */
export function normaliseAbsolutePath(path: string): string {
  if (!path.startsWith('/') || path.includes('\0') || path.length > MAX_PATH_LENGTH) {
    throw new CallError('invalid_request', 'Paths must be absolute');
  }
  const normalised = posix.normalize(path);
  return normalised.length > 1 && normalised.endsWith('/') ? normalised.slice(0, -1) : normalised;
}

/** A single directory entry name: no separators, not "." or "..". */
export function assertValidName(name: string): void {
  if (
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0')
  ) {
    throw new CallError('invalid_request', `Invalid file name "${name.slice(0, 40)}"`);
  }
}

/** The roots a host's files are kept under; no roots means the whole disk. */
export function effectiveRoots(roots: readonly string[]): string[] {
  return roots.length === 0 ? ['/'] : roots.map(normaliseAbsolutePath);
}

/** `path` is normalised first, so `..` cannot climb out of a root. */
export function isWithinRoots(path: string, roots: readonly string[]): boolean {
  path = normaliseAbsolutePath(path);
  return effectiveRoots(roots).some(
    (base) => base === '/' || path === base || path.startsWith(`${base}/`),
  );
}

export function assertWithinRoots(path: string, roots: readonly string[]): void {
  if (!isWithinRoots(path, roots)) {
    throw new CallError(
      'permission_denied',
      'That location is outside the folders allowed for this host',
    );
  }
}
