/**
 * Loads node-pty and adapts it to `SpawnPty`. In the packaged app node-pty
 * lives in `app.asar.unpacked` (electron-builder `asarUnpack`): its native
 * modules, its worker thread and, on Windows, `conpty.dll` and
 * `OpenConsole.exe` must be real files. It is loaded from there by path, so
 * every file it finds next to itself is the unpacked one.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { unpackedPath } from '../engine/asar.js';
import type { PtyProcess, PtySpawnOptions, SpawnPty } from './pty-engine.js';

interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: PtySpawnOptions & { useConptyDll?: boolean; encoding?: string | null },
  ): PtyProcess;
}

interface AgentClass {
  prototype: { _getConsoleProcessList?: unknown; _innerPid?: number };
}

const nodeRequire = createRequire(import.meta.url);

export function loadNodePty(): SpawnPty {
  const entry = unpackedPath(nodeRequire.resolve('node-pty'));
  const pty = nodeRequire(entry) as NodePty;
  if (process.platform === 'win32') patchConsoleList(dirname(entry));
  return (file, args, options) => {
    if (process.platform !== 'win32')
      return pty.spawn(file, args, { ...options, encoding: 'utf8' });
    // The ConPTY that ships with node-pty (Windows Terminal's OpenConsole) first;
    // the one built into Windows if that cannot start.
    try {
      return pty.spawn(file, args, { ...options, useConptyDll: true });
    } catch {
      return pty.spawn(file, args, { ...options, useConptyDll: false });
    }
  };
}

/**
 * With Windows' own ConPTY, node-pty lists a closing console's processes in
 * a forked Node child. The packaged app cannot fork Node (the RunAsNode fuse
 * is off; it would start the app again), so closing kills the shell process
 * itself; ConPTY then ends the programs attached to its console.
 */
function patchConsoleList(lib: string) {
  try {
    const agent = (nodeRequire(join(lib, 'windowsPtyAgent.js')) as { WindowsPtyAgent?: AgentClass })
      .WindowsPtyAgent;
    if (!agent || typeof agent.prototype._getConsoleProcessList !== 'function') return;
    agent.prototype._getConsoleProcessList = function (this: { _innerPid?: number }) {
      const pid = this._innerPid ?? 0;
      return Promise.resolve(pid > 0 ? [pid] : []);
    };
  } catch {
    // A node-pty without that file: nothing to patch.
  }
}
