/**
 * The portable swap helper for real, on Windows (CI: windows-latest). It runs
 * the same script and command line main uses (src/main/portable-update.ts)
 * in a folder whose name has spaces, Georgian letters, an apostrophe and
 * brackets, against a running "old" exe that holds its file open.
 *
 * Stand-ins: copies of ping.exe or node.exe (old, node kept running) and hostname.exe (new,
 * exits at once). With QUQA_TEST_PORTABLE_EXE (CI sets it after building)
 * the built portable exe is swapped in as the new version too.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HELPER_STARTED,
  portableTarget,
  sha256File,
  startSwapHelper,
  swapLaunch,
  writeSwapScript,
  type PortableTarget,
} from '../../src/main/portable-update.js';

const windows = process.platform === 'win32';
const system32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32');
const NEW_NAME = 'quqa-express-0.1.0-beta.99-portable.exe';

let root: string;
let target: PortableTarget;
let download: string;
const running: ChildProcess[] = [];

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

async function runHelper(sha256: string, appPid: number, stubPid: number | null, noStart: boolean) {
  const launch = swapLaunch({ target, download, sha256, appPid, stubPid, noStart }, process.env);
  const helper = await startSwapHelper(launch, target.updates);
  return await exited(helper);
}

const log = () => {
  const path = join(target.updates, 'update.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

describe.skipIf(!windows)('portable swap helper on Windows', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "quqa swap ქუქა O'Brien's [1] "));
    const exe = join(root, 'quqa express ქუქა.exe');
    const checked = portableTarget(exe, root);
    if (!checked.ok) throw new Error(checked.reason);
    target = checked.value;
    mkdirSync(target.updates, { recursive: true });
    download = join(target.updates, NEW_NAME);
    copyFileSync(join(system32, 'PING.EXE'), target.exe);
  });

  afterEach(() => {
    for (const child of running.splice(0)) child.kill();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });

  it('waits for the running exe, swaps it under the same name and starts the new one', async () => {
    copyFileSync(join(system32, 'HOSTNAME.EXE'), download);
    writeFileSync(target.previous, 'an older previous.exe');
    // The "app": the old exe itself (a copy of node.exe; a renamed ping.exe
    // loses its language resources and exits at once), running for 3 s, so
    // its file is in use.
    copyFileSync(process.execPath, target.exe);
    const oldHash = await sha256File(target.exe);
    const newHash = await sha256File(download);
    const app = spawn(target.exe, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'ignore' });
    running.push(app);
    // The "stub": another process the helper must wait for.
    const stub = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' });
    running.push(stub);
    const started = Date.now();

    // Started the way main does, from a parent that exits at once (the app
    // quits right after): the helper must carry on without it.
    const launch = swapLaunch(
      { target, download, sha256: newHash, appPid: app.pid as number, stubPid: stub.pid as number },
      process.env,
    );
    await writeSwapScript(launch);
    const parent = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          "import { spawn } from 'node:child_process';",
          'const l = JSON.parse(process.env.QUQA_TEST_LAUNCH);',
          "import { readFileSync } from 'node:fs';",
          "const c = spawn(l.command, l.args, { env: l.env, cwd: l.cwd, stdio: 'ignore', windowsHide: true });",
          // Like startSwapHelper: wait for the helper's first log line, then exit at once.
          'const t = setInterval(() => {',
          "  let text = ''; try { text = readFileSync(l.env.QUQA_UPDATE_LOG, 'utf8'); } catch {}",
          '  if (text.includes(l.started)) { clearInterval(t); process.exit(0); }',
          '}, 100);',
        ].join('\n'),
      ],
      {
        stdio: 'ignore',
        env: {
          ...process.env,
          QUQA_TEST_LAUNCH: JSON.stringify({
            ...launch,
            cwd: target.updates,
            started: HELPER_STARTED,
          }),
        },
      },
    );
    expect(await exited(parent)).toBe(0);
    for (let i = 0; i < 120 && !log().includes('updated;'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(log()).toContain('updated; starting the new version');
    // The helper waited for the running exe before moving its file.
    expect(Date.now() - started).toBeGreaterThan(2500);
    expect(await sha256File(target.exe)).toBe(newHash);
    expect(await sha256File(target.previous)).toBe(oldHash);
    expect(existsSync(download)).toBe(false);
  }, 120_000);

  it.skipIf(!process.env['QUQA_TEST_PORTABLE_EXE'])('swaps in the built portable exe', async () => {
    copyFileSync(process.env['QUQA_TEST_PORTABLE_EXE'] as string, download);
    const oldHash = await sha256File(target.exe);
    const newHash = await sha256File(download);
    const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { stdio: 'ignore' });
    running.push(app);

    const code = await runHelper(newHash, app.pid as number, null, true);

    expect(code, log()).toBe(0);
    expect(await sha256File(target.exe)).toBe(newHash);
    expect(await sha256File(target.previous)).toBe(oldHash);
    expect(existsSync(download)).toBe(false);
  });

  it('changes nothing when the download does not match the checksum', async () => {
    copyFileSync(join(system32, 'HOSTNAME.EXE'), download);
    const oldHash = await sha256File(target.exe);
    const app = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await exited(app);

    const code = await runHelper('0'.repeat(64), app.pid as number, null, true);

    expect(code, log()).toBe(2);
    expect(await sha256File(target.exe)).toBe(oldHash);
    expect(existsSync(target.previous)).toBe(false);
    expect(existsSync(download)).toBe(false);
    expect(log()).toContain('does not match SHA256SUMS.txt');
  });

  it('puts the old exe back and starts it when the new one does not start', async () => {
    writeFileSync(download, 'not a program at all');
    const oldHash = await sha256File(target.exe);
    const app = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await exited(app);

    const code = await runHelper(await sha256File(download), app.pid as number, null, false);

    expect(code, log()).toBe(6);
    expect(await sha256File(target.exe)).toBe(oldHash);
    expect(log()).toContain('rolled back to the old exe');
  });
});
