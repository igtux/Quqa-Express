/**
 * Uploads and downloads over a session's SFTP channel: streamed (multi-GB
 * files never sit in memory), with progress, cancel, and resume after a
 * dropped connection.
 *
 * Uploads follow Jarvis NG's resumable scheme (apps/ssh-gateway/src/files/
 * remote-files.ts, `partialSize` / `appendToPartial` / `completePartial`),
 * same owner: the bytes go into a partial file next to the destination, an
 * interrupted upload continues from that file's size, and only a complete
 * file is moved into place (replacing an existing one only when the user
 * agreed). The partial file's name carries a hash of the local file's path,
 * size and modification time, so uploading the same file again resumes it.
 * Downloads write `<name>.quqa-part` in the chosen folder and are renamed to
 * a free name when complete; a local file is never overwritten.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, rename, stat, unlink } from 'node:fs/promises';
import { join, parse as parsePath, posix } from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { TransferEvent } from '../shared/protocol.js';
import { CallError } from './errors.js';
import { sftpCall, type RemoteFiles } from './remote-files.js';

/** Transfers that run at once per session; the rest wait their turn. */
const PARALLEL_PER_SESSION = 3;
const PROGRESS_INTERVAL_MS = 250;
/** Finished transfers kept for `list` / resume. */
const MAX_KEPT = 200;

export type FilesFor = () => Promise<RemoteFiles>;

interface Job {
  info: TransferEvent;
  /** Upload: the local source. Download: unused until done (the final local path). */
  localPath: string;
  /** Upload: the remote folder. Download: the local folder. */
  folder: string;
  /** Upload: the remote partial file. Download: the local partial file. */
  partPath: string;
  /** Upload: replace an existing remote file. */
  overwrite: boolean;
  /** Download: the resolved remote file. */
  remotePath: string;
  /** Bytes already in the partial file are kept on the next run. */
  resumable: boolean;
  abort: AbortController | null;
  cancelled: boolean;
  waiters: ((info: TransferEvent) => void)[];
  lastEmit: number;
}

export class Transfers {
  private readonly jobs = new Map<string, Job>();
  private readonly queues = new Map<string, Job[]>();
  private readonly running = new Map<string, number>();
  private nextId = 0;

  constructor(
    private readonly emit: (info: TransferEvent) => void,
    /** True while the session's connection is up (a failure then is not a drop). */
    private readonly connected: (sessionId: string) => boolean,
    /** Tests only: limit each transfer to this many bytes per second. */
    private readonly throttle = 0,
  ) {}

  get(id: string): TransferEvent | null {
    return this.jobs.get(id)?.info ?? null;
  }

  /** Starts an upload of `localPath` as `directory/name` (both already checked by the caller). */
  upload(
    sessionId: string,
    filesFor: FilesFor,
    options: { localPath: string; name: string; directory: string; size: number; mtimeMs: number },
    overwrite: boolean,
  ): TransferEvent {
    const hash = createHash('sha256')
      .update(`${options.localPath}\n${options.size}\n${options.mtimeMs}`)
      .digest('hex')
      .slice(0, 12);
    const job = this.create(sessionId, 'upload', {
      name: options.name,
      remotePath: posix.join(options.directory, options.name),
      total: options.size,
    });
    job.localPath = options.localPath;
    job.folder = options.directory;
    job.partPath = posix.join(options.directory, partName(options.name, hash));
    job.overwrite = overwrite;
    job.resumable = true;
    this.enqueue(job, filesFor);
    return job.info;
  }

  /** Starts a download of the (resolved) remote file into the local `folder`. */
  download(
    sessionId: string,
    filesFor: FilesFor,
    options: { remotePath: string; folder: string; size: number },
  ): TransferEvent {
    const name = safeLocalName(posix.basename(options.remotePath));
    const job = this.create(sessionId, 'download', {
      name,
      remotePath: options.remotePath,
      total: options.size,
    });
    job.remotePath = options.remotePath;
    job.folder = options.folder;
    job.partPath = join(
      options.folder,
      `.${name.slice(0, 180)}.${randomBytes(3).toString('hex')}.quqa-part`,
    );
    this.enqueue(job, filesFor);
    return job.info;
  }

  /** Resolves when the transfer stops running (done, failed, cancelled or interrupted). */
  wait(id: string): Promise<TransferEvent> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new CallError('not_found', 'No such transfer'));
    if (job.info.state !== 'running') return Promise.resolve(job.info);
    return new Promise((resolve) => job.waiters.push(resolve));
  }

  cancel(sessionId: string, id: string, filesFor: FilesFor | null): void {
    const job = this.own(sessionId, id);
    if (job.info.state === 'done' || job.info.state === 'cancelled') return;
    job.cancelled = true;
    const wasRunning = job.abort !== null;
    job.abort?.abort();
    this.dequeue(job);
    this.finish(job, 'cancelled', '');
    if (!wasRunning) void this.discard(job, filesFor);
  }

  /** Runs an interrupted or failed transfer again, from where it stopped. */
  resume(sessionId: string, id: string, filesFor: FilesFor): void {
    const job = this.own(sessionId, id);
    if (job.info.state !== 'interrupted' && job.info.state !== 'failed') {
      throw new CallError('invalid_request', 'That transfer is not stopped');
    }
    job.cancelled = false;
    this.update(job, { state: 'running', error: '' }, true);
    this.enqueue(job, filesFor);
  }

  /** The session's connection is back: continue what the drop interrupted. */
  resumeSession(sessionId: string, filesFor: FilesFor): void {
    for (const job of this.jobs.values()) {
      if (job.info.sessionId === sessionId && job.info.state === 'interrupted') {
        this.update(job, { state: 'running', error: '' }, true);
        this.enqueue(job, filesFor);
      }
    }
  }

  /** The session's connection dropped: running transfers wait to resume. */
  interruptSession(sessionId: string): void {
    for (const job of this.jobs.values()) {
      if (job.info.sessionId !== sessionId || job.info.state !== 'running') continue;
      this.dequeue(job);
      if (job.abort) job.abort.abort(new InterruptedError());
      else this.finish(job, 'interrupted', 'Connection lost; continues when it reconnects');
    }
  }

  /** The session was closed for good: its transfers stop (partial files stay for a later resume). */
  dropSession(sessionId: string): void {
    for (const [id, job] of this.jobs) {
      if (job.info.sessionId !== sessionId) continue;
      if (job.info.state === 'running') {
        job.cancelled = true;
        this.dequeue(job);
        job.abort?.abort();
        this.finish(job, 'cancelled', 'The connection was closed');
      }
      this.jobs.delete(id);
    }
    this.queues.delete(sessionId);
    this.running.delete(sessionId);
  }

  /* ----- Running --------------------------------------------------------- */

  private create(
    sessionId: string,
    direction: 'upload' | 'download',
    fields: { name: string; remotePath: string; total: number },
  ): Job {
    const info: TransferEvent = {
      id: `x${++this.nextId}`,
      sessionId,
      direction,
      name: fields.name,
      remotePath: fields.remotePath,
      bytes: 0,
      total: fields.total,
      state: 'running',
      error: '',
    };
    const job: Job = {
      info,
      localPath: '',
      folder: '',
      partPath: '',
      overwrite: false,
      remotePath: '',
      resumable: false,
      abort: null,
      cancelled: false,
      waiters: [],
      lastEmit: 0,
    };
    this.jobs.set(info.id, job);
    this.prune();
    this.emit(info);
    return job;
  }

  private enqueue(job: Job, filesFor: FilesFor) {
    const sessionId = job.info.sessionId;
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(job);
    this.queues.set(sessionId, queue);
    this.pump(sessionId, filesFor);
  }

  private dequeue(job: Job) {
    const queue = this.queues.get(job.info.sessionId);
    if (!queue) return;
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
  }

  private pump(sessionId: string, filesFor: FilesFor) {
    const queue = this.queues.get(sessionId) ?? [];
    while ((this.running.get(sessionId) ?? 0) < PARALLEL_PER_SESSION && queue.length > 0) {
      const job = queue.shift();
      if (!job || job.info.state !== 'running') continue;
      this.running.set(sessionId, (this.running.get(sessionId) ?? 0) + 1);
      void this.run(job, filesFor).finally(() => {
        this.running.set(sessionId, Math.max(0, (this.running.get(sessionId) ?? 1) - 1));
        if (this.jobs.has(job.info.id)) this.pump(sessionId, filesFor);
      });
    }
  }

  private async run(job: Job, filesFor: FilesFor): Promise<void> {
    const abort = new AbortController();
    job.abort = abort;
    try {
      const files = await filesFor();
      if (abort.signal.aborted) throw abort.signal.reason ?? new Error('aborted');
      if (job.info.direction === 'upload') await this.runUpload(job, files, abort.signal);
      else await this.runDownload(job, files, abort.signal);
      job.abort = null;
      this.finish(job, 'done', '');
    } catch (error) {
      job.abort = null;
      if (job.cancelled) {
        // `cancel` already reported it; remove what was written.
        await this.discard(job, () => filesFor());
        return;
      }
      // A dropped connection fails streams a moment before it reports closing.
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (job.cancelled || job.info.state !== 'running') return;
      const dropped =
        !this.connected(job.info.sessionId) ||
        !(error instanceof CallError) ||
        error.code === 'not_connected';
      if (!dropped) {
        this.finish(job, 'failed', error.message.slice(0, 300));
      } else {
        // The connection (or a stream) broke: keep the partial file and resume later.
        job.resumable = true;
        this.finish(job, 'interrupted', 'Connection lost; continues when it reconnects');
      }
    }
  }

  private async runUpload(job: Job, files: RemoteFiles, signal: AbortSignal) {
    let local;
    try {
      local = await stat(job.localPath);
    } catch {
      throw new CallError('not_found', 'The local file is gone');
    }
    if (!local.isFile()) throw new CallError('invalid_request', 'Only files can be uploaded');
    if (local.size !== job.info.total) {
      // The file changed since it was chosen: start over with its new size.
      job.info.total = local.size;
    }
    if (!job.overwrite && (await files.lstatOrNull(job.info.remotePath))) {
      throw new CallError('exists', `"${job.info.name}" already exists on the host`);
    }
    let offset = job.resumable ? await files.sizeOrZero(job.partPath) : 0;
    if (offset > local.size) offset = 0;
    this.update(job, { bytes: offset }, true);
    const source = createReadStream(job.localPath, { start: offset });
    const target = files.sftp.createWriteStream(job.partPath, {
      flags: offset > 0 ? 'r+' : 'w',
      start: offset,
      mode: 0o600,
    });
    await this.pipe(job, source, target, signal);
    const size = await files.sizeOrZero(job.partPath);
    if (size !== local.size) {
      throw new CallError('io', `The host has ${size} of ${local.size} bytes; try again`);
    }
    await files.moveInto(job.partPath, job.info.remotePath, job.overwrite);
    await sftpCall((done) => files.sftp.chmod(job.info.remotePath, 0o644, done)).catch(
      () => undefined,
    );
  }

  private async runDownload(job: Job, files: RemoteFiles, signal: AbortSignal) {
    const remote = await files.lstatOrNull(job.remotePath);
    if (!remote) throw new CallError('not_found', 'The remote file is gone');
    let offset = 0;
    if (job.resumable) {
      try {
        offset = (await lstat(job.partPath)).size;
      } catch {
        offset = 0;
      }
      if (offset > remote.size) offset = 0;
    }
    job.info.total = remote.size;
    this.update(job, { bytes: offset }, true);
    const source = files.sftp.createReadStream(job.remotePath, { start: offset });
    const target = createWriteStream(job.partPath, {
      flags: offset > 0 ? 'r+' : 'w',
      start: offset,
      mode: 0o600,
    });
    await this.pipe(job, source, target, signal);
    const size = (await stat(job.partPath)).size;
    if (size !== remote.size) {
      throw new CallError('io', `Got ${size} of ${remote.size} bytes; try again`);
    }
    const final = await freeLocalName(job.folder, job.info.name);
    await rename(job.partPath, final);
    job.localPath = final;
    this.update(job, { name: parsePath(final).base }, true);
  }

  private async pipe(job: Job, source: Readable, target: Writable, signal: AbortSignal) {
    source.on('data', (chunk: Buffer) => {
      this.update(job, { bytes: job.info.bytes + chunk.length }, false);
    });
    try {
      if (this.throttle > 0) {
        const rate = this.throttle;
        const slow = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            setTimeout(() => done(null, chunk), Math.ceil((chunk.length / rate) * 1000));
          },
        });
        await pipeline(source, slow, target, { signal });
      } else {
        await pipeline(source, target, { signal });
      }
    } catch (error) {
      if (signal.reason instanceof InterruptedError) throw signal.reason;
      if (error instanceof Error && error.name === 'AbortError' && !job.cancelled) {
        throw new InterruptedError();
      }
      throw error;
    }
  }

  private async discard(job: Job, filesFor: FilesFor | null) {
    try {
      if (job.info.direction === 'download') await unlink(job.partPath);
      else if (filesFor) {
        const files = await filesFor();
        await sftpCall((done) => files.sftp.unlink(job.partPath, done));
      }
    } catch {
      // Nothing written yet, or the connection is gone: the partial file stays.
    }
  }

  private update(job: Job, change: Partial<TransferEvent>, force: boolean) {
    Object.assign(job.info, change);
    const now = Date.now();
    if (!force && now - job.lastEmit < PROGRESS_INTERVAL_MS) return;
    job.lastEmit = now;
    this.emit({ ...job.info });
  }

  private finish(job: Job, state: TransferEvent['state'], error: string) {
    if (job.info.state !== 'running' && state !== 'cancelled') return;
    if (job.info.state === state) return;
    if (state === 'done') job.info.bytes = job.info.total;
    this.update(job, { state, error }, true);
    const waiters = job.waiters.splice(0);
    for (const waiter of waiters) waiter({ ...job.info });
  }

  private own(sessionId: string, id: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.info.sessionId !== sessionId) {
      throw new CallError('not_found', 'No such transfer');
    }
    return job;
  }

  private prune() {
    if (this.jobs.size <= MAX_KEPT) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_KEPT) break;
      if (job.info.state === 'done' || job.info.state === 'cancelled') this.jobs.delete(id);
    }
  }
}

class InterruptedError extends Error {
  constructor() {
    super('interrupted');
    this.name = 'InterruptedError';
  }
}

/** `.name.quqa-<hash>.part`, within the 255-byte name limit. */
export function partName(name: string, hash: string): string {
  return `.${name.slice(0, 200)}.quqa-${hash}.part`;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A remote file name made safe for the local disk (Windows rules, the
 * strictest): no separators, no reserved characters or names, no trailing
 * dots or spaces. The result is always one plain name inside the folder.
 */
export function safeLocalName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let safe = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, '');
  if (safe === '' || safe === '.' || safe === '..') safe = 'download';
  if (WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
  return safe.slice(0, 200);
}

/** `name`, or `name (1).ext`, `name (2).ext`… whichever does not exist yet. */
export async function freeLocalName(folder: string, name: string): Promise<string> {
  const { name: stem, ext } = parsePath(name);
  for (let n = 0; n < 1000; n++) {
    const candidate = join(folder, n === 0 ? name : `${stem} (${n})${ext}`);
    try {
      await lstat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new CallError('exists', 'Too many files with that name in the folder');
}
