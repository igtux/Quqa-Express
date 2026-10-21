import { describe, expect, it } from 'vitest';
import { insideRoots, shellQuote, typedPaths, windowsPath } from './paths.js';

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
