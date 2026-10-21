/**
 * The update check (docs/adr/0006-update-check-themes-georgian.md): the one
 * network call besides SSH. At start and every 6 hours, if the user leaves
 * "Check for updates automatically" on, main reads this repository's GitHub
 * releases list and tells the window when a newer version is out. Nothing is
 * downloaded or run until the user clicks "Update now"; then the installed
 * build downloads the setup exe, checks its SHA-256 against the release's
 * SHA256SUMS.txt and starts it. The portable build downloads the new portable
 * exe next to itself, checks it the same way and, on "Restart to update",
 * swaps itself for it (src/main/portable-update.ts). Anything else, or a
 * portable exe in a folder it cannot write, opens the release page.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateState } from '../shared/ipc.js';
import type { SettingsFile } from './app-settings.js';
import {
  cleanUpdates,
  downloadPath,
  fileMatches,
  probeWritable,
  type PortableTarget,
} from './portable-update.js';
import {
  DOWNLOAD_HOSTS,
  RELEASES_API,
  expectedHash,
  pickUpdate,
  type Release,
  type ReleaseAsset,
} from './updates.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY = 8_000;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024;
const MAX_SETUP_BYTES = 600 * 1024 * 1024;

/** A verified portable exe, waiting for "Restart to update". */
export interface ReadyPortable {
  version: string;
  path: string;
  sha256: string;
}

export interface UpdaterDeps {
  settings: SettingsFile;
  current: string;
  method: UpdateState['method'];
  /**
   * The portable exe to replace (method 'portable'), or why this portable copy
   * cannot replace itself.
   */
  portable?: { target: PortableTarget } | { reason: string };
  openExternal(url: string): void;
  /** Runs the verified installer and quits the app. */
  runInstaller(path: string): void;
  /** Starts the swap helper for a verified portable exe and quits the app. */
  runPortableSwap?(ready: ReadyPortable, target: PortableTarget): Promise<void>;
  /** Tests: read the releases list from this file instead of GitHub. */
  releasesFile?: string;
  /** Tests: no network and no timer at all. */
  offline?: boolean;
}

class UpdateError extends Error {}

export class Updater {
  private checking = false;
  private checkedAt: number | null = null;
  private error: string | null = null;
  private release: Release | null = null;
  private phase: UpdateState['phase'] = 'idle';
  private progress: number | null = null;
  private timer: NodeJS.Timeout | undefined;
  private abort: AbortController | null = null;
  private ready: ReadyPortable | null = null;
  /** Why the portable copy cannot update itself (set when the folder is not writable). */
  private blocked: string | null = null;
  private probed = false;

  constructor(private readonly deps: UpdaterDeps) {
    const portable = deps.portable;
    if (portable && 'reason' in portable) this.blocked = portable.reason;
  }

  private target(): PortableTarget | null {
    const portable = this.deps.portable;
    return portable && 'target' in portable ? portable.target : null;
  }

  /** The first check shortly after start, then every 6 hours while the app runs. */
  start(): void {
    // Leftovers of an earlier portable update (never previous.exe).
    const target = this.target();
    if (target) void cleanUpdates(target.updates).catch(() => undefined);
    if (this.deps.offline && !this.deps.releasesFile) return;
    const first = setTimeout(() => this.automatic(), FIRST_CHECK_DELAY);
    first.unref();
    this.timer = setInterval(() => this.automatic(), SIX_HOURS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  state(): UpdateState {
    const r = this.release;
    return {
      current: this.deps.current,
      autoUpdate: this.deps.settings.get().autoUpdate,
      checking: this.checking,
      checkedAt: this.checkedAt,
      error: this.error,
      available:
        r && r.version !== this.deps.settings.get().skippedVersion
          ? { version: r.version, publishedAt: r.publishedAt, notes: r.notes, page: r.page }
          : null,
      method: this.method(),
      pageReason: this.method() === 'page' ? this.pageReason() : null,
      phase: this.phase,
      progress: this.progress,
    };
  }

  private method(): UpdateState['method'] {
    const r = this.release;
    if (this.deps.method === 'installer') {
      return r && (!r.setup || !r.sums) ? 'page' : 'installer';
    }
    if (this.deps.method === 'portable') {
      if (this.blocked || !this.target() || !this.deps.runPortableSwap) return 'page';
      return r && (!r.portable || !r.sums) ? 'page' : 'portable';
    }
    return 'page';
  }

  private pageReason(): string | null {
    if (this.deps.method === 'portable') {
      return this.blocked ?? 'This release has no portable exe with a checksum to update to.';
    }
    if (this.deps.method === 'installer') return 'This release has no installer with a checksum.';
    return null;
  }

  /** Once per run: can the portable exe's folder be written? */
  private async probe(): Promise<void> {
    const target = this.target();
    if (this.probed || !target || this.blocked) return;
    this.probed = true;
    if (!(await probeWritable(target))) {
      // Short and without the path: it is also shown as an error (200 characters at most).
      this.blocked =
        'quqa-express cannot write to the folder it runs from (a read-only drive, or a ' +
        'protected folder such as Program Files), so it cannot replace itself.';
    }
  }

  private automatic() {
    if (this.deps.settings.get().autoUpdate) void this.check();
  }

  async check(): Promise<UpdateState> {
    if (this.checking || this.phase !== 'idle') return this.state();
    this.checking = true;
    this.error = null;
    try {
      const list = await this.releases();
      this.release = pickUpdate(list, this.deps.current, this.deps.settings.get().skippedVersion);
      if (this.release) await this.probe();
    } catch (error) {
      this.error = error instanceof UpdateError ? error.message : 'Could not reach GitHub to check';
    } finally {
      this.checking = false;
      this.checkedAt = Date.now();
    }
    return this.state();
  }

  skip(version: string): UpdateState {
    this.deps.settings.update({ skippedVersion: version });
    return this.state();
  }

  /** "Update now". Resolves once the download starts (or the page opened); poll `state()`. */
  install(): UpdateState {
    const release = this.release;
    if (!release || this.phase !== 'idle') return this.state();
    const method = this.method();
    const asset = method === 'installer' ? release.setup : release.portable;
    if (method === 'page' || !asset || !release.sums) {
      this.deps.openExternal(release.page);
      return this.state();
    }
    this.error = null;
    this.phase = 'downloading';
    this.progress = 0;
    const abort = new AbortController();
    this.abort = abort;
    const job =
      method === 'installer'
        ? this.downloadAndRun(release, asset, release.sums, abort.signal)
        : this.downloadPortable(release, asset, release.sums, abort.signal);
    void job
      .catch((error: unknown) => {
        // A cancelled job, or one replaced by a newer "Update now", changes nothing.
        if (this.abort !== abort) return;
        this.error = abort.signal.aborted
          ? null
          : error instanceof UpdateError
            ? error.message
            : 'The update could not be downloaded';
        this.phase = 'idle';
        this.progress = null;
      })
      .finally(() => {
        if (this.abort === abort) this.abort = null;
      });
    return this.state();
  }

  /** Stops a running download, or drops a verified portable exe that was not applied. */
  cancel(): UpdateState {
    if (this.phase === 'downloading' || this.phase === 'verifying') {
      this.abort?.abort();
      this.abort = null;
      this.phase = 'idle';
      this.progress = null;
    } else if (this.phase === 'ready' && this.ready) {
      const { path } = this.ready;
      this.ready = null;
      this.phase = 'idle';
      this.progress = null;
      void rm(path, { force: true }).catch(() => undefined);
    }
    return this.state();
  }

  /** "Restart to update" (portable): check the file once more, start the helper, quit. */
  async restart(): Promise<UpdateState> {
    const ready = this.ready;
    const target = this.target();
    if (this.phase !== 'ready' || !ready || !target || !this.deps.runPortableSwap) {
      return this.state();
    }
    this.error = null;
    if (!(await fileMatches(ready.path, ready.sha256))) {
      this.ready = null;
      this.phase = 'idle';
      this.progress = null;
      this.error = 'The downloaded file changed after it was checked; nothing was run';
      return this.state();
    }
    this.phase = 'starting';
    try {
      await this.deps.runPortableSwap(ready, target);
    } catch {
      this.phase = 'ready';
      this.error = 'The update helper could not be started';
    }
    return this.state();
  }

  private async releases(): Promise<unknown> {
    if (this.deps.releasesFile) {
      return JSON.parse(await readFile(this.deps.releasesFile, 'utf8')) as unknown;
    }
    if (this.deps.offline) return [];
    const response = await fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `quqa-express/${this.deps.current}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 403 || response.status === 429) {
      throw new UpdateError('GitHub is limiting requests; try again later');
    }
    if (!response.ok) throw new UpdateError(`GitHub answered ${response.status}`);
    const text = await readLimited(response, MAX_LIST_BYTES);
    return JSON.parse(text.toString('utf8')) as unknown;
  }

  private async downloadAndRun(
    release: Release,
    setup: ReleaseAsset,
    sums: ReleaseAsset,
    signal: AbortSignal,
  ) {
    const folder = await mkdtemp(join(tmpdir(), 'quqa-update-'));
    const path = join(folder, setup.name);
    try {
      await this.downloadVerified(release, setup, sums, path, signal);
      this.phase = 'starting';
      this.progress = 1;
      this.deps.runInstaller(path);
    } catch (error) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Portable: the new exe goes next to the old one (same drive, so the swap is a rename). */
  private async downloadPortable(
    release: Release,
    exe: ReleaseAsset,
    sums: ReleaseAsset,
    signal: AbortSignal,
  ) {
    const target = this.target();
    if (!target) throw new UpdateError('This copy cannot update itself');
    await this.probe();
    if (this.blocked) throw new UpdateError(this.blocked);
    await cleanUpdates(target.updates);
    const path = downloadPath(target, exe.name);
    const partial = `${path}.partial`;
    try {
      const sha256 = await this.downloadVerified(release, exe, sums, partial, signal);
      if (signal.aborted) throw new UpdateError('Cancelled');
      await rename(partial, path);
      this.ready = { version: release.version, path, sha256 };
      this.phase = 'ready';
      this.progress = 1;
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Downloads `file` to `path`, refusing anything that does not match its size
   * and its line in SHA256SUMS.txt. Returns the checked SHA-256.
   */
  private async downloadVerified(
    release: Release,
    file: ReleaseAsset,
    sums: ReleaseAsset,
    path: string,
    signal: AbortSignal,
  ): Promise<string> {
    const sumsText = (await readLimited(await download(sums.url, signal), MAX_SUMS_BYTES)).toString(
      'utf8',
    );
    const expected = expectedHash(sumsText, file.name);
    if (!expected) throw new UpdateError(`The release lists no checksum for ${file.name}`);
    if (file.size > MAX_SETUP_BYTES) throw new UpdateError('The download is too large');

    const response = await download(file.url, signal);
    const hash = createHash('sha256');
    let received = 0;
    const out = createWriteStream(path, { mode: 0o700 });
    const done = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        received += value.byteLength;
        if (received > file.size || received > MAX_SETUP_BYTES) {
          throw new UpdateError('The download is larger than the release says');
        }
        hash.update(value);
        if (!out.write(value))
          await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        this.progress = received / file.size;
      }
    } catch (error) {
      done.catch(() => undefined);
      await reader.cancel().catch(() => undefined);
      // Closed before the caller removes the partial file (Windows keeps open files).
      if (!out.closed) {
        await new Promise<void>((resolve) => {
          out.once('close', () => resolve());
          out.destroy();
        });
      }
      throw error;
    }
    out.end();
    await done;
    this.phase = 'verifying';
    if (received !== file.size || hash.digest('hex') !== expected) {
      throw new UpdateError(
        `The download of ${release.version} does not match SHA256SUMS.txt; nothing was run`,
      );
    }
    return expected;
  }
}

/** GET a release asset; GitHub redirects to its download host, which must be one we know. */
async function download(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'quqa-express' },
    redirect: 'follow',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
  });
  const final = new URL(response.url || url);
  if (final.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(final.hostname)) {
    throw new UpdateError('The download was redirected somewhere unexpected');
  }
  if (!response.ok || !response.body) throw new UpdateError(`GitHub answered ${response.status}`);
  return response;
}

async function readLimited(response: Response, max: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > max) throw new UpdateError('GitHub sent more than expected');
  const chunks: Buffer[] = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new UpdateError('GitHub sent more than expected');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Starts the installer on its own (it outlives the app, which quits next). */
export function startInstaller(path: string): void {
  const child = spawn(path, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}
