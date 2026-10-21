import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Grants, remoteNameOf } from './grants.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('upload grants', () => {
  it('grants existing regular files only, by random token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quqa-grants-'));
    dirs.push(dir);
    await writeFile(join(dir, 'a.txt'), 'hello');
    await mkdir(join(dir, 'folder'));
    const grants = new Grants();
    const granted = await grants.grant([
      join(dir, 'a.txt'),
      join(dir, 'folder'),
      join(dir, 'missing'),
      'relative.txt',
      `${dir}/a\0.txt`,
    ]);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({ name: 'a.txt', size: 5 });
    expect(granted[0]?.token).toMatch(/^g[0-9a-f]{24}$/);
    expect(grants.resolve([granted[0]?.token ?? ''])).toEqual([
      { path: join(dir, 'a.txt'), name: 'a.txt' },
    ]);
    // Any unknown token fails the whole request.
    expect(grants.resolve([granted[0]?.token ?? '', 'g000000000000000000000000'])).toBeNull();
  });

  it('expires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quqa-grants-'));
    dirs.push(dir);
    await writeFile(join(dir, 'a.txt'), 'x');
    let now = 1000;
    const grants = new Grants(() => now);
    const [granted] = await grants.grant([join(dir, 'a.txt')]);
    now += 31 * 60_000;
    expect(grants.resolve([granted?.token ?? ''])).toBeNull();
  });

  it('names files for the remote side', () => {
    expect(remoteNameOf('/home/me/report.pdf')).toBe('report.pdf');
    expect(remoteNameOf('C:\\Users\\me\\a b.png')).toBe('a b.png');
    expect(remoteNameOf('/x/bad\u0007name')).toBe('badname');
    expect(remoteNameOf('/x/..')).toBe('file');
  });
});
