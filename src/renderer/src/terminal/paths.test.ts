import { describe, expect, it } from 'vitest';
import { insideRoots, localPaths, shellQuote, typedPaths, windowsPath } from './paths.js';
import { printableTitle } from './title.js';

describe('typed paths', () => {
  it('quotes for POSIX shells only when needed', () => {
    expect(shellQuote('/home/me/uploads/clipboard_1.png')).toBe('/home/me/uploads/clipboard_1.png');
    expect(shellQuote('/tmp/a b.png')).toBe("'/tmp/a b.png'");
    expect(shellQuote("/tmp/it's.png")).toBe("'/tmp/it'\\''s.png'");
    expect(shellQuote('/tmp/$(reboot).png')).toBe("'/tmp/$(reboot).png'");
    expect(shellQuote('/tmp/a;b\nc')).toBe("'/tmp/a;b\nc'");
    expect(shellQuote('')).toBe("''");
  });

  it('writes Windows paths the way cmd and PowerShell take them', () => {
    expect(windowsPath('/C:/Users/me/uploads/x.png')).toBe('C:\\Users\\me\\uploads\\x.png');
    expect(windowsPath('/C:')).toBe('C:\\');
    expect(typedPaths(['/C:/Users/me/a b.png'], 'windows')).toBe('"C:\\Users\\me\\a b.png"');
  });

  it('joins several paths', () => {
    expect(typedPaths(['/a', '/b c'], 'linux')).toBe("/a '/b c'");
  });

  it('checks roots', () => {
    expect(insideRoots('/srv/app/x', ['/srv/app'])).toBe(true);
    expect(insideRoots('/srv/apple', ['/srv/app'])).toBe(false);
    expect(insideRoots('/etc', [])).toBe(true);
  });
});

describe('local terminals', () => {
  it('types local paths quoted for PowerShell and cmd, or for POSIX shells', () => {
    expect(localPaths(['C:\\Users\\me\\a.png'], true)).toBe('C:\\Users\\me\\a.png');
    expect(localPaths(['C:\\Users\\Ირაკლი Ბ\\AppData\\x.png', 'D:\\a&b.txt'], true)).toBe(
      '"C:\\Users\\Ირაკლი Ბ\\AppData\\x.png" "D:\\a&b.txt"',
    );
    expect(localPaths(['C:\\x"y z.txt'], true)).toBe('"C:\\xy z.txt"');
    expect(localPaths(["/home/me/it's.png"], false)).toBe("'/home/me/it'\\''s.png'");
  });

  it('turns program titles into short printable tab names', () => {
    expect(printableTitle('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh');
    expect(printableTitle('C:\\WINDOWS\\system32\\cmd.exe')).toBe('cmd');
    expect(printableTitle('/usr/bin/bash')).toBe('bash');
    expect(printableTitle('✳ Claude Code')).toBe('✳ Claude Code');
    expect(printableTitle('me@box: ~/src')).toBe('me@box: ~/src');
    expect(printableTitle('evil\x1b]0;x\x07\u009btitle')).toBe('evil]0;xtitle');
    expect(printableTitle('x'.repeat(200))).toHaveLength(80);
  });
});
