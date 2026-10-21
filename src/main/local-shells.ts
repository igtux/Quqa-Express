/**
 * The shells a local terminal can run (ADR 0007), found by main and never
 * named by the renderer. On Windows: PowerShell 7 (`pwsh.exe` on PATH or in
 * Program Files), Windows PowerShell 5.1, Command Prompt, and WSL when it is
 * installed with at least one distribution. Elsewhere: the user's login
 * shell, for development and tests.
 *
 * Kept free of Electron imports; detection sees the computer only through
 * `ShellEnvironment`, so tests can describe any computer.
 */
import { execFile } from 'node:child_process';
import { lstatSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { posix, win32 } from 'node:path';
import type { ShellId } from '../shared/ipc.js';

export interface ShellSpec {
  id: ShellId;
  /** Shown in the UI. */
  name: string;
  /** Absolute path of the program. */
  file: string;
}

export interface ShellEnvironment {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** True if a regular file (or an app execution alias) exists at the path. */
  exists(path: string): boolean;
  /** WSL distributions installed for the user (`wsl.exe --list --quiet`); [] when none or no WSL. */
  wslDistros(wsl: string): Promise<string[]>;
  /** The account's shell from the password database (POSIX). */
  accountShell(): string | null;
}

/** An environment variable, matched without case on Windows (`Path`, `PATH`). */
export function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find(
    (k) => k.toLowerCase() === name.toLowerCase() && env[k] !== undefined,
  );
  return key === undefined ? undefined : env[key];
}

/** The first `program` in the PATH folders (absolute folders only). */
function onPath(
  program: string,
  pathValue: string | undefined,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string | null {
  if (!pathValue) return null;
  const path = platform === 'win32' ? win32 : posix;
  for (const raw of pathValue.split(platform === 'win32' ? ';' : ':')) {
    const folder = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!folder || !path.isAbsolute(folder)) continue;
    const candidate = path.join(folder, program);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Detects the shells; the first is the default unless the user chose another. */
export async function detectShells(system: ShellEnvironment): Promise<ShellSpec[]> {
  const { platform, exists } = system;
  const env = (name: string) => envValue(system.env, name, platform);
  if (platform !== 'win32') {
    const candidates = [env('SHELL'), system.accountShell(), '/bin/bash', '/bin/zsh', '/bin/sh'];
    const file = candidates.find(
      (c): c is string => typeof c === 'string' && posix.isAbsolute(c) && exists(c),
    );
    if (!file) return [];
    return [{ id: 'login', name: posix.basename(file), file }];
  }

  const shells: ShellSpec[] = [];
  const pathValue = env('PATH');
  const systemRoot = env('SystemRoot') ?? env('windir') ?? 'C:\\Windows';
  const system32 = win32.join(systemRoot, 'System32');
  const programFiles = [env('ProgramFiles'), env('ProgramW6432'), 'C:\\Program Files'].filter(
    (p): p is string => typeof p === 'string' && win32.isAbsolute(p),
  );

  const pwsh =
    onPath('pwsh.exe', pathValue, platform, exists) ??
    [...new Set(programFiles)]
      .flatMap((root) => [
        win32.join(root, 'PowerShell', '7', 'pwsh.exe'),
        win32.join(root, 'PowerShell', '7-preview', 'pwsh.exe'),
      ])
      .find(exists) ??
    null;
  if (pwsh) shells.push({ id: 'pwsh', name: 'PowerShell 7', file: pwsh });

  const powershell = [win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')].find(
    exists,
  );
  const powershellFile = powershell ?? onPath('powershell.exe', pathValue, platform, exists);
  if (powershellFile) {
    shells.push({ id: 'powershell', name: 'Windows PowerShell', file: powershellFile });
  }

  const comSpec = env('ComSpec');
  const cmd = [comSpec, win32.join(system32, 'cmd.exe')].find(
    (p): p is string =>
      typeof p === 'string' &&
      win32.isAbsolute(p) &&
      win32.basename(p).toLowerCase() === 'cmd.exe' &&
      exists(p),
  );
  if (cmd) shells.push({ id: 'cmd', name: 'Command Prompt', file: cmd });

  const wsl = win32.join(system32, 'wsl.exe');
  if (exists(wsl)) {
    const distros = await system.wslDistros(wsl).catch(() => []);
    if (distros.length > 0) shells.push({ id: 'wsl', name: 'WSL', file: wsl });
  }
  return shells;
}

/** `wsl.exe --list --quiet` prints UTF-16LE (often with a BOM and NULs); one name per line. */
export function parseWslList(output: Buffer): string[] {
  const looksUtf16 = output.length >= 2 && (output[1] === 0 || output[0] === 0xff);
  const text = looksUtf16 ? output.toString('utf16le') : output.toString('utf8');
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.replaceAll('\0', '').trim())
    .filter(
      (line) => line.length > 0 && !/^(Windows Subsystem for Linux|There are no)/i.test(line),
    );
}

/**
 * PowerShell's console in UTF-8, both ways, so Georgian (and everything else
 * that is not in the OEM code page) reaches native programs and comes back.
 */
export const POWERSHELL_UTF8 =
  '$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false';

/** The arguments a shell starts with (fixed per shell; nothing from the renderer). */
export function shellArgs(
  shell: ShellSpec,
  options: { home: boolean; platform: NodeJS.Platform },
): string[] {
  switch (shell.id) {
    case 'pwsh':
    case 'powershell':
      return ['-NoLogo', '-NoExit', '-Command', POWERSHELL_UTF8];
    case 'cmd':
      // Code page 65001 is UTF-8.
      return ['/K', 'chcp 65001>nul'];
    case 'wsl':
      // In the Linux home folder; a chosen Windows folder is translated by WSL itself.
      return options.home ? ['~'] : [];
    case 'login':
      // macOS terminals start login shells; Linux ones do not.
      return options.platform === 'darwin' ? ['-l'] : [];
  }
}

const DROPPED_ENV = /^(ELECTRON_|QUQA_|CHROME_CRASHPAD|ORIGINAL_XDG_CURRENT_DESKTOP$)/i;

/**
 * The environment of a local shell: the app's own, without Electron's and
 * the app's internal variables, plus what a modern terminal announces.
 */
export function shellEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || DROPPED_ENV.test(key) || key.length > 1024) continue;
    if (key.includes('=') || key.includes('\0') || value.includes('\0')) continue;
    out[key] = value.slice(0, 32_768);
  }
  out['TERM'] = 'xterm-256color';
  out['COLORTERM'] = 'truecolor';
  out['TERM_PROGRAM'] = 'quqa-express';
  return out;
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // An app execution alias (the Store's pwsh.exe) cannot be stat'ed, only lstat'ed.
    try {
      return !lstatSync(path).isDirectory();
    } catch {
      return false;
    }
  }
}

/** This computer: its environment, files, WSL and account (argument arrays only, no shell). */
export function systemShellEnvironment(): ShellEnvironment {
  return {
    platform: process.platform,
    env: process.env,
    exists: fileExists,
    wslDistros: (wsl) =>
      new Promise((resolve) => {
        execFile(
          wsl,
          ['--list', '--quiet'],
          { encoding: 'buffer', timeout: 5000, windowsHide: true },
          (error, stdout) => resolve(error ? [] : parseWslList(stdout)),
        );
      }),
    accountShell: () => {
      try {
        return userInfo().shell;
      } catch {
        return null;
      }
    },
  };
}
