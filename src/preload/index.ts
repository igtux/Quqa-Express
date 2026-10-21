/**
 * The only bridge between the page and the app: a handful of typed intents.
 * No Node or Electron objects reach the page; main validates every message.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channel } from '../shared/protocol.js';
import type { QuqaApi, SessionEvent } from '../shared/ipc.js';

const api: QuqaApi = {
  connect: (request) => ipcRenderer.invoke(Channel.connect, request),
  input: (message) => ipcRenderer.send(Channel.input, message),
  resize: (message) => ipcRenderer.send(Channel.resize, message),
  ack: (message) => ipcRenderer.send(Channel.ack, message),
  disconnect: (sessionId) => ipcRenderer.send(Channel.disconnect, { sessionId }),
  reconnect: (sessionId) => ipcRenderer.send(Channel.reconnect, { sessionId }),
  answerHostKey: (answer) => ipcRenderer.send(Channel.hostKeyAnswer, answer),
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, event: SessionEvent) => listener(event);
    ipcRenderer.on(Channel.event, handler);
    return () => {
      ipcRenderer.removeListener(Channel.event, handler);
    };
  },
  clipboardWrite: (text) => ipcRenderer.invoke(Channel.clipboardWrite, text),
  clipboardRead: () => ipcRenderer.invoke(Channel.clipboardRead),
  attention: () => ipcRenderer.send(Channel.attention),
  testHooks: process.argv.includes('--quqa-test-hooks'),
};

contextBridge.exposeInMainWorld('quqa', api);
