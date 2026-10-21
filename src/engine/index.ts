/**
 * Entry point of the SSH engine utilityProcess. On Windows, programs inside
 * the packaged app.asar cannot be started (Electron redirects only
 * `execFile`), and ssh2 talks to Pageant through its bundled `pagent.exe`;
 * so `spawn` is pointed at the unpacked copy before ssh2 is loaded.
 */
import { spawnFromUnpacked } from './asar.js';

if (process.platform === 'win32') spawnFromUnpacked();
await import('./process.js');
