/**
 * Entry point of the local terminal utilityProcess (ADR 0007). Main forks it
 * the first time the user opens a local terminal and talks to it over
 * `process.parentPort`; the renderer cannot reach it, and it holds no keys.
 */
import { loadNodePty } from './node-pty.js';
import { PtyEngine } from './pty-engine.js';

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  console.error('The local terminal process must run as an Electron utilityProcess');
  process.exit(1);
}

const engine = new PtyEngine(loadNodePty(), (event) => parentPort.postMessage(event));
parentPort.on('message', ({ data }) => engine.handle(data));
process.on('uncaughtException', (error) => {
  // Never log input or output: they are what the user typed and read.
  console.error('Local terminal error:', error.name);
});
process.on('unhandledRejection', (error) => {
  console.error('Local terminal error:', (error as Error | null)?.name ?? 'rejection');
});
