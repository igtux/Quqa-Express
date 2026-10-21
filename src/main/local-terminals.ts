/**
 * Main's half of local terminals (ADR 0007): which shells exist, the default
 * shell setting, folders the user chose, and turning "open shell `pwsh`" into
 * a PTY spawn. Nothing the renderer sends becomes a program, an argument or
 * a path: it names a detected shell by id and a chosen folder by token.
 *
 * Image paste: main reads the clipboard itself (after a key press or click),
 * saves an image as `uploads/clipboard_<time>.png` in the profile folder and
 * hands back the local path to type; copied files are typed as they are.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import type {
  CallParams,
  CallResult,
  LocalOpenRequest,
  LocalShellInfo,
  ShellId,
} from '../shared/ipc.js';
import type { Grants } from './grants.js';
import {
  detectShells,
  shellArgs,
  shellEnvironment,
  systemShellEnvironment,
  type ShellSpec,
} from './local-shells.js';
import type { PtyHost } from './pty-host.js';
import { readClipboardUpload } from './vault-broker.js';

type Result = CallResult<unknown>;
export type LocalMethod =
  'local.shells' | 'local.chooseFolder' | 'local.pasteClipboard' | 'local.droppedPaths';

/** Pasted images older than this are removed when the next one is saved. */
const UPLOAD_MAX_AGE_MS = 7 * 24 * 3600_000;
const MAX_FOLDERS = 200;

export interface LocalDeps {
  pty: PtyHost;
  window(): BrowserWindow | null;
  grants: Grants;
  /** Where pasted images are saved (in the profile folder). */
  uploadsDir: string;
  /** The default shell the user chose (settings.json), or null. */
  defaultShell(): ShellId | null;
}

export class LocalTerminals {
  private detected: Promise<ShellSpec[]> | null = null;
  private readonly folders = new Map<string, string>();
  /** Sessions that are local terminals (input goes to the PTY process). */
  private readonly sessions = new Set<string>();

  constructor(private readonly deps: LocalDeps) {}

  /** The shells on this computer, detected once per run. */
  shells(): Promise<ShellSpec[]> {
    this.detected ??= detectShells(systemShellEnvironment()).catch(() => []);
    return this.detected;
  }

  isLocal(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** The renderer's open intent, already schema-checked; false if the shell is unknown. */
  async open(sessionId: string, request: LocalOpenRequest): Promise<boolean> {
    const shell = (await this.shells()).find((s) => s.id === request.shellId);
    if (!shell) return false;
    let cwd = homedir();
    if (request.folder !== null) {
      const folder = this.folders.get(request.folder);
      if (!folder) return false;
      cwd = folder;
    }
    this.sessions.add(sessionId);
    this.deps.pty.send({
      type: 'spawn',
      sessionId,
      file: shell.file,
      args: shellArgs(shell, { home: request.folder === null, platform: process.platform }),
      cwd,
      env: shellEnvironment(process.env),
      cols: request.cols,
      rows: request.rows,
    });
    return true;
  }

  /** The tab closed: end the shell. */
  close(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;
    this.deps.pty.send({ type: 'kill', sessionId });
  }

  async handle(method: LocalMethod, raw: unknown): Promise<Result> {
    switch (method) {
      case 'local.shells': {
        const shells = await this.shells();
        const list: LocalShellInfo[] = shells.map(({ id, name }) => ({ id, name }));
        const chosen = this.deps.defaultShell();
        const defaultShell = shells.find((s) => s.id === chosen)?.id ?? shells[0]?.id ?? null;
        return { ok: true, value: { shells: list, defaultShell } };
      }
      case 'local.chooseFolder':
        return { ok: true, value: { folder: await this.chooseFolder() } };
      case 'local.pasteClipboard': {
        const { sessionId } = raw as CallParams<'local.pasteClipboard'>;
        if (!this.sessions.has(sessionId)) {
          return { ok: false, code: 'not_connected', message: 'Not a local terminal' };
        }
        return { ok: true, value: await this.pasteClipboard() };
      }
      case 'local.droppedPaths': {
        const { grants } = raw as CallParams<'local.droppedPaths'>;
        const files = this.deps.grants.resolve(grants);
        if (!files) return { ok: false, code: 'not_found', message: 'Drop the files again' };
        return { ok: true, value: { paths: files.map((f) => f.path) } };
      }
    }
  }

  private async chooseFolder(): Promise<{ token: string; name: string } | null> {
    const window = this.deps.window();
    const options = {
      title: 'Open a local terminal in…',
      defaultPath: homedir(),
      buttonLabel: 'Open terminal here',
      properties: ['openDirectory', 'dontAddToRecent'] as ('openDirectory' | 'dontAddToRecent')[],
    };
    const choice = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const folder = choice.filePaths[0];
    if (choice.canceled || !folder) return null;
    try {
      if (!(await stat(folder)).isDirectory()) return null;
    } catch {
      return null;
    }
    const token = `d${randomBytes(12).toString('hex')}`;
    this.folders.set(token, folder);
    while (this.folders.size > MAX_FOLDERS) {
      const oldest = this.folders.keys().next().value;
      if (oldest === undefined) break;
      this.folders.delete(oldest);
    }
    // eslint-disable-next-line no-control-regex
    const name = (basename(folder) || folder).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
    return { token, name };
  }

  private async pasteClipboard(): Promise<CallValueOfPaste> {
    const found = await readClipboardUpload();
    if (found.kind === 'files') return { kind: 'files', paths: found.paths.slice(0, 100) };
    if (found.kind !== 'image') return { kind: 'none', paths: [] };
    const dir = this.deps.uploadsDir;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.pruneUploads(dir);
    const path = join(dir, `clipboard_${Date.now()}.${found.ext}`);
    await writeFile(path, found.bytes, { mode: 0o600, flag: 'wx' });
    return { kind: 'image', paths: [path] };
  }

  private async pruneUploads(dir: string) {
    const now = Date.now();
    for (const name of await readdir(dir).catch(() => [])) {
      if (!/^clipboard_\d+\.(png|jpg|gif|webp|bmp)$/.test(name)) continue;
      const file = join(dir, name);
      try {
        if (now - (await stat(file)).mtimeMs > UPLOAD_MAX_AGE_MS) await rm(file, { force: true });
      } catch {
        // Gone meanwhile.
      }
    }
  }
}

type CallValueOfPaste = { kind: 'none' | 'image' | 'files'; paths: string[] };
