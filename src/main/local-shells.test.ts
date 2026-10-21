import { describe, expect, it } from 'vitest';
import {
  detectShells,
  envValue,
  parseWslList,
  POWERSHELL_UTF8,
  shellArgs,
  shellEnvironment,
  type ShellEnvironment,
} from './local-shells.js';

/** A Windows computer with exactly these files (paths compared without case). */
function windows(
  files: string[],
  env: Record<string, string | undefined> = {},
  distros: string[] | Error = [],
): ShellEnvironment {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    platform: 'win32',
    env: {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      Path: 'C:\\Windows\\system32;C:\\Windows',
      ...env,
    },
    exists: (path) => set.has(path.toLowerCase()),
    wslDistros: async () => {
      if (distros instanceof Error) throw distros;
      return distros;
    },
    accountShell: () => null,
  };
}

const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CMD = 'C:\\Windows\\system32\\cmd.exe';
const WSL = 'C:\\Windows\\System32\\wsl.exe';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

describe('detectShells on Windows', () => {
  it('finds PowerShell 7 in Program Files, then Windows PowerShell and cmd', async () => {
    const shells = await detectShells(windows([PWSH, PS51, CMD]));
    expect(shells.map((s) => [s.id, s.file])).toEqual([
      ['pwsh', PWSH],
      ['powershell', PS51],
      ['cmd', CMD],
    ]);
    expect(shells[0]?.name).toBe('PowerShell 7');
  });

  it('prefers pwsh.exe on PATH (any case of the variable name, quoted folders)', async () => {
    const onPath = 'D:\\Tools\\pwsh\\pwsh.exe';
    const shells = await detectShells(
      windows([onPath, PWSH, PS51], { Path: undefined, PATH: 'relative\\dir;"D:\\Tools\\pwsh"' }),
    );
    expect(shells[0]).toMatchObject({ id: 'pwsh', file: onPath });
  });

  it('ignores relative PATH entries (no lookup in the current folder)', async () => {
    const shells = await detectShells(
      windows(['pwsh\\pwsh.exe', PS51], { Path: 'pwsh;.;C:\\Windows' }),
    );
    expect(shells.map((s) => s.id)).toEqual(['powershell']);
  });

  it('falls back to Windows PowerShell 5.1 without PowerShell 7', async () => {
    const shells = await detectShells(windows([PS51, CMD]));
    expect(shells[0]?.id).toBe('powershell');
  });

  it('offers WSL only when wsl.exe exists and a distribution is installed', async () => {
    expect((await detectShells(windows([PS51, WSL], {}, []))).map((s) => s.id)).toEqual([
      'powershell',
    ]);
    expect((await detectShells(windows([PS51, WSL], {}, new Error('no wsl')))).length).toBe(1);
    expect((await detectShells(windows([PS51], {}, ['Ubuntu']))).length).toBe(1);
    const withWsl = await detectShells(windows([PS51, WSL], {}, ['Ubuntu']));
    expect(withWsl.map((s) => s.id)).toEqual(['powershell', 'wsl']);
  });

  it('does not take ComSpec when it points at something other than cmd.exe', async () => {
    const shells = await detectShells(
      windows(['C:\\evil\\payload.exe', 'C:\\Windows\\System32\\cmd.exe'], {
        ComSpec: 'C:\\evil\\payload.exe',
      }),
    );
    expect(shells).toEqual([
      { id: 'cmd', name: 'Command Prompt', file: 'C:\\Windows\\System32\\cmd.exe' },
    ]);
  });

  it('finds nothing on an empty computer', async () => {
    expect(await detectShells(windows([]))).toEqual([]);
  });
});

describe('detectShells elsewhere', () => {
  const posixSystem = (files: string[], shell?: string, account: string | null = null) => ({
    platform: 'linux' as const,
    env: { SHELL: shell },
    exists: (path: string) => files.includes(path),
    wslDistros: async () => [],
    accountShell: () => account,
  });

  it('uses $SHELL, then the account shell, then bash or sh', async () => {
    expect(await detectShells(posixSystem(['/usr/bin/fish'], '/usr/bin/fish'))).toEqual([
      { id: 'login', name: 'fish', file: '/usr/bin/fish' },
    ]);
    expect((await detectShells(posixSystem(['/bin/zsh'], undefined, '/bin/zsh')))[0]?.file).toBe(
      '/bin/zsh',
    );
    expect((await detectShells(posixSystem(['/bin/sh'], 'fish')))[0]?.file).toBe('/bin/sh');
    expect(await detectShells(posixSystem([]))).toEqual([]);
  });
});

describe('parseWslList', () => {
  it('reads UTF-16LE with a BOM and NULs', () => {
    const text = '\uFEFFUbuntu-24.04\r\nDebian\r\n\r\n';
    expect(parseWslList(Buffer.from(text, 'utf16le'))).toEqual(['Ubuntu-24.04', 'Debian']);
  });

  it('treats the "no distributions" message as none', () => {
    const text =
      'Windows Subsystem for Linux has no installed distributions.\r\nThere are no installed distributions.\r\n';
    expect(parseWslList(Buffer.from(text, 'utf16le'))).toEqual([]);
    expect(parseWslList(Buffer.alloc(0))).toEqual([]);
  });
});

describe('shellArgs', () => {
  const shell = (id: 'pwsh' | 'powershell' | 'cmd' | 'wsl' | 'login') => ({
    id,
    name: id,
    file: 'x',
  });
  it('starts PowerShell without the logo, in UTF-8, and keeps it open', () => {
    expect(shellArgs(shell('pwsh'), { home: true, platform: 'win32' })).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      POWERSHELL_UTF8,
    ]);
    expect(POWERSHELL_UTF8).toContain('[Console]::OutputEncoding');
    expect(POWERSHELL_UTF8).toContain('[Console]::InputEncoding');
  });

  it('switches cmd to code page 65001 and WSL to its home folder', () => {
    expect(shellArgs(shell('cmd'), { home: true, platform: 'win32' })).toEqual([
      '/K',
      'chcp 65001>nul',
    ]);
    expect(shellArgs(shell('wsl'), { home: true, platform: 'win32' })).toEqual(['~']);
    expect(shellArgs(shell('wsl'), { home: false, platform: 'win32' })).toEqual([]);
    expect(shellArgs(shell('login'), { home: true, platform: 'darwin' })).toEqual(['-l']);
    expect(shellArgs(shell('login'), { home: true, platform: 'linux' })).toEqual([]);
  });
});

describe('shellEnvironment', () => {
  it('inherits the environment without Electron and app variables, and sets TERM', () => {
    const env = shellEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/me',
      ELECTRON_RUN_AS_NODE: '1',
      electron_renderer_url: 'http://x',
      QUQA_TEST_HOOKS: '1',
      TERM: 'dumb',
      '=C:': 'C:\\',
      EMPTY: undefined,
    });
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'quqa-express',
    });
  });

  it('matches names without case only on Windows', () => {
    expect(envValue({ Path: 'a' }, 'PATH', 'win32')).toBe('a');
    expect(envValue({ Path: 'a' }, 'PATH', 'linux')).toBeUndefined();
  });
});
