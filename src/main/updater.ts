/**
 * The update check (docs/adr/0006-update-check-themes-georgian.md): the one
 * network call besides SSH. At start and every 6 hours, if the user leaves
 * "Check for updates automatically" on, main reads this repository's GitHub
 * releases list and tells the window when a newer version is out. Nothing is
 * downloaded or run until the user clicks "Update now"; then the installed
 * build downloads the setup exe, checks its SHA-256 against the release's
 * SHA256SUMS.txt and starts it, and the portable build opens the release page.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateState } from '../shared/ipc.js';
import type { SettingsFile } from './app-settings.js';
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

export interface UpdaterDeps {
  settings: SettingsFile;
  current: string;
  method: UpdateState['method'];
  openExternal(url: string): void;
  /** Runs the verified installer and quits the app. */
  runInstaller(path: string): void;
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

  constructor(private readonly deps: UpdaterDeps) {}

  /** The first check shortly after start, then every 6 hours while the app runs. */
  start(): void {
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
      phase: this.phase,
      progress: this.progress,
    };
  }

  private method(): UpdateState['method'] {
    const r = this.release;
    if (this.deps.method !== 'installer' || (r && (!r.setup || !r.sums))) return 'page';
    return 'installer';
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
    if (this.method() === 'page' || !release.setup || !release.sums) {
      this.deps.openExternal(release.page);
      return this.state();
    }
    this.error = null;
    this.phase = 'downloading';
    this.progress = 0;
    void this.downloadAndRun(release, release.setup, release.sums).catch((error: unknown) => {
      this.error =
        error instanceof UpdateError ? error.message : 'The update could not be downloaded';
      this.phase = 'idle';
      this.progress = null;
    });
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

  private async downloadAndRun(release: Release, setup: ReleaseAsset, sums: ReleaseAsset) {
    const sumsText = (await readLimited(await download(sums.url), MAX_SUMS_BYTES)).toString('utf8');
    const expected = expectedHash(sumsText, setup.name);
    if (!expected) throw new UpdateError('The release lists no checksum for the installer');
    if (setup.size > MAX_SETUP_BYTES) throw new UpdateError('The installer is too large');

    const folder = await mkdtemp(join(tmpdir(), 'quqa-update-'));
    const path = join(folder, setup.name);
    try {
      const response = await download(setup.url);
      const hash = createHash('sha256');
      let received = 0;
      const out = createWriteStream(path, { mode: 0o700 });
      const done = new Promise<void>((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
      });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        received += value.byteLength;
        if (received > setup.size || received > MAX_SETUP_BYTES) {
          await reader.cancel();
          out.destroy();
          throw new UpdateError('The download is larger than the release says');
        }
        hash.update(value);
        if (!out.write(value))
          await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        this.progress = received / setup.size;
      }
      out.end();
      await done;
      this.phase = 'verifying';
      if (received !== setup.size || hash.digest('hex') !== expected) {
        throw new UpdateError(
          `The download of ${release.version} does not match SHA256SUMS.txt; nothing was run`,
        );
      }
      this.phase = 'starting';
      this.progress = 1;
      this.deps.runInstaller(path);
    } catch (error) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** GET a release asset; GitHub redirects to its download host, which must be one we know. */
async function download(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'quqa-express' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000),
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
