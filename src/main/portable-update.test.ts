import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SWAP_COMMAND,
  SWAP_SCRIPT,
  cleanUpdates,
  downloadPath,
  fileMatches,
  isSafeWindowsPath,
  portableTarget,
  probeWritable,
  sha256File,
  swapLaunch,
  type PortableTarget,
} from './portable-update.js';

const GEORGIAN = "D:\\ქუქა ექსპრესი\\O'Brien's tools";
const EXE = `${GEORGIAN}\\quqa express (mine).exe`;
const HASH = 'ab'.repeat(32);

function target(exe = EXE, dir = GEORGIAN): PortableTarget {
  const checked = portableTarget(exe, dir);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.value;
}

describe('isSafeWindowsPath', () => {
  it.each([
    'C:\\Users\\irakli\\Desktop\\quqa-express-0.1.0-beta.5-portable.exe',
    EXE,
    "E:\\Program's\\a b\\quqa-express.exe",
    '\\\\nas\\share\\tools\\quqa-express.exe',
    'C:\\$Recycle\\%TEMP%\\a&b;c^d`e\\q.exe',
  ])('accepts %s', (path) => {
    expect(isSafeWindowsPath(path)).toBe(true);
  });

  it.each([
    ['relative', 'quqa-express.exe'],
    ['rooted without drive', '\\quqa-express.exe'],
    ['device path', '\\\\?\\C:\\quqa-express.exe'],
    ['device namespace', '\\\\.\\pipe\\quqa'],
    ['dot-dot segment', 'C:\\a\\..\\quqa-express.exe'],
    ['dot segment', 'C:\\a\\.\\quqa-express.exe'],
    ['double quote', 'C:\\a"b\\quqa-express.exe'],
    ['newline', 'C:\\a\nb\\quqa-express.exe'],
    ['NUL', 'C:\\a\u0000b\\quqa-express.exe'],
    ['alternate data stream', 'C:\\a\\quqa-express.exe:evil'],
    ['forward slash', 'C:\\a/b\\quqa-express.exe'],
    ['wildcard', 'C:\\a*\\quqa-express.exe'],
    ['pipe', 'C:\\a|calc\\quqa-express.exe'],
    ['bidi override', 'C:\\a\u202eexe.txt\\quqa-express.exe'],
    ['empty segment', 'C:\\a\\\\quqa-express.exe'],
    ['trailing dot', 'C:\\a.\\quqa-express.exe'],
    ['trailing space', 'C:\\a \\quqa-express.exe'],
    ['too long', `C:\\${'a'.repeat(300)}\\quqa-express.exe`],
  ])('rejects %s', (_name, path) => {
    expect(isSafeWindowsPath(path)).toBe(false);
  });
});

describe('portableTarget', () => {
  it('keeps the exe path and name and puts the updates next to the vault', () => {
    const t = target();
    expect(t.exe).toBe(EXE);
    expect(t.dir).toBe(GEORGIAN);
    expect(t.updates).toBe(`${GEORGIAN}\\quqa-express-data\\updates`);
    expect(t.previous).toBe(`${GEORGIAN}\\quqa-express-data\\updates\\previous.exe`);
  });

  it('accepts the folder with a trailing backslash, in another case, and the drive root', () => {
    expect(portableTarget(EXE, `${GEORGIAN.toUpperCase()}\\`).ok).toBe(true);
    expect(portableTarget('C:\\quqa-express.exe', 'C:\\').ok).toBe(true);
  });

  it('refuses a missing, mismatched, non-exe or unsafe path', () => {
    expect(portableTarget(undefined, GEORGIAN).ok).toBe(false);
    expect(portableTarget(EXE, undefined).ok).toBe(false);
    expect(portableTarget(EXE, 'D:\\elsewhere').ok).toBe(false);
    expect(portableTarget(`${GEORGIAN}\\quqa.bat`, GEORGIAN).ok).toBe(false);
    expect(portableTarget('\\\\?\\D:\\q.exe', '\\\\?\\D:\\').ok).toBe(false);
    const deep = `C:\\${'d'.repeat(200)}`;
    expect(portableTarget(`${deep}\\q.exe`, deep).ok).toBe(false);
  });

  it('names the download only after a release asset', () => {
    const t = target();
    expect(downloadPath(t, 'quqa-express-0.1.0-beta.6-portable.exe')).toContain(
      'quqa-express-0.1.0-beta.6-portable.exe',
    );
    for (const bad of [
      '..\\evil.exe',
      'quqa-express-1-setup.exe',
      'quqa-express-a/b-portable.exe',
    ]) {
      expect(() => downloadPath(t, bad)).toThrow();
    }
  });
});

describe('swapLaunch', () => {
  const plan = () => ({
    target: target(),
    download: `${GEORGIAN}\\quqa-express-data\\updates\\quqa-express-0.1.0-beta.6-portable.exe`,
    sha256: HASH,
    appPid: 4242,
    stubPid: 4241,
  });

  it('passes every value in the environment, byte for byte, and none on the command line', () => {
    const launch = swapLaunch(plan(), { SystemRoot: 'C:\\Windows', PATH: 'C:\\x' });
    expect(launch.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(launch.args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-Command',
      SWAP_COMMAND,
    ]);
    for (const arg of launch.args) {
      expect(arg).not.toContain('ქუქა');
      expect(arg).not.toContain("'");
    }
    expect(launch.env).toMatchObject({
      PATH: 'C:\\x',
      QUQA_UPDATE_TARGET: EXE,
      QUQA_UPDATE_NEW: plan().download,
      QUQA_UPDATE_PREVIOUS: `${GEORGIAN}\\quqa-express-data\\updates\\previous.exe`,
      QUQA_UPDATE_SHA256: HASH,
      QUQA_UPDATE_APP_PID: '4242',
      QUQA_UPDATE_STUB_PID: '4241',
      QUQA_UPDATE_SCRIPT: `${GEORGIAN}\\quqa-express-data\\updates\\apply-update.ps1`,
      QUQA_UPDATE_LOG: `${GEORGIAN}\\quqa-express-data\\updates\\update.log`,
    });
    expect(launch.env['QUQA_UPDATE_NO_START']).toBeUndefined();
  });

  it('does not hand Electron, portable-stub or test variables on to the new app', () => {
    const launch = swapLaunch(plan(), {
      SystemRoot: 'C:\\Windows',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--require evil.js',
      PORTABLE_EXECUTABLE_DIR: 'X:\\',
      QUQA_TEST_HOOKS: '1',
      QUQA_UPDATE_TARGET: 'X:\\evil.exe',
    });
    expect(
      Object.keys(launch.env).filter((k) => /^(ELECTRON|PORTABLE|QUQA_TEST|NODE_)/.test(k)),
    ).toEqual([]);
    expect(launch.env['QUQA_UPDATE_TARGET']).toBe(EXE);
  });

  it('uses the default Windows folder when SystemRoot looks wrong', () => {
    for (const root of ['\\\\evil\\share', 'C:\\Win"dows', 'relative', 'C:\\a;b']) {
      expect(swapLaunch(plan(), { SystemRoot: root }).command).toBe(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      );
    }
  });

  it('refuses a bad checksum, process id or download location', () => {
    expect(() => swapLaunch({ ...plan(), sha256: 'AB'.repeat(32) }, {})).toThrow();
    expect(() => swapLaunch({ ...plan(), sha256: `${HASH}\n` }, {})).toThrow();
    expect(() => swapLaunch({ ...plan(), appPid: 0 }, {})).toThrow();
    expect(() => swapLaunch({ ...plan(), appPid: 1.5 }, {})).toThrow();
    expect(() => swapLaunch({ ...plan(), download: 'D:\\other\\q.exe' }, {})).toThrow();
    expect(() => swapLaunch({ ...plan(), download: `${plan().download}"` }, {})).toThrow();
    expect(swapLaunch({ ...plan(), stubPid: -1 }, {}).env['QUQA_UPDATE_STUB_PID']).toBe('');
  });
});

describe('the helper script', () => {
  it('is plain ASCII with no values pasted in', () => {
    // eslint-disable-next-line no-control-regex
    expect(/^[\u0009\u000a\u000d\u0020-\u007e]*$/.test(SWAP_SCRIPT)).toBe(true);
    expect(SWAP_SCRIPT).not.toContain('`'); // PowerShell's escape character
    expect(SWAP_SCRIPT).not.toMatch(/Invoke-Expression|\biex\b|cmd(\.exe)?\s|Start-Process/i);
    expect(SWAP_SCRIPT).not.toContain('ქუქა');
    expect(SWAP_COMMAND).not.toMatch(/["'`]/);
  });

  it('reads only its own variables and checks the hash before and after the swap', () => {
    const vars = new Set(SWAP_SCRIPT.match(/\$env:[A-Za-z0-9_]+/g));
    expect([...vars].sort()).toEqual(
      [
        '$env:QUQA_UPDATE_APP_PID',
        '$env:QUQA_UPDATE_LOG',
        '$env:QUQA_UPDATE_NEW',
        '$env:QUQA_UPDATE_NO_START',
        '$env:QUQA_UPDATE_PREVIOUS',
        '$env:QUQA_UPDATE_SHA256',
        '$env:QUQA_UPDATE_STUB_PID',
        '$env:QUQA_UPDATE_TARGET',
      ].sort(),
    );
    expect(SWAP_SCRIPT.match(/Test-Hash \$/g)).toHaveLength(2);
    // Only .NET calls: cmdlets from modules break under a PowerShell 7 PSModulePath.
    expect(SWAP_SCRIPT).not.toMatch(
      /Get-FileHash|Get-Date|Start-Sleep|New-Object|Move-Item|Remove-Item/,
    );
  });
});

describe('files', () => {
  const dirs: string[] = [];
  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), "quqa ქუქა O'B-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashes and compares files', async () => {
    const path = join(temp(), 'new.exe');
    writeFileSync(path, 'new version');
    const hash = createHash('sha256').update('new version').digest('hex');
    expect(await sha256File(path)).toBe(hash);
    expect(await fileMatches(path, hash)).toBe(true);
    expect(await fileMatches(path, 'cd'.repeat(32))).toBe(false);
    expect(await fileMatches(path, hash.toUpperCase())).toBe(false);
    expect(await fileMatches(join(temp(), 'missing.exe'), hash)).toBe(false);
  });

  it('probes whether the exe folder can be written', async () => {
    const dir = temp();
    const t = { exe: join(dir, 'q.exe'), dir, updates: join(dir, 'd', 'u'), previous: '' };
    expect(await probeWritable(t)).toBe(true);
    expect(existsSync(t.updates)).toBe(true);
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const locked = temp();
    chmodSync(locked, 0o500);
    const r = { exe: join(locked, 'q.exe'), dir: locked, updates: join(locked, 'u'), previous: '' };
    expect(await probeWritable(r)).toBe(false);
  });

  it('cleans leftovers but keeps previous.exe and a small log', async () => {
    const dir = temp();
    mkdirSync(join(dir, 'u'));
    for (const name of [
      'previous.exe',
      'update.log',
      'apply-update.ps1',
      'x-portable.exe.partial',
    ]) {
      writeFileSync(join(dir, 'u', name), 'x');
    }
    await cleanUpdates(join(dir, 'u'));
    expect(existsSync(join(dir, 'u', 'previous.exe'))).toBe(true);
    expect(existsSync(join(dir, 'u', 'update.log'))).toBe(true);
    expect(existsSync(join(dir, 'u', 'apply-update.ps1'))).toBe(false);
    expect(existsSync(join(dir, 'u', 'x-portable.exe.partial'))).toBe(false);
    await cleanUpdates(join(dir, 'missing'));
  });
});
