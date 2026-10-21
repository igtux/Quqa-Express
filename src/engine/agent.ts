/**
 * The user's own SSH agent: the Windows OpenSSH agent pipe, Pageant, or
 * SSH_AUTH_SOCK on macOS and Linux. The engine only asks the agent to sign
 * login challenges (ssh2 does that); keys never leave the agent, and the app
 * shows them by fingerprint only. Forwarding the agent to a server is a
 * separate per-host switch (ADR 0004).
 */
import ssh2, { type BaseAgent, type ParsedKey } from 'ssh2';
import type { AgentKey, AgentSource } from '../shared/ipc.js';
import { fingerprintOf } from './host-keys.js';

const { createAgent } = ssh2;

/** The Windows OpenSSH agent's named pipe. */
export const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';
const LIST_TIMEOUT_MS = 5000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

export type AgentLocation = { ok: true; path: string } | { ok: false; message: string };

/** Where the agent for `source` is on this computer, or why there is none. */
export function locateAgent(
  source: AgentSource,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AgentLocation {
  if (source === 'pageant') {
    return platform === 'win32'
      ? { ok: true, path: 'pageant' }
      : { ok: false, message: 'Pageant exists only on Windows' };
  }
  if (platform === 'win32') return { ok: true, path: WINDOWS_AGENT_PIPE };
  const socket = env['SSH_AUTH_SOCK'];
  if (!socket || socket.includes('\0')) {
    return { ok: false, message: 'No SSH agent is running (SSH_AUTH_SOCK is not set)' };
  }
  return { ok: true, path: socket };
}

export function agentFor(path: string): BaseAgent {
  return createAgent(path);
}

/** The agent's keys as fingerprints, for the host form and the Keys screen. */
export async function listAgentKeys(
  source: AgentSource,
  location: AgentLocation = locateAgent(source),
): Promise<{ available: boolean; message: string; keys: AgentKey[] }> {
  if (!location.ok) return { available: false, message: location.message, keys: [] };
  const agent = agentFor(location.path);
  try {
    const keys = await new Promise<ParsedKey[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), LIST_TIMEOUT_MS);
      agent.getIdentities((error, found) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve((found ?? []) as ParsedKey[]);
      });
    });
    return {
      available: true,
      message: keys.length === 0 ? 'The agent has no keys loaded' : '',
      keys: keys.slice(0, 100).map((key) => ({
        algorithm: String(key.type).slice(0, 64),
        fingerprint: fingerprintOf(key.getPublicSSH()),
        comment: String(key.comment ?? '')
          .replace(CONTROL, '')
          .slice(0, 200),
      })),
    };
  } catch {
    return {
      available: false,
      message:
        source === 'pageant'
          ? 'Pageant is not running'
          : 'The SSH agent did not answer (is it running?)',
      keys: [],
    };
  }
}
