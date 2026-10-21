/**
 * Entry point of the SSH engine utilityProcess. Main forks it at start-up and
 * talks to it over `process.parentPort`; the renderer cannot reach it.
 */
import type { SessionEvent } from '../shared/ipc.js';
import { Engine } from './engine.js';

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  console.error('The SSH engine must run as an Electron utilityProcess');
  process.exit(1);
}

const engine = new Engine((event: SessionEvent) => parentPort.postMessage(event));
parentPort.on('message', ({ data }) => engine.handle(data));
process.on('uncaughtException', (error) => {
  // Never log request contents: they may hold credentials.
  console.error('SSH engine error:', error.name, error.message);
});
