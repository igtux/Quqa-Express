/**
 * Programs shipped inside the packaged app live in `app.asar.unpacked`
 * (electron-builder `asarUnpack`), but modules still name them by their
 * `app.asar` path. Only `execFile` follows that redirect in Electron.
 */
import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';

const IN_ASAR = /([\\/])app\.asar([\\/])/;

/** The unpacked copy of `file` when it is inside app.asar and that copy exists; else `file`. */
export function unpackedPath(file: string, exists: (path: string) => boolean = existsSync): string {
  if (typeof file !== 'string' || !IN_ASAR.test(file)) return file;
  const unpacked = file.replace(IN_ASAR, '$1app.asar.unpacked$2');
  return exists(unpacked) ? unpacked : file;
}

/** Makes `child_process.spawn` start the unpacked copy; call before loading ssh2. */
export function spawnFromUnpacked(): void {
  const original = childProcess.spawn;
  const patched = (command: string, ...rest: unknown[]) =>
    (original as (...args: unknown[]) => childProcess.ChildProcess)(unpackedPath(command), ...rest);
  childProcess.spawn = patched as typeof childProcess.spawn;
}
