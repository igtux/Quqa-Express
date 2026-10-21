/**
 * Self-update of the portable exe (docs/adr/0006, addendum "Portable
 * self-update"). Plain Node, no Electron, so it is unit-tested on every OS
 * and run for real on windows-latest (test/windows/portable-swap.test.ts).
 *
 * The portable build is one exe that electron-builder's NSIS stub unpacks to
 * a temp folder and waits on; `PORTABLE_EXECUTABLE_FILE` is the real exe. A
 * running exe cannot be overwritten, so main downloads and verifies the new
 * exe into `quqa-express-data\updates\`, and on "Restart to update" starts a
 * small PowerShell helper and quits. The helper waits for the app and the
 * stub to exit, checks the SHA-256 again, moves the old exe to
 * `updates\previous.exe`, moves the new one to the old exe's exact path and
 * name, and starts it. On any failure it puts the old exe back and starts it.
 *
 * No shell string building: the helper script is a constant, every value it
 * needs (paths, hash, process ids) travels in environment variables, and the
 * PowerShell command line is a constant too.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';

/** The folder next to the exe that holds the portable profile (src/main/index.ts). */
export const DATA_FOLDER = 'quqa-express-data';
export const UPDATES_FOLDER = 'updates';
export const PREVIOUS_EXE = 'previous.exe';
export const SCRIPT_NAME = 'apply-update.ps1';
export const LOG_NAME = 'update.log';
/** Windows PowerShell 5.1 (.NET Framework) still trips over paths of MAX_PATH (260) and more. */
const MAX_PATH = 259;
const MAX_LOG_BYTES = 256 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
/** A file name of a release asset (updates.ts checks the same names). */
const ASSET_NAME = /^quqa-express-[0-9A-Za-z.-]{1,60}-portable\.exe$/;

export interface PortableTarget {
  /** The portable exe as the user keeps it (shortcuts point here). */
  exe: string;
  /** Its folder. */
  dir: string;
  /** `<dir>\quqa-express-data\updates`. */
  updates: string;
  /** `<updates>\previous.exe`, the version before the last update. */
  previous: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * A full Windows path we are willing to rename: a drive letter or a UNC share,
 * no device (`\\?\`, `\\.\`) paths, no characters Windows forbids in names,
 * no `.` or `..` segments, and short enough for PowerShell 5.1.
 */
export function isSafeWindowsPath(path: string): boolean {
  if (path.length < 4 || path.length > MAX_PATH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f"<>|?*\u007f\u202a-\u202e\u2066-\u2069]/.test(path)) return false;
  let rest: string;
  if (/^[A-Za-z]:\\/.test(path)) rest = path.slice(3);
  else if (/^\\\\[^\\.?][^\\]*\\[^\\]+\\/.test(path)) rest = path.slice(2);
  else return false;
  if (rest.includes(':') || rest.includes('/')) return false;
  const parts = rest.split('\\');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..' && !/[ .]$/.test(part));
}

/**
 * Checks what the portable stub put in the environment (`PORTABLE_EXECUTABLE_FILE`
 * and `PORTABLE_EXECUTABLE_DIR`) and derives the update folder from it.
 */
export function portableTarget(
  file: string | undefined,
  dir: string | undefined,
): Checked<PortableTarget> {
  const no = (reason: string): Checked<PortableTarget> => ({ ok: false, reason });
  if (!file || !dir) return no('This copy was not started from the portable exe.');
  if (!isSafeWindowsPath(file) || !/\.exe$/i.test(file)) {
    return no('The portable exe has a path quqa-express cannot safely replace.');
  }
  const folder = win32.dirname(file);
  const bare = (path: string) => path.replace(/\\+$/, '').toLowerCase();
  if (bare(folder) !== bare(win32.normalize(dir))) {
    return no('The portable exe and its folder do not match.');
  }
  const updates = win32.join(folder, DATA_FOLDER, UPDATES_FOLDER);
  const previous = win32.join(updates, PREVIOUS_EXE);
  // The longest path the helper writes is the downloaded asset next to previous.exe.
  if (!isSafeWindowsPath(win32.join(updates, 'quqa-express-000000.000000.000000-portable.exe'))) {
    return no('The folder of the portable exe is nested too deeply to update in place.');
  }
  return { ok: true, value: { exe: file, dir: folder, updates, previous } };
}

/** The path the new exe is downloaded to; the name comes from the release (checked). */
export function downloadPath(target: PortableTarget, assetName: string): string {
  if (!ASSET_NAME.test(assetName)) throw new Error('Unexpected asset name');
  return join(target.updates, assetName);
}

/**
 * Can we replace the exe? Renaming it needs write access to its folder, and
 * the download needs the updates folder. A read-only USB stick or
 * `C:\Program Files` fails here, and the app offers the download page instead.
 */
export async function probeWritable(target: PortableTarget): Promise<boolean> {
  const name = `.quqa-express-probe-${randomBytes(6).toString('hex')}`;
  try {
    await mkdir(target.updates, { recursive: true });
    for (const folder of [target.dir, target.updates]) {
      const path = join(folder, name);
      const handle = await open(path, 'wx');
      await handle.close();
      await unlink(path);
    }
    return true;
  } catch {
    return false;
  }
}

/** The SHA-256 of a file, lower-case hex. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** True only when the file's SHA-256 equals `expected` (64 hex digits). */
export async function fileMatches(path: string, expected: string): Promise<boolean> {
  if (!SHA256.test(expected)) return false;
  try {
    return (await sha256File(path)) === expected;
  } catch {
    return false;
  }
}

/**
 * Leftovers from an earlier update: partial downloads, a verified exe that was
 * never applied, the helper script. `previous.exe` stays for a manual roll
 * back; the log stays unless it grew large.
 */
export async function cleanUpdates(updates: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(updates);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === PREVIOUS_EXE) continue;
    const path = join(updates, name);
    try {
      if (name === LOG_NAME && (await stat(path)).size <= MAX_LOG_BYTES) continue;
      await rm(path, { force: true });
    } catch {
      // In use (the helper may still be finishing); next start tries again.
    }
  }
}

/**
 * The helper. Windows PowerShell 5.1 (on every Windows 10 and 11), ASCII only,
 * literal .NET file calls (no wildcard expansion of paths). It reads all its
 * values from the environment and clears them before it starts the app.
 * Exit codes: 0 updated, 2 checksum, 3 old previous.exe, 4 moving the old exe,
 * 5 placing the new exe, 6 the new exe did not start (rolled back).
 */
export const SWAP_SCRIPT = [
  '# quqa-express portable self-update helper (docs/adr/0006). Written by the app;',
  '# every value comes from the environment, nothing is pasted into this text.',
  "$ErrorActionPreference = 'Stop'",
  '$target = $env:QUQA_UPDATE_TARGET',
  '$new = $env:QUQA_UPDATE_NEW',
  '$previous = $env:QUQA_UPDATE_PREVIOUS',
  '$expected = $env:QUQA_UPDATE_SHA256',
  '$log = $env:QUQA_UPDATE_LOG',
  '$appPid = $env:QUQA_UPDATE_APP_PID',
  '$stubPid = $env:QUQA_UPDATE_STUB_PID',
  "$noStart = $env:QUQA_UPDATE_NO_START -eq '1'",
  "foreach ($name in @('QUQA_UPDATE_TARGET', 'QUQA_UPDATE_NEW', 'QUQA_UPDATE_PREVIOUS', 'QUQA_UPDATE_SHA256', 'QUQA_UPDATE_LOG', 'QUQA_UPDATE_APP_PID', 'QUQA_UPDATE_STUB_PID', 'QUQA_UPDATE_NO_START', 'QUQA_UPDATE_SCRIPT')) {",
  "  [Environment]::SetEnvironmentVariable($name, $null, 'Process')",
  '}',
  '',
  'function Write-Log([string]$message) {',
  '  if (-not $log) { return }',
  "  try { [IO.File]::AppendAllText($log, ((Get-Date).ToString('o') + ' ' + $message + [Environment]::NewLine)) } catch { }",
  '}',
  '',
  'function Wait-Exit([string]$id) {',
  "  if ($id -notmatch '^[0-9]{1,9}$') { return }",
  '  try { $process = [Diagnostics.Process]::GetProcessById([int]$id) } catch { return }',
  "  if (-not $process.WaitForExit(90000)) { Write-Log ('process ' + $id + ' is still running; trying anyway') }",
  '}',
  '',
  'function Invoke-Retry([scriptblock]$action, [string]$what) {',
  '  for ($i = 1; $i -le 60; $i++) {',
  '    try { & $action; return $true } catch {',
  "      if ($i -eq 60) { Write-Log ($what + ' failed: ' + $_.Exception.Message) }",
  '      Start-Sleep -Milliseconds 500',
  '    }',
  '  }',
  '  return $false',
  '}',
  '',
  'function Test-Hash([string]$path) {',
  "  if ($expected -notmatch '^[0-9a-f]{64}$') { return $false }",
  '  try { $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() } catch { return $false }',
  '  return $actual -eq $expected',
  '}',
  '',
  'function Start-App {',
  '  if ($noStart) { return $true }',
  '  try {',
  '    $info = New-Object Diagnostics.ProcessStartInfo',
  '    $info.FileName = $target',
  '    $info.WorkingDirectory = [IO.Path]::GetDirectoryName($target)',
  '    $info.UseShellExecute = $false',
  '    [void][Diagnostics.Process]::Start($info)',
  '    return $true',
  "  } catch { Write-Log ('could not start ' + $target + ': ' + $_.Exception.Message); return $false }",
  '}',
  '',
  "Write-Log 'waiting for quqa-express to close'",
  'Wait-Exit $appPid',
  'Wait-Exit $stubPid',
  'if (-not (Test-Hash $new)) {',
  "  Write-Log 'the downloaded exe does not match SHA256SUMS.txt; nothing was changed'",
  '  try { [IO.File]::Delete($new) } catch { }',
  '  [void](Start-App)',
  '  exit 2',
  '}',
  'if ([IO.File]::Exists($previous)) {',
  "  if (-not (Invoke-Retry { [IO.File]::Delete($previous) } 'removing the older previous.exe')) { [void](Start-App); exit 3 }",
  '}',
  "if (-not (Invoke-Retry { [IO.File]::Move($target, $previous) } 'moving the old exe aside')) { [void](Start-App); exit 4 }",
  "$placed = Invoke-Retry { [IO.File]::Move($new, $target) } 'putting the new exe in place'",
  'if ($placed -and -not (Test-Hash $target)) {',
  "  Write-Log 'the exe in place does not match SHA256SUMS.txt'",
  "  [void](Invoke-Retry { [IO.File]::Delete($target) } 'removing the mismatched exe')",
  '  $placed = $false',
  '}',
  'if (-not $placed) {',
  "  [void](Invoke-Retry { [IO.File]::Move($previous, $target) } 'restoring the old exe')",
  '  [void](Start-App)',
  '  exit 5',
  '}',
  "Write-Log 'updated; starting the new version'",
  'if (-not (Start-App)) {',
  "  [void](Invoke-Retry { [IO.File]::Move($target, $new) } 'moving the new exe away')",
  "  [void](Invoke-Retry { [IO.File]::Move($previous, $target) } 'restoring the old exe')",
  "  Write-Log 'rolled back to the old exe'",
  '  [void](Start-App)',
  '  exit 6',
  '}',
  'exit 0',
  '',
].join('\r\n');

/**
 * The command line is a constant: PowerShell reads the script file named in
 * QUQA_UPDATE_SCRIPT and runs it, so no path ever appears in an argument.
 */
export const SWAP_COMMAND =
  '& ([scriptblock]::Create([IO.File]::ReadAllText($env:QUQA_UPDATE_SCRIPT)))';

export interface SwapPlan {
  target: PortableTarget;
  /** The verified download in `target.updates`. */
  download: string;
  sha256: string;
  appPid: number;
  /** The portable stub (the app's parent), which keeps the exe open until the app exits. */
  stubPid: number | null;
  /** Tests: swap but do not start the result. */
  noStart?: boolean;
}

export interface SwapLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  script: string;
}

/** Variables never handed on to the helper (and so to the new app). */
const DROPPED_ENV = /^(ELECTRON_|PORTABLE_EXECUTABLE_|QUQA_TEST_|QUQA_UPDATE_|NODE_OPTIONS$)/i;

/** What to start, with which environment. Pure: validates everything, spawns nothing. */
export function swapLaunch(plan: SwapPlan, env: NodeJS.ProcessEnv): SwapLaunch {
  const { target } = plan;
  for (const path of [target.exe, target.previous, plan.download]) {
    if (!isSafeWindowsPath(path)) throw new Error('Unsafe path for the update helper');
  }
  if (win32.dirname(plan.download) !== target.updates) {
    throw new Error('The download is not in the updates folder');
  }
  if (!SHA256.test(plan.sha256)) throw new Error('Bad checksum');
  const pid = (n: number | null) => (n !== null && Number.isSafeInteger(n) && n > 0 ? n : null);
  const appPid = pid(plan.appPid);
  if (appPid === null) throw new Error('Bad process id');
  const stubPid = pid(plan.stubPid);

  const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows';
  const systemRoot = /^[A-Za-z]:\\[^"<>|?*;]{1,200}$/.test(root) ? root : 'C:\\Windows';
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !DROPPED_ENV.test(key)) kept[key] = value;
  }
  const script = win32.join(target.updates, SCRIPT_NAME);
  return {
    // The full path: never whichever powershell.exe the current folder or PATH offers.
    command: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-Command',
      SWAP_COMMAND,
    ],
    env: {
      ...kept,
      QUQA_UPDATE_SCRIPT: script,
      QUQA_UPDATE_TARGET: target.exe,
      QUQA_UPDATE_NEW: plan.download,
      QUQA_UPDATE_PREVIOUS: target.previous,
      QUQA_UPDATE_SHA256: plan.sha256,
      QUQA_UPDATE_LOG: win32.join(target.updates, LOG_NAME),
      QUQA_UPDATE_APP_PID: String(appPid),
      QUQA_UPDATE_STUB_PID: stubPid === null ? '' : String(stubPid),
      ...(plan.noStart ? { QUQA_UPDATE_NO_START: '1' } : {}),
    },
    script,
  };
}

/** Writes the helper script into the updates folder (it is the same text every time). */
export async function writeSwapScript(launch: SwapLaunch): Promise<void> {
  await writeFile(launch.script, SWAP_SCRIPT, { encoding: 'ascii' });
}

/**
 * Writes the script and starts the helper on its own (it outlives the app,
 * which quits next). Resolves once Windows has started it.
 */
export async function startSwapHelper(launch: SwapLaunch, cwd: string): Promise<ChildProcess> {
  await writeSwapScript(launch);
  return await new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: launch.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => resolve(child));
  });
}
