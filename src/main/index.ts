/**
 * Electron main process: one hardened window, the SSH engine in a
 * utilityProcess, and a narrow IPC relay between them. Every message from the
 * renderer is schema-checked here and must come from our own window's main
 * frame. The renderer's files are served from app://quqa by our own protocol
 * handler (no file:// access).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  protocol,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import type { Static, TSchema } from 'typebox';
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
  PromptAnswer,
  ResizeMessage,
  SessionMessage,
  type AppMethod,
  type SessionEvent,
} from '../shared/ipc.js';
import { EngineHost } from './engine-host.js';
import { hardenSessions } from './security.js';
import { APP_ENTRY, APP_SCHEME, contentTypeOf, isAppUrl, resolveAppPath } from './urls.js';
import { VaultBroker } from './vault-broker.js';

const here = import.meta.dirname;
const devServerUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
const testHooks = process.env['QUQA_TEST_HOOKS'] === '1';

// The UI smoke test runs against a throw-away profile.
const testUserData = testHooks ? process.env['QUQA_USER_DATA'] : undefined;
if (testUserData) app.setPath('userData', testUserData);

// Chromium's renderer sandbox for every renderer, before the app is ready.
app.enableSandbox();

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
    return broker.handle(name, params as never);
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

  function createWindow() {
    window = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 480,
      minHeight: 320,
      backgroundColor: '#0a0a0f',
      title: 'Quqa Express',
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
    window.once('ready-to-show', () => window?.show());
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
        forceNoOsKeyStore: testHooks && process.env['QUQA_TEST_NO_OS_KEYSTORE'] === '1',
      });
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
  app.on('before-quit', () => engine.stop());
}
