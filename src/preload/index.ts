/**
 * The only bridge between the page and the app: a handful of typed intents.
 * No Node or Electron objects reach the page; main validates every message.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { Channel } from '../shared/protocol.js';
import type { QuqaApi, SessionEvent, VaultState } from '../shared/ipc.js';

const api: QuqaApi = {
  connect: (request) => ipcRenderer.invoke(Channel.connect, request),
  input: (message) => ipcRenderer.send(Channel.input, message),
  resize: (message) => ipcRenderer.send(Channel.resize, message),
  ack: (message) => ipcRenderer.send(Channel.ack, message),
  disconnect: (sessionId) => ipcRenderer.send(Channel.disconnect, { sessionId }),
  reconnect: (sessionId) => ipcRenderer.send(Channel.reconnect, { sessionId }),
  answerHostKey: (answer) => ipcRenderer.send(Channel.hostKeyAnswer, answer),
  answerPrompt: (answer) => ipcRenderer.send(Channel.promptAnswer, answer),
  call: (method, params) => ipcRenderer.invoke(Channel.call, method, params),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, event: SessionEvent) => listener(event);
    ipcRenderer.on(Channel.event, handler);
    return () => {
      ipcRenderer.removeListener(Channel.event, handler);
    };
  },
  onVaultChange: (listener) => {
    const handler = (_event: IpcRendererEvent, state: VaultState) => listener(state);
    ipcRenderer.on(Channel.vaultEvent, handler);
    return () => {
      ipcRenderer.removeListener(Channel.vaultEvent, handler);
    };
  },
  clipboardWrite: (text) => ipcRenderer.invoke(Channel.clipboardWrite, text),
  clipboardRead: () => ipcRenderer.invoke(Channel.clipboardRead),
  attention: () => ipcRenderer.send(Channel.attention),
  tmux: (message) => ipcRenderer.send(Channel.tmux, message),
  notify: (message) => ipcRenderer.send(Channel.notify, message),
  onNotificationClick: (listener) => {
    const handler = (_event: IpcRendererEvent, tag: string) => listener(tag);
    ipcRenderer.on(Channel.notificationClick, handler);
    return () => {
      ipcRenderer.removeListener(Channel.notificationClick, handler);
    };
  },
  toggleFullScreen: () => ipcRenderer.send(Channel.fullScreen, null),
  grantFiles: async (files) => {
    // Only a real dropped file has a path; anything else gives '' or throws.
    const paths: string[] = [];
    for (const file of Array.from(files).slice(0, 100)) {
      try {
        const path = webUtils.getPathForFile(file);
        if (path) paths.push(path);
      } catch {
        // Not a File.
      }
    }
    return paths.length === 0 ? [] : ipcRenderer.invoke(Channel.grantFiles, paths);
  },
  testHooks: process.argv.includes('--quqa-test-hooks'),
};

contextBridge.exposeInMainWorld('quqa', api);
