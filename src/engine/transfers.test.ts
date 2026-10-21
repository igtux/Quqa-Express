import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freeLocalName, partName, safeLocalName } from './transfers.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('download names', () => {
  it('makes remote names safe for the local disk', () => {
    expect(safeLocalName('report.pdf')).toBe('report.pdf');
    expect(safeLocalName('a:b*c?.txt')).toBe('a_b_c_.txt');
    expect(safeLocalName('..\\..\\evil')).toBe('.._.._evil');
    expect(safeLocalName('line\nbreak')).toBe('line_break');
    expect(safeLocalName('CON')).toBe('_CON');
    expect(safeLocalName('nul.txt')).toBe('_nul.txt');
    expect(safeLocalName('trailing. . ')).toBe('trailing');
    expect(safeLocalName('..')).toBe('download');
    expect(safeLocalName('')).toBe('download');
    expect(safeLocalName('x'.repeat(300))).toHaveLength(200);
  });

  it('never overwrites a local file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quqa-names-'));
    dirs.push(dir);
    expect(await freeLocalName(dir, 'a.txt')).toBe(join(dir, 'a.txt'));
    await writeFile(join(dir, 'a.txt'), '');
    await writeFile(join(dir, 'a (1).txt'), '');
    expect(await freeLocalName(dir, 'a.txt')).toBe(join(dir, 'a (2).txt'));
    await writeFile(join(dir, 'Makefile'), '');
    expect(await freeLocalName(dir, 'Makefile')).toBe(join(dir, 'Makefile (1)'));
  });

  it('names partial uploads within the name limit', () => {
    expect(partName('a.bin', 'abc123')).toBe('.a.bin.quqa-abc123.part');
    expect(partName('x'.repeat(255), 'abcdef123456').length).toBeLessThanOrEqual(255);
  });
});
