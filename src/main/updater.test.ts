import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../shared/ipc.js';
import { SettingsFile } from './app-settings.js';
import type { PortableTarget } from './portable-update.js';
import { Updater, type ReadyPortable } from './updater.js';

const TAG = 'v0.1.0-beta.6';
const NAME = 'quqa-express-0.1.0-beta.6-portable.exe';
const BASE = `https://github.com/igtux/Quqa-Express/releases/download/${TAG}/`;
const EXE = Buffer.from('the new portable exe '.repeat(5000));
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

let dir: string;
let target: PortableTarget;
let sums: string;
/** Set by a test: the exe body never ends until the request is aborted. */
let stall = false;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quqa updater ქ O'B-"));
  target = {
    exe: join(dir, 'quqa-express.exe'),
    dir,
    updates: join(dir, 'quqa-express-data', 'updates'),
    previous: join(dir, 'quqa-express-data', 'updates', 'previous.exe'),
  };
  sums = `${sha(EXE)}  ${NAME}\n${'cd'.repeat(32)}  quqa-express-0.1.0-beta.6-setup.exe\n`;
  stall = false;
  writeFileSync(
    join(dir, 'releases.json'),
    JSON.stringify([
      {
        tag_name: TAG,
        html_url: `https://github.com/igtux/Quqa-Express/releases/tag/${TAG}`,
        draft: false,
        prerelease: true,
        published_at: '2026-10-21T10:00:00Z',
        body: '## What is new\n\n- Portable updates itself',
        assets: [
          { name: NAME, size: EXE.length, browser_download_url: BASE + NAME },
          { name: 'SHA256SUMS.txt', size: 200, browser_download_url: `${BASE}SHA256SUMS.txt` },
        ],
      },
    ]),
  );
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    if (url === `${BASE}SHA256SUMS.txt`) return Promise.resolve(new Response(sums));
    if (url !== BASE + NAME) return Promise.resolve(new Response('', { status: 404 }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(EXE.subarray(0, 1000)));
        if (!stall) {
          controller.enqueue(new Uint8Array(EXE.subarray(1000)));
          controller.close();
        }
        init.signal?.addEventListener('abort', () =>
          controller.error(new DOMException('aborted', 'AbortError')),
        );
      },
    });
    return Promise.resolve(new Response(body));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

function updater(swap = vi.fn<(r: ReadyPortable, t: PortableTarget) => Promise<void>>()) {
  const u = new Updater({
    settings: new SettingsFile(join(dir, 'settings.json')),
    current: '0.1.0-beta.5',
    method: 'portable',
    portable: { target },
    openExternal: vi.fn(),
    runInstaller: vi.fn(),
    runPortableSwap: swap,
    releasesFile: join(dir, 'releases.json'),
    offline: true,
  });
  return { u, swap };
}

async function until(u: Updater, done: (s: UpdateState) => boolean): Promise<UpdateState> {
  for (let i = 0; i < 200; i += 1) {
    const s = u.state();
    if (done(s)) return s;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out in phase ${u.state().phase}`);
}

describe('portable self-update', () => {
  it('downloads and verifies the new exe, then hands it to the swap helper', async () => {
    const { u, swap } = updater();
    const checked = await u.check();
    expect(checked.method).toBe('portable');
    expect(checked.pageReason).toBeNull();
    expect(u.install().phase).toBe('downloading');
    const ready = await until(u, (s) => s.phase !== 'downloading' && s.phase !== 'verifying');
    expect(ready.phase).toBe('ready');
    expect(ready.error).toBeNull();
    const path = join(target.updates, NAME);
    expect(await readFile(path)).toEqual(EXE);
    expect(readdirSync(target.updates)).toEqual([NAME]);

    const after = await u.restart();
    expect(after.phase).toBe('starting');
    expect(swap).toHaveBeenCalledWith({ version: '0.1.0-beta.6', path, sha256: sha(EXE) }, target);
  });

  it('refuses a download that does not match SHA256SUMS.txt and keeps nothing', async () => {
    sums = `${'ef'.repeat(32)}  ${NAME}\n`;
    const { u, swap } = updater();
    await u.check();
    u.install();
    const s = await until(u, (x) => x.phase === 'idle');
    expect(s.error).toMatch(/does not match SHA256SUMS\.txt/);
    expect(readdirSync(target.updates)).toEqual([]);
    expect(swap).not.toHaveBeenCalled();
  });

  it('refuses a release whose SHA256SUMS.txt does not list the portable exe', async () => {
    sums = `${sha(EXE)}  quqa-express-0.1.0-beta.6-setup.exe\n`;
    const { u } = updater();
    await u.check();
    u.install();
    const s = await until(u, (x) => x.phase === 'idle');
    expect(s.error).toMatch(/no checksum/);
  });

  it('does not run a verified file that changed before the restart', async () => {
    const { u, swap } = updater();
    await u.check();
    u.install();
    await until(u, (s) => s.phase === 'ready');
    writeFileSync(join(target.updates, NAME), 'tampered');
    const s = await u.restart();
    expect(s.phase).toBe('idle');
    expect(s.error).toMatch(/changed after it was checked/);
    expect(swap).not.toHaveBeenCalled();
  });

  it('cancels a running download and removes the partial file', async () => {
    stall = true;
    const { u } = updater();
    await u.check();
    u.install();
    await until(u, (s) => (s.progress ?? 0) > 0);
    const s = u.cancel();
    expect(s.phase).toBe('idle');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(u.state().error).toBeNull();
    expect(readdirSync(target.updates)).toEqual([]);
  });

  it('discards a verified download that was not applied', async () => {
    const { u } = updater();
    await u.check();
    u.install();
    await until(u, (s) => s.phase === 'ready');
    expect(u.cancel().phase).toBe('idle');
    await until(u, () => !existsSync(join(target.updates, NAME)));
  });

  it('offers the download page with a reason when the folder is read-only', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    chmodSync(dir, 0o500);
    const { u } = updater();
    const s = await u.check();
    expect(s.method).toBe('page');
    expect(s.pageReason).toMatch(/cannot write to/);
  });

  it('offers the download page when the exe path was refused', async () => {
    const u = new Updater({
      settings: new SettingsFile(join(dir, 'settings.json')),
      current: '0.1.0-beta.5',
      method: 'portable',
      portable: { reason: 'The portable exe has a path quqa-express cannot safely replace.' },
      openExternal: vi.fn(),
      runInstaller: vi.fn(),
      runPortableSwap: vi.fn(),
      releasesFile: join(dir, 'releases.json'),
      offline: true,
    });
    const s = await u.check();
    expect(s.method).toBe('page');
    expect(s.pageReason).toMatch(/cannot safely replace/);
  });
});
