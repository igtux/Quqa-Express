/**
 * Main's half of the vault: turns the renderer's calls (AppCalls) into engine
 * calls, adding what only main can do — Electron safeStorage for the OS
 * wrapping key, file dialogs, the known_hosts location — and locks the vault
 * on idle time, sleep and screen lock.
 *
 * Main never sees the vault's data key or any item: safeStorage protects a
 * random 32-byte OS key, which main unwraps and hands to the engine to derive
 * the key-encryption key from (docs/adr/0002-vault.md).
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, clipboard, dialog, powerMonitor, safeStorage, type BrowserWindow } from 'electron';
import Value from 'typebox/value';
import type { EngineVaultStatus } from '../shared/engine-protocol.js';
import {
  AppCalls,
  type AppMethod,
  type AppSettings,
  type CallParams,
  type CallResult,
  type VaultMode,
  type VaultSettings,
  type VaultStatus,
} from '../shared/ipc.js';
import type { EngineHost } from './engine-host.js';
import type { Grants } from './grants.js';
import type { Updater } from './updater.js';

type Result = CallResult<unknown>;

const fail = (code: Extract<Result, { ok: false }>['code'], message: string): Result => ({
  ok: false,
  code,
  message,
});

export interface BrokerDeps {
  engine: EngineHost;
  vaultPath: string;
  window(): BrowserWindow | null;
  /** True if `requestId` (a host-key-changed token) belongs to a session of the caller. */
  ownsChange(requestId: string): boolean;
  /** Files the user picked or dropped, by token. */
  grants: Grants;
  /** Test hook: pretend the OS key store is missing. */
  forceNoOsKeyStore?: boolean;
  /** The app theme and the update check (settings.json, not the vault). */
  appSettings(): AppSettings;
  setAppSettings(change: CallParams<'app.setSettings'>): AppSettings;
  updater: Updater;
}

const usesOs = (mode: VaultMode) => mode !== 'password';

export class VaultBroker {
  private settings: VaultSettings | null = null;
  private state: VaultStatus['state'] = 'locked';
  /** Locked by the user or by idle/sleep: do not unlock with the OS key on its own. */
  private userLocked = false;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: BrokerDeps) {}

  /** The OS key store is usable (Linux's plain-text fallback does not count). */
  osAvailable(): boolean {
    if (this.deps.forceNoOsKeyStore) return false;
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux') {
      return safeStorage.getSelectedStorageBackend() !== 'basic_text';
    }
    return true;
  }

  /** Engine (re)started: open the vault and, for an OS-protected one, unlock it. */
  async engineStarted(): Promise<void> {
    const opened = await this.deps.engine.call('vault.open', { path: this.deps.vaultPath });
    if (!opened.ok) return;
    const status = await this.deps.engine.call('vault.status', {});
    if (!status.ok) return;
    this.state = status.value.state;
    if (status.value.state === 'locked' && status.value.mode === 'os' && !this.userLocked) {
      await this.unlockWith(status.value, undefined);
    }
  }

  vaultChanged(state: VaultStatus['state']): void {
    this.state = state;
    if (state !== 'unlocked') this.settings = null;
    else void this.status();
  }

  /** Watches idle time and power events. */
  watchIdle(): void {
    const lockFor = (reason: 'sleep' | 'idle') => {
      if (this.state !== 'unlocked') return;
      if (reason === 'sleep' && this.settings?.lockOnSleep === false) return;
      this.userLocked = true;
      void this.deps.engine.call('vault.lock', {});
    };
    powerMonitor.on('suspend', () => lockFor('sleep'));
    powerMonitor.on('lock-screen', () => lockFor('sleep'));
    this.idleTimer = setInterval(() => {
      const minutes = this.settings?.autoLockMinutes ?? 0;
      if (minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) lockFor('idle');
    }, 15_000);
    this.idleTimer.unref();
  }

  /** Handles one renderer call; the caller has checked the method and its parameters. */
  async handle<M extends AppMethod>(method: M, raw: CallParams<M>): Promise<Result> {
    const result = await this.run(method, raw).catch((error: unknown) => {
      console.error('Call failed:', method, (error as Error).name);
      return fail('engine', 'Something went wrong');
    });
    if (result.ok && !Value.Check(AppCalls[method].result, result.value)) {
      console.error('Answer failed its schema:', method);
      return fail('engine', 'Something went wrong');
    }
    return result;
  }

  private async run(method: AppMethod, raw: unknown): Promise<Result> {
    const engine = this.deps.engine;
    switch (method) {
      case 'vault.status':
        return this.status();
      case 'vault.create': {
        const params = raw as CallParams<'vault.create'>;
        const mode = this.chooseMode(params.password, params.portable);
        if (typeof mode !== 'string') return mode;
        const created = await engine.call('vault.create', {
          mode,
          ...(params.password !== undefined && { password: params.password }),
          ...(usesOs(mode) && newOsKey()),
        });
        if (!created.ok) return created;
        this.userLocked = false;
        return this.status();
      }
      case 'vault.unlock': {
        const params = raw as CallParams<'vault.unlock'>;
        const current = await engine.call('vault.status', {});
        if (!current.ok) return current;
        const unlocked = await this.unlockWith(current.value, params.password);
        return unlocked.ok ? this.status() : unlocked;
      }
      case 'vault.lock': {
        this.userLocked = true;
        const locked = await engine.call('vault.lock', {});
        return locked.ok ? this.status() : locked;
      }
      case 'vault.changePassword': {
        const params = raw as CallParams<'vault.changePassword'>;
        const current = await engine.call('vault.status', {});
        if (!current.ok) return current;
        const mode = this.chooseMode(params.password, params.portable);
        if (typeof mode !== 'string') return mode;
        // Keep the OS key when the vault already has one, so verification works.
        let os: { osKey: string; osBlob: string } | undefined;
        if (current.value.mode && usesOs(current.value.mode) && current.value.osBlob) {
          const osKey = this.unwrapOsKey(current.value.osBlob);
          if (!osKey)
            return fail('os_unavailable', 'The system key store could not open the vault');
          os = { osKey, osBlob: current.value.osBlob };
        } else if (usesOs(mode)) {
          os = newOsKey();
        }
        const rewrapped = await engine.call('vault.rewrap', {
          mode,
          ...(params.current !== undefined && { current: params.current }),
          ...(params.password !== undefined && { password: params.password }),
          ...os,
        });
        return rewrapped.ok ? this.status() : rewrapped;
      }
      case 'vault.updateSettings': {
        const updated = await engine.call(
          'vault.updateSettings',
          raw as CallParams<'vault.updateSettings'>,
        );
        return updated.ok ? this.status() : updated;
      }
      case 'vault.reset': {
        const reset = await engine.call('vault.reset', {});
        if (!reset.ok) return reset;
        this.userLocked = false;
        const status = await this.status();
        if (!status.ok) return status;
        return { ok: true, value: { backup: reset.value.backup, status: status.value } };
      }
      case 'app.settings':
        return { ok: true, value: this.deps.appSettings() };
      case 'app.setSettings':
        return {
          ok: true,
          value: this.deps.setAppSettings(raw as CallParams<'app.setSettings'>),
        };
      case 'updates.status':
        return { ok: true, value: this.deps.updater.state() };
      case 'updates.check':
        return { ok: true, value: await this.deps.updater.check() };
      case 'updates.install':
        return { ok: true, value: this.deps.updater.install() };
      case 'updates.cancel':
        return { ok: true, value: this.deps.updater.cancel() };
      case 'updates.restart':
        return { ok: true, value: await this.deps.updater.restart() };
      case 'updates.skip':
        return {
          ok: true,
          value: this.deps.updater.skip((raw as CallParams<'updates.skip'>).version),
        };
      case 'keys.list':
        return engine.call('keys.list', {});
      case 'keys.generate':
        return engine.call('keys.generate', raw as CallParams<'keys.generate'>);
      case 'keys.import':
        return engine.call('keys.import', raw as CallParams<'keys.import'>);
      case 'keys.delete':
        return engine.call('keys.delete', raw as CallParams<'keys.delete'>);
      case 'keys.importFile': {
        const params = raw as CallParams<'keys.importFile'>;
        const path = await this.openFile('Import a private key', join(homedir(), '.ssh'));
        if (!path) return { ok: true, value: { imported: null } };
        const imported = await engine.call('keys.importPath', { ...params, path });
        return imported.ok ? { ok: true, value: { imported: imported.value } } : imported;
      }
      case 'keys.exportPublic': {
        const { id } = raw as CallParams<'keys.exportPublic'>;
        const described = await engine.call('keys.describe', { id });
        if (!described.ok) return described;
        const window = this.deps.window();
        const name = `${described.value.label.replace(/[^\w.@-]+/g, '-') || 'key'}.pub`;
        const options = { title: 'Export public key', defaultPath: join(homedir(), name) };
        const choice = window
          ? await dialog.showSaveDialog(window, options)
          : await dialog.showSaveDialog(options);
        if (choice.canceled || !choice.filePath) return { ok: true, value: { saved: false } };
        try {
          await writeFile(choice.filePath, `${described.value.publicKey}\n`, { mode: 0o644 });
        } catch {
          return fail('io', 'The file could not be written');
        }
        return { ok: true, value: { saved: true } };
      }
      case 'hostKeys.list':
        return engine.call('hostKeys.list', {});
      case 'hostKeys.importKnownHosts': {
        const { chooseFile } = raw as CallParams<'hostKeys.importKnownHosts'>;
        // %USERPROFILE%\.ssh\known_hosts on Windows, ~/.ssh/known_hosts elsewhere.
        const standard = join(homedir(), '.ssh', 'known_hosts');
        const path = chooseFile ? await this.openFile('Import known_hosts', standard) : standard;
        if (!path) return { ok: true, value: { found: false, imported: 0, hashed: 0, skipped: 0 } };
        return engine.call('hostKeys.importPath', { path });
      }
      case 'hostKeys.forget':
        return engine.call('hostKeys.forget', raw as CallParams<'hostKeys.forget'>);
      case 'hostKeys.replace': {
        const params = raw as CallParams<'hostKeys.replace'>;
        if (!this.deps.ownsChange(params.requestId)) {
          return fail('not_found', 'That host-key change has expired; connect again');
        }
        return engine.call('hostKeys.replace', params);
      }
      case 'hosts.list':
        return engine.call('hosts.list', {});
      case 'hosts.save':
        return engine.call('hosts.save', raw as CallParams<'hosts.save'>);
      case 'hosts.delete':
        return engine.call('hosts.delete', raw as CallParams<'hosts.delete'>);
      case 'hosts.ping':
        return engine.call('hosts.ping', raw as CallParams<'hosts.ping'>);
      case 'sshConfig.preview': {
        const { chooseFile } = raw as CallParams<'sshConfig.preview'>;
        // %USERPROFILE%\.ssh\config on Windows, ~/.ssh/config elsewhere.
        const standard = join(homedir(), '.ssh', 'config');
        const path = chooseFile
          ? await this.openFile('Import an ssh config file', standard)
          : standard;
        if (!path) {
          return {
            ok: true,
            value: { found: false, token: '0'.repeat(32), entries: [], notes: [] },
          };
        }
        return engine.call('sshConfig.readPath', { path });
      }
      case 'sshConfig.import':
        return engine.call('sshConfig.import', raw as CallParams<'sshConfig.import'>);
      case 'ui.get':
        return engine.call('ui.get', {});
      case 'ui.save':
        return engine.call('ui.save', raw as CallParams<'ui.save'>);
      case 'hosts.setOsc52':
        return engine.call('hosts.setOsc52', raw as CallParams<'hosts.setOsc52'>);
      case 'files.list':
        return engine.call('files.list', raw as CallParams<'files.list'>);
      case 'files.mkdir':
        return engine.call('files.mkdir', raw as CallParams<'files.mkdir'>);
      case 'files.rename':
        return engine.call('files.rename', raw as CallParams<'files.rename'>);
      case 'files.delete':
        return engine.call('files.delete', raw as CallParams<'files.delete'>);
      case 'files.pickUpload': {
        const window = this.deps.window();
        const options = {
          title: 'Upload files',
          properties: ['openFile', 'multiSelections', 'dontAddToRecent'] as (
            'openFile' | 'multiSelections' | 'dontAddToRecent'
          )[],
        };
        const choice = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
        if (choice.canceled) return { ok: true, value: { files: [] } };
        return { ok: true, value: { files: await this.deps.grants.grant(choice.filePaths) } };
      }
      case 'files.upload': {
        const { grants, ...params } = raw as CallParams<'files.upload'>;
        const files = this.deps.grants.resolve(grants);
        if (!files) return fail('not_found', 'The chosen files have expired; choose them again');
        return engine.call('files.upload', { ...params, files });
      }
      case 'files.pasteClipboard':
        return this.pasteClipboard((raw as CallParams<'files.pasteClipboard'>).sessionId);
      case 'files.download': {
        const params = raw as CallParams<'files.download'>;
        const window = this.deps.window();
        const options = {
          title:
            params.paths.length === 1
              ? 'Download to…'
              : `Download ${params.paths.length} files to…`,
          defaultPath: app.getPath('downloads'),
          buttonLabel: 'Download here',
          properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] as (
            'openDirectory' | 'createDirectory' | 'dontAddToRecent'
          )[],
        };
        const choice = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
        const folder = choice.filePaths[0];
        if (choice.canceled || !folder) return { ok: true, value: { started: [] } };
        return engine.call('files.download', { ...params, folder });
      }
      case 'transfers.cancel':
        return engine.call('transfers.cancel', raw as CallParams<'transfers.cancel'>);
      case 'transfers.resume':
        return engine.call('transfers.resume', raw as CallParams<'transfers.resume'>);
      case 'forwards.start':
        return engine.call('forwards.start', raw as CallParams<'forwards.start'>);
      case 'forwards.stop':
        return engine.call('forwards.stop', raw as CallParams<'forwards.stop'>);
      case 'forwards.list':
        return engine.call('forwards.list', {});
      case 'agent.list':
        return engine.call('agent.list', raw as CallParams<'agent.list'>);
      case 'keys.install':
        return engine.call('keys.install', raw as CallParams<'keys.install'>);
    }
  }

  /**
   * Image paste: main reads the clipboard itself (the page never handles the
   * bytes). An image is written to a private temporary file and uploaded as
   * `clipboard_<time>.png`; copied files (Windows Explorer, or a file URI list)
   * are uploaded as they are. The engine answers once the uploads are done.
   */
  private async pasteClipboard(sessionId: string): Promise<Result> {
    const found = await readClipboardUpload();
    if (found.kind === 'image') {
      const folder = await mkdtemp(join(tmpdir(), 'quqa-paste-'));
      try {
        const name = `clipboard_${Date.now()}.${found.ext}`;
        const path = join(folder, name);
        await writeFile(path, found.bytes, { mode: 0o600 });
        const uploaded = await this.deps.engine.call('files.upload', {
          sessionId,
          directory: null,
          files: [{ path, name }],
          conflict: 'rename',
          wait: true,
        });
        return uploaded.ok
          ? {
              ok: true,
              value: {
                kind: 'image',
                paths: uploaded.value.paths,
                transfers: uploaded.value.started.map((t) => t.id),
              },
            }
          : uploaded;
      } finally {
        await rm(folder, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const granted = found.kind === 'files' ? await this.deps.grants.grant(found.paths) : [];
    const files = this.deps.grants.resolve(granted.map((g) => g.token)) ?? [];
    if (files.length === 0) return { ok: true, value: { kind: 'none', paths: [], transfers: [] } };
    const uploaded = await this.deps.engine.call('files.upload', {
      sessionId,
      directory: null,
      files: files.slice(0, 100),
      conflict: 'rename',
      wait: true,
    });
    return uploaded.ok
      ? {
          ok: true,
          value: {
            kind: 'files',
            paths: uploaded.value.paths,
            transfers: uploaded.value.started.map((t) => t.id),
          },
        }
      : uploaded;
  }

  private async status(): Promise<Result> {
    const status = await this.deps.engine.call('vault.status', {});
    if (!status.ok) return status;
    const { state, mode, settings } = status.value;
    this.state = state;
    this.settings = settings;
    const value: VaultStatus = { state, mode, osAvailable: this.osAvailable(), settings };
    return { ok: true, value };
  }

  private async unlockWith(status: EngineVaultStatus, password: string | undefined) {
    let osKey: string | undefined;
    if (status.mode && usesOs(status.mode)) {
      const unwrapped = status.osBlob ? this.unwrapOsKey(status.osBlob) : null;
      if (!unwrapped) {
        return fail(
          'os_unavailable',
          'The system key store could not open the vault (was it copied from another computer or account?)',
        );
      }
      osKey = unwrapped;
    }
    const unlocked = await this.deps.engine.call('vault.unlock', {
      ...(password !== undefined && { password }),
      ...(osKey !== undefined && { osKey }),
    });
    if (unlocked.ok) this.userLocked = false;
    return unlocked;
  }

  private chooseMode(
    password: string | undefined,
    portable: boolean | undefined,
  ): VaultMode | Result {
    if (password) return portable || !this.osAvailable() ? 'password' : 'os+password';
    if (this.osAvailable()) return 'os';
    return fail(
      'password_required',
      'This computer has no secure key store for the vault; set a master password',
    );
  }

  private unwrapOsKey(osBlob: string): string | null {
    if (!this.osAvailable()) return null;
    try {
      const osKey = safeStorage.decryptString(Buffer.from(osBlob, 'base64'));
      return /^[A-Za-z0-9+/]{43}=$/.test(osKey) ? osKey : null;
    } catch {
      return null;
    }
  }

  private async openFile(title: string, defaultPath: string): Promise<string | null> {
    const window = this.deps.window();
    const options = {
      title,
      defaultPath,
      properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'] as (
        'openFile' | 'showHiddenFiles' | 'dontAddToRecent'
      )[],
    };
    const choice = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return choice.canceled ? null : (choice.filePaths[0] ?? null);
  }
}

const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};
const MAX_PASTED_IMAGE_BYTES = 64 * 1024 * 1024;
/** Windows Explorer's list of copied files (UTF-16, NUL-separated). */
const FILE_NAME_W = 'electron application/osclipboard;format="FileNameW"';

type ClipboardUpload =
  | { kind: 'image'; bytes: Buffer; ext: string }
  | { kind: 'files'; paths: string[] }
  | { kind: 'none' };

/** An image on the clipboard, or files copied in the system file manager. */
async function readClipboardUpload(): Promise<ClipboardUpload> {
  let items: Awaited<ReturnType<typeof clipboard.read>>;
  try {
    items = await clipboard.read();
  } catch {
    return { kind: 'none' };
  }
  for (const item of items) {
    const type = item.types.find((t) => t in IMAGE_TYPES);
    if (!type) continue;
    try {
      const blob = (await item.getType(type)) as Blob;
      if (blob.size === 0 || blob.size > MAX_PASTED_IMAGE_BYTES) continue;
      return {
        kind: 'image',
        bytes: Buffer.from(await blob.arrayBuffer()),
        ext: IMAGE_TYPES[type] ?? 'png',
      };
    } catch {
      // Gone meanwhile.
    }
  }
  const paths: string[] = [];
  for (const item of items) {
    if (process.platform === 'win32') {
      try {
        const blob = (await item.getType(FILE_NAME_W)) as Blob;
        const text = Buffer.from(await blob.arrayBuffer()).toString('utf16le');
        paths.push(...text.split('\0').filter((p) => p.length > 0));
      } catch {
        // No copied files.
      }
    }
    if (paths.length === 0 && item.types.includes('text/uri-list')) {
      try {
        const list = await ((await item.getType('text/uri-list')) as Blob).text();
        for (const line of list.split(/\r?\n/)) {
          if (!line.startsWith('file://')) continue;
          try {
            paths.push(fileURLToPath(line.trim()));
          } catch {
            // Not a local file URI.
          }
        }
      } catch {
        // Gone meanwhile.
      }
    }
  }
  return paths.length > 0 ? { kind: 'files', paths: paths.slice(0, 100) } : { kind: 'none' };
}

/** A fresh OS key and its safeStorage encryption (Electron's DPAPI / Keychain / libsecret). */
function newOsKey(): { osKey: string; osBlob: string } {
  const osKey = randomBytes(32).toString('base64');
  const osBlob = safeStorage.encryptString(osKey).toString('base64');
  return { osKey, osBlob };
}
