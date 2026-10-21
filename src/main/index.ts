/**
 * Electron main process: one hardened window, the SSH engine in a
 * utilityProcess, and a narrow IPC relay between them. Every message from the
 * renderer is schema-checked here and must come from our own window's main
 * frame. The renderer's files are served from app://quqa by our own protocol
 * handler (no file:// access).
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { release as osRelease } from 'node:os';
import { dirname, join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  Notification,
  protocol,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import Type, { type Static, type TSchema } from 'typebox';
import Value from 'typebox/value';
import { contentSecurityPolicy } from '../shared/csp.js';
import {
  AckMessage,
  AppCalls,
  Channel,
  ClipboardText,
  ConnectRequest,
  HostKeyAnswer,
  InputMessage,
  MAX_CLIPBOARD_LENGTH,
  NotifyMessage,
  PromptAnswer,
  ResizeMessage,
  SessionMessage,
  TmuxMessage,
  type AppMethod,
  type AppSettings,
  type AppTheme,
  type SessionEvent,
} from '../shared/ipc.js';
import { SettingsFile } from './app-settings.js';
import { EngineHost } from './engine-host.js';
import { Grants } from './grants.js';
import { hardenSessions } from './security.js';
import {
  APP_ENTRY,
  APP_SCHEME,
  contentTypeOf,
  externalUrl,
  isAppUrl,
  resolveAppPath,
} from './urls.js';
import { startInstaller, Updater } from './updater.js';
import { VaultBroker } from './vault-broker.js';
import { MIN_SIZE, placeWindow, readWindowState, writeWindowState } from './window-state.js';

declare const __APP_VERSION__: string;

const here = import.meta.dirname;
/** What the preload sends for dropped files: their local paths, checked again by Grants. */
const GrantPaths = Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 100 });
const devServerUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
const testHooks = process.env['QUQA_TEST_HOOKS'] === '1';

// The UI smoke test runs against a throw-away profile. The portable build
// keeps its profile (vault included) in a folder next to the .exe.
const testUserData = testHooks ? process.env['QUQA_USER_DATA'] : undefined;
const portableDir = process.env['PORTABLE_EXECUTABLE_DIR'];
if (testUserData) app.setPath('userData', testUserData);
else if (app.isPackaged && portableDir)
  app.setPath('userData', join(portableDir, 'quqa-express-data'));
else adoptEarlyProfile();

/**
 * Builds before 0.1.0 were called "Quqa Express", so their profile folder
 * was too. Copy that vault over once, if this profile has none yet.
 */
function adoptEarlyProfile() {
  const vault = join(app.getPath('userData'), 'vault.json');
  const early = join(dirname(app.getPath('userData')), 'Quqa Express', 'vault.json');
  try {
    if (existsSync(vault) || !existsSync(early)) return;
    mkdirSync(dirname(vault), { recursive: true });
    copyFileSync(early, vault);
  } catch {
    // The user can still create a new vault.
  }
}

/** Windows 11 22H2 and later draw acrylic behind a transparent window background. */
const materialSupported =
  process.platform === 'win32' && Number(osRelease().split('.')[2] ?? 0) >= 22621;
const usesMaterial = (theme: AppTheme) => materialSupported && theme === 'glass';
const SOLID_BACKGROUND = '#0a0a0f';

// Chromium's renderer sandbox for every renderer, before the app is ready.
app.enableSandbox();
// Windows shows desktop notifications only for an app with this id (electron-builder.yml appId).
if (process.platform === 'win32') app.setAppUserModelId('io.github.igtux.quqa-express');

// app:// behaves like https for the page (secure context, same-origin rules).
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  let window: BrowserWindow | null = null;
  let nextSession = 0;
  /** Sessions belong to the window that opened them. */
  const owners = new Map<string, number>();
  /** Open host-key prompts, credential prompts and host-key changes, and their session. */
  const prompts = new Map<string, string>();

  const vaultPath = join(app.getPath('userData'), 'vault.json');
  let broker: VaultBroker | null = null;
  const grants = new Grants();
  const settings = new SettingsFile(join(app.getPath('userData'), 'settings.json'));
  const appSettings = (): AppSettings => {
    const { theme, autoUpdate } = settings.get();
    return { theme, autoUpdate, material: usesMaterial(theme) };
  };
  const updater = new Updater({
    settings,
    current: __APP_VERSION__,
    // The NSIS install updates itself; the portable exe and other builds open the page.
    method: process.platform === 'win32' && app.isPackaged && !portableDir ? 'installer' : 'page',
    openExternal: (url) => {
      const safe = externalUrl(url);
      if (safe) void shell.openExternal(safe).catch(() => undefined);
    },
    runInstaller: (path) => {
      startInstaller(path);
      setTimeout(() => app.quit(), 500);
    },
    // Tests never reach GitHub; they may hand in a releases list instead.
    offline: testHooks,
    ...(testHooks && process.env['QUQA_TEST_RELEASES']
      ? { releasesFile: process.env['QUQA_TEST_RELEASES'] }
      : {}),
  });

  const engine = new EngineHost(join(here, 'engine.js'), {
    onEvent(event: SessionEvent) {
      // A closed session keeps its owner (the user may reconnect) until disconnect.
      const owner = owners.get(event.sessionId);
      if (
        event.type === 'host-key' ||
        event.type === 'prompt' ||
        event.type === 'host-key-changed'
      ) {
        prompts.set(event.requestId, event.sessionId);
      }
      const target = BrowserWindow.getAllWindows().find((w) => w.webContents.id === owner);
      target?.webContents.send(Channel.event, event);
    },
    onVaultState(state) {
      broker?.vaultChanged(state);
      window?.webContents.send(Channel.vaultEvent, state);
    },
    onStart() {
      void broker?.engineStarted();
    },
  });

  /** True if the message comes from our window's top frame showing our page. */
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const frame = event.senderFrame;
    return (
      window !== null &&
      event.sender === window.webContents &&
      frame !== null &&
      frame === window.webContents.mainFrame &&
      isAppUrl(frame.url, devServerUrl)
    );
  };

  const owns = (event: IpcMainEvent, sessionId: string) =>
    owners.get(sessionId) === event.sender.id;

  /** Registers a fire-and-forget channel; invalid or foreign messages are dropped. */
  function on<S extends TSchema>(
    channel: string,
    schema: S,
    handler: (event: IpcMainEvent, message: Static<S>) => void,
  ) {
    ipcMain.on(channel, (event, message: unknown) => {
      if (!trusted(event) || !Value.Check(schema, message)) return;
      handler(event, message);
    });
  }

  ipcMain.handle(Channel.connect, (event, request: unknown) => {
    if (!trusted(event)) throw new Error('Not allowed');
    if (!Value.Check(ConnectRequest, request)) throw new Error('Invalid connection details');
    const sessionId = `s${++nextSession}`;
    owners.set(sessionId, event.sender.id);
    engine.send({ type: 'connect', sessionId, request });
    return { sessionId };
  });

  ipcMain.handle(Channel.call, async (event, method: unknown, params: unknown) => {
    if (!trusted(event) || !broker) throw new Error('Not allowed');
    if (typeof method !== 'string' || !Object.hasOwn(AppCalls, method)) {
      return { ok: false, code: 'invalid_request', message: 'Unknown request' };
    }
    const name = method as AppMethod;
    if (!Value.Check(AppCalls[name].params, params)) {
      return { ok: false, code: 'invalid_request', message: 'Invalid request' };
    }
    // Calls about a session (files, transfers, forwards) only for the window that opened it.
    const sessionId = (params as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string' && owners.get(sessionId) !== event.sender.id) {
      return { ok: false, code: 'not_connected', message: 'The session is not connected' };
    }
    return broker.handle(name, params as never);
  });

  ipcMain.handle(Channel.grantFiles, async (event, paths: unknown) => {
    if (!trusted(event)) throw new Error('Not allowed');
    if (!Value.Check(GrantPaths, paths)) throw new Error('Invalid files');
    return grants.grant(paths);
  });

  on(Channel.input, InputMessage, (event, message) => {
    if (owns(event, message.sessionId)) engine.send({ type: 'input', ...message });
  });
  on(Channel.resize, ResizeMessage, (event, message) => {
    if (owns(event, message.sessionId)) engine.send({ type: 'resize', ...message });
  });
  on(Channel.ack, AckMessage, (event, message) => {
    if (owns(event, message.sessionId)) engine.send({ type: 'ack', ...message });
  });
  on(Channel.disconnect, SessionMessage, (event, { sessionId }) => {
    if (!owns(event, sessionId)) return;
    owners.delete(sessionId);
    for (const [requestId, owner] of prompts) if (owner === sessionId) prompts.delete(requestId);
    engine.send({ type: 'disconnect', sessionId });
  });
  on(Channel.reconnect, SessionMessage, (event, { sessionId }) => {
    if (owns(event, sessionId)) engine.send({ type: 'reconnect', sessionId });
  });
  on(Channel.hostKeyAnswer, HostKeyAnswer, (event, answer) => {
    const sessionId = prompts.get(answer.requestId);
    if (sessionId === undefined || !owns(event, sessionId)) return;
    prompts.delete(answer.requestId);
    engine.send({ type: 'host-key-answer', ...answer });
  });
  on(Channel.promptAnswer, PromptAnswer, (event, answer) => {
    const sessionId = prompts.get(answer.requestId);
    if (sessionId === undefined || !owns(event, sessionId)) return;
    prompts.delete(answer.requestId);
    engine.send({ type: 'prompt-answer', ...answer });
  });
  ipcMain.on(Channel.attention, (event) => {
    if (trusted(event) && window && !window.isFocused()) window.flashFrame(true);
  });
  on(Channel.tmux, TmuxMessage, (event, message) => {
    if (owns(event, message.sessionId)) engine.send({ type: 'tmux', message });
  });
  on(Channel.fullScreen, Type.Null(), () => {
    window?.setFullScreen(!window.isFullScreen());
  });
  ipcMain.on(Channel.openExternal, (event, text: unknown) => {
    const url = trusted(event) ? externalUrl(text) : null;
    if (url) void shell.openExternal(url).catch(() => undefined);
  });
  /** Only while the window is in the background; a click brings the terminal to the front. */
  const shown = new Set<Notification>();
  on(Channel.notify, NotifyMessage, (_event, message) => {
    if (!window || (window.isFocused() && window.isVisible()) || !Notification.isSupported()) {
      return;
    }
    window.flashFrame(true);
    const notification = new Notification({
      title: message.title || 'quqa-express',
      body: message.body,
      silent: true,
    });
    shown.add(notification);
    notification.on('click', () => {
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send(Channel.notificationClick, message.tag);
    });
    notification.on('close', () => shown.delete(notification));
    // Keep at most a few on screen.
    if (shown.size > 5) {
      const oldest = shown.values().next().value;
      oldest?.close();
      if (oldest) shown.delete(oldest);
    }
    notification.show();
  });

  ipcMain.handle(Channel.clipboardWrite, async (event, text: unknown) => {
    if (!trusted(event) || !Value.Check(ClipboardText, text)) throw new Error('Not allowed');
    await clipboard.writeText(text);
  });
  ipcMain.handle(Channel.clipboardRead, async (event) => {
    if (!trusted(event)) throw new Error('Not allowed');
    return (await clipboard.readText()).slice(0, MAX_CLIPBOARD_LENGTH);
  });

  /** Serves out/renderer at app://quqa/…; nothing outside it, nothing else. */
  function serveRenderer() {
    const root = join(here, '../renderer');
    const policy = contentSecurityPolicy(false);
    protocol.handle(APP_SCHEME, async (request) => {
      const file = request.method === 'GET' ? resolveAppPath(request.url, root) : null;
      if (!file) return new Response('Not found', { status: 404 });
      try {
        const body = await readFile(file);
        return new Response(body, {
          headers: {
            'Content-Type': contentTypeOf(file),
            'Content-Security-Policy': policy,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
  }

  const statePath = join(app.getPath('userData'), 'window-state.json');

  function createWindow() {
    const placed = placeWindow(
      readWindowState(statePath),
      screen.getAllDisplays().map((d) => d.workArea),
    );
    window = new BrowserWindow({
      ...placed.bounds,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      // The glass theme on Windows 11: acrylic shows through the page's tinted background.
      backgroundColor: usesMaterial(settings.get().theme) ? '#00000000' : SOLID_BACKGROUND,
      ...(usesMaterial(settings.get().theme) && { backgroundMaterial: 'acrylic' as const }),
      title: 'quqa-express',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(here, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
        devTools: !app.isPackaged,
        // Lets the UI smoke test read the terminal's text (WebGL draws no DOM text).
        ...(testHooks && { additionalArguments: ['--quqa-test-hooks'] }),
      },
    });
    window.once('ready-to-show', () => {
      if (placed.maximized) window?.maximize();
      window?.show();
    });
    // Remember size and place (the normal bounds, also while maximized).
    window.on('close', () => {
      if (!window || window.isFullScreen()) return;
      writeWindowState(statePath, {
        bounds: window.getNormalBounds(),
        maximized: window.isMaximized(),
      });
    });
    window.on('focus', () => window?.flashFrame(false));
    window.on('closed', () => {
      for (const [sessionId, owner] of owners) {
        if (owner === closedId) {
          owners.delete(sessionId);
          engine.send({ type: 'disconnect', sessionId });
        }
      }
      window = null;
    });
    const closedId = window.webContents.id;
    void window.loadURL(devServerUrl ?? APP_ENTRY);
  }

  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(
    () => {
      Menu.setApplicationMenu(null);
      hardenSessions(devServerUrl);
      serveRenderer();
      broker = new VaultBroker({
        engine,
        vaultPath,
        window: () => window,
        ownsChange: (requestId) => {
          const sessionId = prompts.get(requestId);
          return sessionId !== undefined && owners.has(sessionId);
        },
        grants,
        forceNoOsKeyStore: testHooks && process.env['QUQA_TEST_NO_OS_KEYSTORE'] === '1',
        appSettings,
        setAppSettings: (change) => {
          const before = settings.get();
          settings.update(change);
          const theme = settings.get().theme;
          if (materialSupported && window && theme !== before.theme) {
            window.setBackgroundMaterial(usesMaterial(theme) ? 'acrylic' : 'none');
            window.setBackgroundColor(usesMaterial(theme) ? '#00000000' : SOLID_BACKGROUND);
          }
          if (change.autoUpdate && !before.autoUpdate) void updater.check();
          return appSettings();
        },
        updater,
      });
      updater.start();
      broker.watchIdle();
      engine.start();
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    },
    (error: unknown) => {
      console.error('Start-up failed:', (error as Error).message);
      app.quit();
    },
  );

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    updater.stop();
    engine.stop();
  });
}
