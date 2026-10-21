import { describe, expect, it } from 'vitest';
import { unpackedPath } from './asar.js';

describe('unpackedPath', () => {
  const exists = (path: string) => path.includes('app.asar.unpacked');

  it('points a program inside app.asar at its unpacked copy', () => {
    expect(
      unpackedPath(
        'C:\\Apps\\quqa\\resources\\app.asar\\node_modules\\ssh2\\util\\pagent.exe',
        exists,
      ),
    ).toBe('C:\\Apps\\quqa\\resources\\app.asar.unpacked\\node_modules\\ssh2\\util\\pagent.exe');
    expect(unpackedPath('/opt/quqa/resources/app.asar/bin/tool', exists)).toBe(
      '/opt/quqa/resources/app.asar.unpacked/bin/tool',
    );
  });

  it('leaves other paths, and programs without an unpacked copy, alone', () => {
    expect(unpackedPath('C:\\Windows\\System32\\cmd.exe', exists)).toBe(
      'C:\\Windows\\System32\\cmd.exe',
    );
    expect(unpackedPath('/x/app.asar.unpacked/tool', exists)).toBe('/x/app.asar.unpacked/tool');
    expect(unpackedPath('/x/my-app.asarish/tool', exists)).toBe('/x/my-app.asarish/tool');
    expect(unpackedPath('/x/app.asar/tool', () => false)).toBe('/x/app.asar/tool');
  });
});
