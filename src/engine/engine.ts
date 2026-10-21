/**
 * The SSH engine: one ssh2 connection with one PTY shell per session, plus
 * the vault, the key store and the host-key pins. Runs in an Electron
 * utilityProcess (see index.ts) and is plain Node, so tests drive it
 * directly.
 *
 * Secrets never arrive with `connect`: a session names a stored key by id or
 * asks for password login, and the engine takes the key from the vault or
 * asks the user through a `prompt` event (answered with `prompt-answer`).
 * A password or passphrase the user typed is kept for the session's life so
 * a lost connection can be re-opened, and dropped when the vault locks.
 *
 * Connection handling follows Jarvis NG's ConnectionPool
 * (apps/ssh-gateway/src/ssh/connection-pool.ts), same owner: strict host-key
 * checking, TCP_NODELAY, keepalives, error mapping. Unlike the gateway, an
 * unknown host key is shown to the user, who must accept it (trust on first
 * use); a changed key is refused until the user replaces the pin.
 *
 * A saved host may connect through jump hosts (jump.ts): every hop is a
 * saved host with its own login and pinned key, reached with `forwardOut`
 * over the hop before it. A connected session also carries SFTP (file
 * browser, uploads, downloads: remote-files.ts, transfers.ts) and port
 * forwards (forwards.ts); a `hold` session is a connection with no shell for
 * just those.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { basename, posix } from 'node:path';
import type { Duplex } from 'node:stream';
import ssh2, {
  type AuthHandlerMiddleware,
  type Client as SshClient,
  type ClientChannel,
  type ConnectConfig,
  type KeyboardInteractiveCallback,
  type Prompt,
  type SFTPWrapper,
  type ShellOptions,
} from 'ssh2';
import Value from 'typebox/value';
import {
  EngineCalls,
  EngineCommand,
  type EngineMethod,
  type EngineParams,
  type EngineReply,
  type EngineValue,
} from '../shared/engine-protocol.js';
import {
  HOST_PATTERN,
  USER_PATTERN,
  type AdhocConnect,
  type Auth,
  type ConnectRequest,
  type HostAction,
  type HostInfo,
  type KeyInfo,
  type PinInfo,
  type SessionEvent,
  type SshConfigEntry,
  type SshErrorCode,
  type TmuxMessage,
} from '../shared/ipc.js';
import type { PromptKind, TmuxSessionInfo, VaultState } from '../shared/protocol.js';
import { CONCURRENT_CALLS } from '../shared/engine-protocol.js';
import { agentFor, listAgentKeys, locateAgent } from './agent.js';
import { installAuthorizedKey } from './authorized-keys.js';
import { CallError } from './errors.js';
import { Forwards } from './forwards.js';
import { JumpError, resolveChain } from './jump.js';
import { RemoteFiles } from './remote-files.js';
import { assertValidName } from './remote-paths.js';
import { Transfers } from './transfers.js';
import {
  describeHostKey,
  fingerprintOf,
  hostKeyAlgorithmsFor,
  type PinnedHostKey,
} from './host-keys.js';
import { MAX_KNOWN_HOSTS_BYTES, parseKnownHosts } from './known-hosts-file.js';
import { KnownHosts, type KnownHostsData } from './known-hosts.js';
import { HostStore } from './hosts.js';
import { KeyStore, parsePrivateKey } from './keys.js';
import { mapLimit, tcpPing } from './latency.js';
import { parseSshConfig, type SshConfigHost } from './ssh-config.js';
import {
  attachCommand,
  historyScript,
  killCommand,
  listCommand,
  MAX_SCROLL_LINES,
  MAX_TMUX_SESSIONS,
  parseHistoryState,
  parseList,
  type HistoryAction,
} from './tmux.js';
import type { KdfParams } from './vault/crypto.js';
import { DEFAULT_SETTINGS, Vault } from './vault/vault.js';

// ssh2 is CommonJS: Node's ESM loader exposes only its default export.
const { Client } = ssh2;
type Client = SshClient;

export type EngineMessage = SessionEvent | EngineReply;

export interface EngineOptions {
  /** TCP connect + SSH handshake, not counting time the user spends on a prompt. */
  connectTimeoutMs?: number;
  /** How long a host-key or credential prompt waits for the user. */
  promptTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  maxSessions?: number;
  /** Argon2id parameters for new vault wraps (tests use small ones). */
  kdf?: KdfParams;
  /** Tests only: bytes per second for each upload or download (0: unlimited). */
  transferThrottle?: number;
}

/** Output not yet rendered by the terminal before the channel is paused. */
export const HIGH_WATER_BYTES = 1024 * 1024;
/** Paused output resumes once the terminal has caught up to this. */
export const LOW_WATER_BYTES = 256 * 1024;
/** Password (or passphrase) attempts per connection before giving up. */
const MAX_SECRET_ATTEMPTS = 3;
/** A "host key changed" token stays valid this long. */
const CHANGE_TOKEN_MS = 10 * 60_000;
const MAX_KEY_FILE_BYTES = 32 * 1024;
const MAX_SSH_CONFIG_BYTES = 1024 * 1024;
/** A parsed ~/.ssh/config waits this long for the user to choose what to import. */
const SSH_CONFIG_TOKEN_MS = 30 * 60_000;
/** tmux list / end / history commands. */
const EXEC_TIMEOUT_MS = 10_000;
const MAX_EXEC_OUTPUT = 256 * 1024;

const DEFAULTS: Required<Omit<EngineOptions, 'kdf'>> = {
  transferThrottle: 0,
  connectTimeoutMs: 20_000,
  promptTimeoutMs: 5 * 60_000,
  keepaliveIntervalMs: 15_000,
  keepaliveCountMax: 3,
  maxSessions: 32,
};

class SshError extends Error {
  constructor(
    readonly code: SshErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SshError';
  }
}

interface Session {
  id: string;
  /** Where to connect; for a saved host it is re-read from the vault on every attempt. */
  request: AdhocConnect;
  /** The saved host this session belongs to, or null for Quick Connect. */
  hostId: string | null;
  action: HostAction;
  /** The tmux session the terminal is attached to (null: plain shell). */
  tmux: string | null;
  /** The connect counter was raised for this session. */
  counted: boolean;
  history: { busy: boolean; scroll: number; queue: HistoryAction[] };
  cols: number;
  rows: number;
  client: Client | null;
  channel: ClientChannel | null;
  /** Connection attempt counter; events from older attempts are ignored. */
  generation: number;
  state: 'connecting' | 'ready' | 'closed';
  unacked: number;
  paused: boolean;
  /** Set once the user closed it; nothing more is emitted. */
  disposed: boolean;
  /** Passwords that last worked (or were typed) per hop, for reconnects. Dropped on lock. */
  passwords: Map<string, string>;
  /** Typed passwords (by saved-password id) to save in the vault once accepted. */
  remember: Set<string>;
  /** Connections to the jump hosts in front of `client`, first hop first. */
  jumps: Client[];
  /** The SFTP channel on `client`, opened on first use. */
  sftp: Promise<SFTPWrapper> | null;
  /** The saved host as last read (file roots, upload folder, agent forwarding). */
  host: HostInfo | null;
}

/** One hop of a connection: a jump host or the target itself. */
interface Hop {
  host: string;
  port: number;
  username: string;
  auth: Auth;
  /** How prompts and errors name it (`web-1`, `user@10.0.0.5`). */
  label: string;
  /** Not the target: errors are prefixed with "Jump host …". */
  jump: boolean;
  /** Forward the agent over this hop's shell (target only). */
  agentForward: boolean;
}

interface PendingHostKey {
  sessionId: string;
  resolve: (accept: boolean) => void;
}

type PromptReply = { answers: string[]; remember: boolean } | null;

interface PendingPrompt {
  sessionId: string;
  resolve: (answer: PromptReply) => void;
}

interface PromptText {
  title: string;
  message: string;
  prompts: { label: string; echo: boolean }[];
  canRemember: boolean;
}

interface ChangedKey {
  sessionId: string;
  host: string;
  port: number;
  key: PinnedHostKey;
  expires: number;
}

/** A saved password: vault item `password/<id>`. */
interface SavedPassword {
  host: string;
  port: number;
  username: string;
  password: string;
}

type Asking = <T>(ask: () => Promise<T>) => Promise<T>;
type Handlers = { [M in EngineMethod]: (params: EngineParams<M>) => Promise<EngineValue<M>> };

export class Engine {
  private readonly sessions = new Map<string, Session>();
  private readonly hostKeyPrompts = new Map<string, PendingHostKey>();
  private readonly prompts = new Map<string, PendingPrompt>();
  private readonly changedKeys = new Map<string, ChangedKey>();
  /** Passphrases typed this unlock, by key id. */
  private readonly passphrases = new Map<string, string>();
  private readonly options: Required<Omit<EngineOptions, 'kdf'>>;
  private readonly kdf: KdfParams | undefined;
  private vault: Vault | null = null;
  private keys: KeyStore | null = null;
  private hosts: HostStore | null = null;
  private sshConfig: { token: string; hosts: SshConfigHost[]; expires: number } | null = null;
  readonly knownHosts: KnownHosts;
  private readonly transfers: Transfers;
  private readonly forwards: Forwards;
  private nextPrompt = 0;
  /** Calls run one at a time, in order (opening the vault finishes before any status call). */
  private calls: Promise<void> = Promise.resolve();

  constructor(
    private readonly emit: (message: EngineMessage) => void,
    options: EngineOptions = {},
  ) {
    const { kdf, ...rest } = options;
    this.kdf = kdf;
    this.options = { ...DEFAULTS, ...rest };
    this.knownHosts = new KnownHosts((data) => this.saveKnownHosts(data));
    this.transfers = new Transfers(
      (transfer) => this.emit({ type: 'transfer', sessionId: transfer.sessionId, transfer }),
      (sessionId) => this.sessions.get(sessionId)?.state === 'ready',
      this.options.transferThrottle,
    );
    this.forwards = new Forwards((sessionId, forwards) =>
      this.emit({ type: 'forwards', sessionId, forwards }),
    );
  }

  /** Handles one command from main; anything that fails the schema is dropped. */
  handle(raw: unknown): void {
    if (!Value.Check(EngineCommand, raw)) return;
    const command = raw;
    switch (command.type) {
      case 'connect':
        this.connect(command.sessionId, command.request);
        break;
      case 'input':
        this.input(
          command.sessionId,
          Buffer.from(command.data, command.encoding === 'binary' ? 'latin1' : 'utf8'),
        );
        break;
      case 'resize':
        this.resize(command.sessionId, command.cols, command.rows);
        break;
      case 'ack':
        this.ack(command.sessionId, command.bytes);
        break;
      case 'disconnect':
        this.disconnect(command.sessionId);
        break;
      case 'reconnect':
        this.reconnect(command.sessionId);
        break;
      case 'host-key-answer':
        this.answerHostKey(command.requestId, command.accept);
        break;
      case 'prompt-answer':
        this.answerPrompt(command.requestId, command.answers, command.remember);
        break;
      case 'tmux':
        this.tmux(command.message);
        break;
      case 'call':
        if (CONCURRENT_CALLS.has(command.method)) {
          void this.dispatch(command.callId, command.method, command.params);
        } else {
          this.calls = this.calls.then(() =>
            this.dispatch(command.callId, command.method, command.params),
          );
        }
        break;
      case 'shutdown':
        this.shutdown();
        break;
    }
  }

  /* ----- Calls (vault, keys, host keys) ------------------------------------ */

  /** Runs a call directly (tests); main goes through `handle`. */
  async call<M extends EngineMethod>(method: M, params: EngineParams<M>): Promise<EngineValue<M>> {
    if (!Value.Check(EngineCalls[method].params, params)) {
      throw new CallError('invalid_request', 'Invalid request');
    }
    const handler = this.handlers[method] as (p: EngineParams<M>) => Promise<EngineValue<M>>;
    return handler(params);
  }

  private async dispatch(callId: number, method: string, params: unknown) {
    try {
      if (!Object.hasOwn(EngineCalls, method)) {
        throw new CallError('invalid_request', 'Unknown request');
      }
      const value = await this.call(method as EngineMethod, params as never);
      this.emit({ type: 'result', callId, ok: true, value });
    } catch (error) {
      const failure =
        error instanceof CallError ? error : new CallError('engine', 'Something went wrong');
      if (!(error instanceof CallError)) {
        // Never the message: it might quote input.
        console.error('Engine call failed:', method, (error as Error).name);
      }
      this.emit({
        type: 'result',
        callId,
        ok: false,
        code: failure.code,
        message: failure.message,
      });
    }
  }

  private readonly handlers: Handlers = {
    'vault.open': async ({ path }) => {
      if (this.vault?.path === path) return {};
      this.vault?.lock();
      const vault = new Vault(path, this.kdf ? { kdf: this.kdf } : {});
      await vault.load();
      vault.onChange((state) => this.vaultChanged(state));
      this.vault = vault;
      const keys = new KeyStore(vault);
      this.keys = keys;
      this.hosts = new HostStore(vault, (keyId) => keys.has(keyId));
      this.sshConfig = null;
      return {};
    },
    'vault.status': async () => {
      const vault = this.requireVault();
      const state = vault.state;
      return {
        state,
        mode: vault.mode,
        osBlob: vault.osBlob,
        settings:
          state === 'unlocked'
            ? (vault.get<typeof DEFAULT_SETTINGS>('settings', 'app') ?? DEFAULT_SETTINGS)
            : null,
      };
    },
    'vault.create': async (params) => {
      await this.requireVault().create(params);
      return {};
    },
    'vault.unlock': async (params) => {
      await this.requireVault().unlock(params);
      return {};
    },
    'vault.lock': async () => {
      this.requireVault().lock();
      return {};
    },
    'vault.rewrap': async (params) => {
      await this.requireVault().rewrap(params);
      return {};
    },
    'vault.updateSettings': async (settings) => {
      await this.requireUnlocked().put('settings', 'app', settings);
      return {};
    },
    'keys.list': async () => ({ keys: this.withUsage(this.requireKeys().list()) }),
    'keys.generate': async ({ label }) => this.requireKeys().generate(label),
    'keys.import': async ({ label, privateKey, passphrase, savePassphrase }) =>
      this.requireKeys().import(label, privateKey, passphrase, savePassphrase),
    'keys.importPath': async ({ label, path, passphrase, savePassphrase }) => {
      const keys = this.requireKeys();
      const text = await readSmallFile(
        path,
        MAX_KEY_FILE_BYTES,
        'That file is too large to be a private key',
      );
      return keys.import(label, text, passphrase, savePassphrase);
    },
    'keys.delete': async ({ id }) => {
      await this.requireKeys().delete(id);
      this.passphrases.delete(id);
      return {};
    },
    'keys.describe': async ({ id }) =>
      this.withUsage([this.requireKeys().describe(id)])[0] as KeyInfo,
    'hostKeys.list': async () => {
      this.requireUnlocked();
      const { pins, hashed } = this.knownHosts.list();
      const infos: PinInfo[] = pins.map((pin) => ({
        host: pin.host,
        port: pin.port,
        algorithm: pin.algorithm,
        fingerprint: fingerprintOf(Buffer.from(pin.key, 'base64')),
        source: pin.source,
        addedAt: pin.addedAt,
      }));
      return { pins: infos, hashed };
    },
    'hostKeys.importPath': async ({ path }) => {
      this.requireUnlocked();
      let text: string;
      try {
        text = await readSmallFile(
          path,
          MAX_KNOWN_HOSTS_BYTES,
          'The known_hosts file is too large',
        );
      } catch (error) {
        if (error instanceof CallError && error.code === 'not_found') {
          return { found: false, imported: 0, hashed: 0, skipped: 0 };
        }
        throw error;
      }
      const parsed = parseKnownHosts(text);
      const { imported, hashed } = await this.knownHosts.import(parsed);
      const skipped =
        parsed.skipped + (parsed.plain.length - imported) + (parsed.hashed.length - hashed);
      return { found: true, imported, hashed, skipped };
    },
    'hostKeys.forget': async ({ host, port }) => {
      this.requireUnlocked();
      await this.knownHosts.forget(unbracket(host), port);
      return {};
    },
    'hostKeys.replace': async ({ requestId }) => {
      this.requireUnlocked();
      const change = this.changedKeys.get(requestId);
      this.changedKeys.delete(requestId);
      if (!change || change.expires < Date.now()) {
        throw new CallError('not_found', 'That host-key change has expired; connect again');
      }
      await this.knownHosts.replace(change.host, change.port, change.key);
      return {};
    },
    'hosts.list': async () => ({ hosts: this.requireHosts().list() }),
    'hosts.save': async ({ id, host }) => this.requireHosts().save(id, host),
    'hosts.delete': async ({ id, forgetHostKey }) => {
      const hosts = this.requireHosts();
      const removed = await hosts.delete(id);
      const shared = hosts
        .list()
        .some((other) => other.address === removed.address && other.port === removed.port);
      if (forgetHostKey && !shared) await this.knownHosts.forget(removed.address, removed.port);
      return {};
    },
    'hosts.ping': async ({ ids }) => {
      const hosts = this.requireHosts();
      const results = await mapLimit([...new Set(ids)], 16, async (id) => {
        const host = hosts.get(id);
        if (!host) return { id, ms: null, error: 'Not saved' };
        return { id, ...(await tcpPing(host.address, host.port)) };
      });
      return { results };
    },
    'sshConfig.readPath': async ({ path }) => this.readSshConfig(path),
    'sshConfig.import': async (params) => this.importSshConfig(params),
    'ui.get': async () => this.requireHosts().ui(),
    'ui.save': async (state) => {
      await this.requireHosts().saveUi(state);
      return {};
    },
    'hosts.setOsc52': async ({ id, policy }) => this.requireHosts().setOsc52(id, policy),
    'files.list': async ({ sessionId, path }) => {
      const files = await this.filesOf(sessionId);
      const home = await files.home();
      const listed = await files.list(path ?? (await files.start()));
      return { ...listed, home, roots: [...files.roots] };
    },
    'files.mkdir': async ({ sessionId, parent, name }) =>
      (await this.filesOf(sessionId)).mkdir(parent, name),
    'files.rename': async ({ sessionId, from, toParent, toName, overwrite }) =>
      (await this.filesOf(sessionId)).rename(from, toParent, toName, overwrite),
    'files.delete': async ({ sessionId, path, recursive }) =>
      (await this.filesOf(sessionId)).delete(path, recursive),
    'files.upload': async (params) => this.upload(params),
    'files.download': async ({ sessionId, paths, folder }) => {
      const files = await this.filesOf(sessionId);
      const sources: { remotePath: string; size: number }[] = [];
      for (const path of paths) {
        const entry = await files.stat(path);
        if (entry.type !== 'file') {
          throw new CallError('invalid_request', `"${entry.name}" is not a file`);
        }
        sources.push({ remotePath: entry.path, size: entry.size });
      }
      const started = sources.map((source) =>
        this.transfers.download(sessionId, () => this.filesOf(sessionId), { ...source, folder }),
      );
      return { started: started.map((t) => ({ ...t })) };
    },
    'transfers.cancel': async ({ sessionId, id }) => {
      const session = this.sessions.get(sessionId);
      this.transfers.cancel(
        sessionId,
        id,
        session?.state === 'ready' ? () => this.filesOf(sessionId) : null,
      );
      return {};
    },
    'transfers.resume': async ({ sessionId, id }) => {
      await this.filesOf(sessionId);
      this.transfers.resume(sessionId, id, () => this.filesOf(sessionId));
      return {};
    },
    'forwards.start': async ({ sessionId, spec, savedId }) => {
      const session = this.readySession(sessionId);
      let chosen = spec;
      if (savedId !== undefined) {
        // A saved forward runs as saved, whatever the renderer sent.
        const saved = session.host?.forwards.find((f) => f.id === savedId);
        if (!saved) throw new CallError('not_found', 'That saved forward no longer exists');
        const { id: _id, auto: _auto, label: _label, ...savedSpec } = saved;
        chosen = savedSpec;
      }
      return this.forwards.start(sessionId, this.clientOf(session), chosen, {
        hostId: session.hostId,
        savedId: savedId ?? null,
      });
    },
    'forwards.stop': async ({ sessionId, id }) => {
      this.forwards.stop(sessionId, id);
      return {};
    },
    'forwards.list': async () => ({ forwards: this.forwards.list() }),
    'agent.list': async ({ agent }) => listAgentKeys(agent),
    'keys.install': async ({ sessionId, keyId }) => {
      const key = this.requireKeys().describe(keyId);
      const session = this.readySession(sessionId);
      if (session.host?.os === 'windows') {
        throw new CallError(
          'invalid_request',
          "Windows OpenSSH keeps administrators' keys elsewhere; add the key on the host by hand",
        );
      }
      return installAuthorizedKey(await this.sftpOf(session), key.publicKey);
    },
  };

  /* ----- Files and transfers ----------------------------------------------- */

  private readySession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed || session.state !== 'ready' || !session.client) {
      throw new CallError('not_connected', 'The session is not connected');
    }
    return session;
  }

  private clientOf(session: Session): Client {
    if (!session.client) throw new CallError('not_connected', 'The session is not connected');
    return session.client;
  }

  /** The session's SFTP channel, opened once per connection. */
  private sftpOf(session: Session): Promise<SFTPWrapper> {
    const client = this.clientOf(session);
    if (!session.sftp) {
      const opened = new Promise<SFTPWrapper>((resolve, reject) => {
        try {
          client.sftp((error, sftp) => {
            if (error) {
              reject(new CallError('io', 'The host does not offer SFTP'));
              return;
            }
            sftp.on('close', () => {
              if (session.sftp === opened) session.sftp = null;
            });
            resolve(sftp);
          });
        } catch {
          reject(new CallError('not_connected', 'The session is not connected'));
        }
      });
      opened.catch(() => {
        if (session.sftp === opened) session.sftp = null;
      });
      session.sftp = opened;
    }
    return session.sftp;
  }

  private async filesOf(sessionId: string): Promise<RemoteFiles> {
    const session = this.readySession(sessionId);
    return new RemoteFiles(await this.sftpOf(session), session.host?.fileRoots ?? []);
  }

  /** The host's upload folder (created if missing): its own, the first file root, or ~/uploads. */
  private async uploadFolder(session: Session, files: RemoteFiles): Promise<string> {
    const host = session.host;
    const folder = host?.uploadDir || host?.fileRoots[0] || '~/uploads';
    return files.ensureDirectory(folder);
  }

  private async upload(params: EngineParams<'files.upload'>) {
    const { sessionId, conflict } = params;
    const session = this.readySession(sessionId);
    const files = await this.filesOf(sessionId);
    const directory =
      params.directory === null
        ? await this.uploadFolder(session, files)
        : await files.resolveExisting(params.directory);
    const folder = await files.stat(directory);
    if (folder.type !== 'directory') throw new CallError('invalid_request', 'That is not a folder');
    const started: ReturnType<Transfers['upload']>[] = [];
    const conflicts: string[] = [];
    const paths: string[] = [];
    const taken = new Set<string>();
    for (const file of params.files) {
      assertValidName(file.name);
      let local;
      try {
        local = await stat(file.path);
      } catch {
        throw new CallError('not_found', `${file.name} is no longer on this computer`);
      }
      if (!local.isFile()) throw new CallError('invalid_request', `${file.name} is not a file`);
      let name = file.name;
      let overwrite = false;
      const exists =
        taken.has(name) || (await files.lstatOrNull(posix.join(directory, name))) !== null;
      if (exists) {
        if (conflict === 'ask') {
          conflicts.push(name);
          continue;
        }
        if (conflict === 'overwrite' && !taken.has(name)) overwrite = true;
        else name = await freeRemoteName(files, directory, name, taken);
      }
      taken.add(name);
      started.push(
        this.transfers.upload(
          sessionId,
          () => this.filesOf(sessionId),
          { localPath: file.path, name, directory, size: local.size, mtimeMs: local.mtimeMs },
          overwrite,
        ),
      );
      paths.push(posix.join(directory, name));
    }
    const snapshot = started.map((t) => ({ ...t }));
    if (params.wait) {
      const results = await Promise.all(started.map((t) => this.transfers.wait(t.id)));
      const failed = results.find((r) => r.state !== 'done');
      if (failed) {
        throw new CallError(
          'io',
          `The upload of ${failed.name} did not finish${failed.error ? `: ${failed.error}` : ''}`,
        );
      }
    }
    return { started: snapshot, conflicts, paths };
  }

  private withUsage(keys: KeyInfo[]): KeyInfo[] {
    const usage = this.hosts?.keyUsage() ?? new Map<string, number>();
    return keys.map((key) => ({ ...key, usedBy: usage.get(key.id) ?? 0 }));
  }

  private requireHosts(): HostStore {
    this.requireUnlocked();
    if (!this.hosts) throw new CallError('engine', 'The vault is not open');
    return this.hosts;
  }

  /* ----- ~/.ssh/config import ---------------------------------------------- */

  private async readSshConfig(path: string) {
    const hosts = this.requireHosts();
    const token = randomBytes(16).toString('hex');
    let text: string;
    try {
      text = await readSmallFile(path, MAX_SSH_CONFIG_BYTES, 'The ssh config file is too large');
    } catch (error) {
      if (error instanceof CallError && error.code === 'not_found') {
        this.sshConfig = null;
        return { found: false, token, entries: [], notes: [] };
      }
      throw error;
    }
    const parsed = parseSshConfig(text, { home: homedir(), localUser: localUser() });
    this.sshConfig = { token, hosts: parsed.hosts, expires: Date.now() + SSH_CONFIG_TOKEN_MS };
    const saved = hosts.list();
    const entries: SshConfigEntry[] = parsed.hosts.slice(0, 1000).map((entry) => ({
      alias: entry.alias.slice(0, 255),
      hostName: entry.hostName.slice(0, 255),
      user: entry.user.slice(0, 64),
      port: entry.port >= 1 && entry.port <= 65535 ? entry.port : 22,
      identityFile: entry.identityFile.slice(0, 4096),
      proxyJump: clean(entry.proxyJump, 255),
      problem: configProblem(entry),
      duplicate: saved.some(
        (host) =>
          host.address.toLowerCase() === entry.hostName.toLowerCase() &&
          host.port === entry.port &&
          host.username === entry.user,
      ),
    }));
    return { found: true, token, entries, notes: parsed.notes.map((n) => clean(n, 300)) };
  }

  private async importSshConfig(params: {
    token: string;
    aliases: string[];
    importKeys: boolean;
    tmux: boolean;
  }) {
    const hosts = this.requireHosts();
    const keys = this.requireKeys();
    const preview = this.sshConfig;
    if (!preview || preview.token !== params.token || preview.expires < Date.now()) {
      throw new CallError('not_found', 'The ssh config preview has expired; read the file again');
    }
    const problems: string[] = [];
    const keyByPath = new Map<string, string | null>();
    let imported = 0;
    let importedKeys = 0;
    const known = () => new Map(keys.list().map((key) => [key.fingerprint, key.id]));

    for (const alias of new Set(params.aliases)) {
      const entry = preview.hosts.find((host) => host.alias === alias);
      if (!entry || configProblem(entry)) continue;
      let keyId: string | null = null;
      if (params.importKeys && entry.identityFile) {
        if (!keyByPath.has(entry.identityFile)) {
          let id: string | null = null;
          try {
            const text = await readSmallFile(
              entry.identityFile,
              MAX_KEY_FILE_BYTES,
              'That file is too large to be a private key',
            );
            const before = known();
            const label = clean(basename(entry.identityFile), 64) || 'imported key';
            const info = await keys.import(label, text, undefined, false);
            const existing = before.get(info.fingerprint);
            if (existing) {
              // The same key is already in the vault: keep one copy.
              await keys.delete(info.id);
              id = existing;
            } else {
              id = info.id;
              importedKeys++;
            }
          } catch (error) {
            const reason =
              error instanceof CallError && error.code === 'needs_passphrase'
                ? 'is protected by a passphrase; import it under Keys'
                : error instanceof CallError && error.code === 'not_found'
                  ? 'was not found'
                  : 'could not be imported';
            problems.push(
              clean(
                `${alias}: the key ${entry.identityFile} ${reason}; the host logs in with a password for now`,
                300,
              ),
            );
          }
          keyByPath.set(entry.identityFile, id);
        }
        keyId = keyByPath.get(entry.identityFile) ?? null;
      }
      await hosts.save(undefined, {
        name: configLabel(alias),
        address: entry.hostName,
        port: entry.port,
        username: entry.user,
        auth: keyId ? { kind: 'key', keyId } : { kind: 'password' },
        os: 'linux',
        group: '',
        tags: ['ssh-config'],
        notes: '',
        color: '',
        tmux: params.tmux,
        jumpHostId: null,
        proxyJump: clean(entry.proxyJump, 255),
        scheme: '',
        font: '',
        agentForward: false,
        fileRoots: [],
        uploadDir: '',
        osc52: 'ask',
        forwards: [],
      });
      imported++;
    }
    return { hosts: imported, keys: importedKeys, problems: problems.slice(0, 1000) };
  }

  private requireVault(): Vault {
    if (!this.vault) throw new CallError('engine', 'The vault is not open');
    return this.vault;
  }

  private requireUnlocked(): Vault {
    const vault = this.requireVault();
    if (vault.state !== 'unlocked') throw new CallError('locked', 'The vault is locked');
    return vault;
  }

  private requireKeys(): KeyStore {
    this.requireUnlocked();
    if (!this.keys) throw new CallError('engine', 'The vault is not open');
    return this.keys;
  }

  private vaultChanged(state: VaultState) {
    if (state === 'unlocked') {
      this.knownHosts.load(this.vault?.get<KnownHostsData>('known-hosts', 'pins') ?? null);
    } else {
      // Locked: forget every secret held outside the vault.
      this.knownHosts.clear();
      this.passphrases.clear();
      this.changedKeys.clear();
      for (const session of this.sessions.values()) {
        session.passwords.clear();
        session.remember.clear();
      }
      for (const requestId of [...this.prompts.keys()]) this.answerPrompt(requestId, null, false);
      for (const requestId of [...this.hostKeyPrompts.keys()]) this.answerHostKey(requestId, false);
    }
    this.emit({ type: 'vault-state', state });
  }

  private async saveKnownHosts(data: KnownHostsData) {
    await this.requireUnlocked().put('known-hosts', 'pins', data);
  }

  /* ----- Sessions ---------------------------------------------------------- */

  connect(sessionId: string, request: ConnectRequest): void {
    if (this.sessions.has(sessionId)) return;
    const saved = 'hostId' in request;
    if (this.sessions.size >= this.options.maxSessions) {
      this.emit({
        type: 'error',
        sessionId,
        code: 'too_many_sessions',
        message: `At most ${this.options.maxSessions} sessions can be open at once`,
      });
      this.emit({ type: 'closed', sessionId, exitCode: null });
      return;
    }
    const session: Session = {
      id: sessionId,
      request: saved
        ? // Filled in from the saved host by `open`.
          {
            host: 'localhost',
            port: 22,
            username: 'x',
            auth: { kind: 'password' },
            cols: 2,
            rows: 1,
          }
        : request,
      hostId: saved ? request.hostId : null,
      action: saved ? request.action : { type: 'shell', tmux: null },
      tmux: null,
      counted: false,
      history: { busy: false, scroll: 0, queue: [] },
      cols: request.cols,
      rows: request.rows,
      client: null,
      channel: null,
      generation: 0,
      state: 'closed',
      unacked: 0,
      paused: false,
      disposed: false,
      passwords: new Map(),
      remember: new Set(),
      jumps: [],
      sftp: null,
      host: null,
    };
    this.sessions.set(sessionId, session);
    void this.open(session);
  }

  reconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // E.g. the engine restarted: the session is gone with it.
      this.emit({
        type: 'error',
        sessionId,
        code: 'invalid_request',
        message: 'This session is no longer available; connect again',
      });
      this.emit({ type: 'closed', sessionId, exitCode: null });
      return;
    }
    if (session.disposed || session.state !== 'closed') return;
    void this.open(session);
  }

  input(sessionId: string, bytes: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (session?.state !== 'ready' || !session.channel) return;
    // ssh2 queues the bytes when the channel window is full; pastes arrive
    // in slices from the renderer, so the queue stays small.
    session.channel.write(bytes);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cols = cols;
    session.rows = rows;
    if (session.state === 'ready') session.channel?.setWindow(rows, cols, 0, 0);
  }

  /** The renderer has drawn `bytes` more output: resume a paused channel when it caught up. */
  ack(sessionId: string, bytes: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.unacked = Math.max(0, session.unacked - bytes);
    if (session.paused && session.unacked <= LOW_WATER_BYTES) {
      session.paused = false;
      session.channel?.resume();
    }
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.disposed = true;
    this.sessions.delete(sessionId);
    this.cancelPrompts(sessionId);
    this.forwards.drop(sessionId);
    this.transfers.dropSession(sessionId);
    this.teardown(session);
    session.passwords.clear();
    this.emit({ type: 'closed', sessionId, exitCode: null });
  }

  answerHostKey(requestId: string, accept: boolean): void {
    const prompt = this.hostKeyPrompts.get(requestId);
    if (!prompt) return;
    this.hostKeyPrompts.delete(requestId);
    prompt.resolve(accept);
  }

  answerPrompt(requestId: string, answers: string[] | null, remember: boolean): void {
    const prompt = this.prompts.get(requestId);
    if (!prompt) return;
    this.prompts.delete(requestId);
    prompt.resolve(answers ? { answers, remember } : null);
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id);
    this.vault?.lock();
  }

  /** Sessions currently held (for tests and diagnostics). */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /* ----- Connecting -------------------------------------------------------- */

  private async open(session: Session): Promise<void> {
    const generation = ++session.generation;
    session.state = 'connecting';
    session.unacked = 0;
    session.paused = false;
    session.tmux = null;
    const current = () => !session.disposed && session.generation === generation;

    try {
      const host = this.resolveHost(session);
      const client = await this.connectChain(session, current, host);
      if (!current()) {
        client.end();
        this.endJumps(session);
        return;
      }
      const { action } = session;
      const tmuxUsable = host !== null && host.tmux && host.os === 'linux';
      if (action.type === 'hold') {
        this.attach(session, generation, client, null);
        return;
      }
      if (action.type !== 'shell') {
        // A one-shot connection: (end a session,) list them, report, close.
        if (action.type === 'end') await this.exec(client, killCommand(action.session));
        const listed = tmuxUsable
          ? parseList((await this.exec(client, listCommand())).stdout)
          : { available: false, sessions: [] };
        client.end();
        this.endJumps(session);
        if (!current()) return;
        this.emitSessions(session.id, listed.available, listed.sessions);
        session.state = 'closed';
        session.client = null;
        this.emit({ type: 'closed', sessionId: session.id, exitCode: 0 });
        return;
      }

      let command: string | null = null;
      if (tmuxUsable && action.tmux !== null) {
        const listed = parseList((await this.exec(client, listCommand())).stdout);
        if (!current()) {
          client.end();
          return;
        }
        this.emitSessions(session.id, listed.available, listed.sessions);
        if (listed.available) {
          const exists = listed.sessions.some((s) => s.name === action.tmux);
          if (!exists && listed.sessions.length >= MAX_TMUX_SESSIONS) {
            client.end();
            throw new SshError(
              'too_many_sessions',
              `This host already has ${MAX_TMUX_SESSIONS} resumable sessions; end one first`,
            );
          }
          command = attachCommand(action.tmux);
        }
      }
      const pty = { term: 'xterm-256color', cols: session.cols, rows: session.rows };
      const agentForward = host?.agentForward === true;
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        const done = (error: Error | undefined, stream: ClientChannel) =>
          error ? reject(error) : resolve(stream);
        if (command) client.exec(command, { pty, ...(agentForward && { agentForward }) }, done);
        // ssh2 honours `agentForward` on shell channels; its types leave it out.
        else client.shell(pty, (agentForward ? { agentForward } : {}) as ShellOptions, done);
      }).catch((error: unknown) => {
        client.end();
        this.endJumps(session);
        throw new SshError(
          'unreachable',
          `The server did not open a shell: ${(error as Error).message}`,
        );
      });
      if (!current()) {
        channel.close();
        client.end();
        this.endJumps(session);
        return;
      }
      session.tmux = command ? action.tmux : null;
      this.attach(session, generation, client, channel);
    } catch (error) {
      if (!current()) return;
      session.state = 'closed';
      session.client = null;
      session.channel = null;
      this.endJumps(session);
      const failure =
        error instanceof SshError
          ? error
          : new SshError('unreachable', `Could not connect: ${(error as Error).message}`);
      this.emit({
        type: 'error',
        sessionId: session.id,
        code: failure.code,
        message: failure.message,
      });
      this.emit({ type: 'closed', sessionId: session.id, exitCode: null });
    }
  }

  /** For a saved host: (re-)reads it so edits apply on the next attempt. */
  private resolveHost(session: Session): HostInfo | null {
    if (session.hostId === null) return null;
    if (this.vault?.state !== 'unlocked') {
      throw new SshError('vault_locked', 'Unlock the vault to connect');
    }
    const host = this.hosts?.get(session.hostId);
    if (!host) throw new SshError('invalid_request', 'That host is no longer saved');
    session.host = host;
    session.request = {
      host: host.address,
      port: host.port,
      username: host.username,
      auth: host.auth,
      cols: session.cols,
      rows: session.rows,
    };
    return host;
  }

  /** Runs one command on an authenticated connection (no PTY); output is capped. */
  private exec(client: Client, command: string): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout });
      };
      const timer = setTimeout(() => finish(null), EXEC_TIMEOUT_MS);
      try {
        client.exec(command, (error, stream) => {
          if (error) return finish(null);
          let code: number | null = null;
          stream.on('data', (chunk: Buffer) => {
            if (stdout.length < MAX_EXEC_OUTPUT) stdout += chunk.toString('utf8');
          });
          stream.stderr.on('data', () => undefined);
          stream.on('exit', (status: number | null) => {
            code = typeof status === 'number' ? status : null;
          });
          stream.on('close', () => finish(code));
        });
      } catch {
        finish(null);
      }
    });
  }

  private emitSessions(sessionId: string, available: boolean, sessions: TmuxSessionInfo[]) {
    this.emit({ type: 'tmux-sessions', sessionId, available, sessions });
  }

  /** tmux over a live terminal's own connection. */
  tmux(message: TmuxMessage): void {
    const session = this.sessions.get(message.sessionId);
    const client = session?.client;
    if (!session || session.state !== 'ready' || !client) return;
    if (message.op === 'history') {
      if (!session.tmux) return;
      this.queueHistory(session, message.action, message.lines);
      return;
    }
    if (session.hostId === null) return;
    const run = async () => {
      if (message.op === 'end') await this.exec(client, killCommand(message.session));
      const listed = parseList((await this.exec(client, listCommand())).stdout);
      if (!session.disposed) this.emitSessions(session.id, listed.available, listed.sessions);
    };
    void run().catch(() => undefined);
  }

  /** History actions run one at a time; scrolls that arrive meanwhile are added up. */
  private queueHistory(session: Session, action: HistoryAction, lines: number) {
    const history = session.history;
    if (action === 'scroll') history.scroll += lines;
    else {
      if (action === 'exit') history.scroll = 0;
      if (history.queue.length < 8) history.queue.push(action);
    }
    if (history.busy) return;
    history.busy = true;
    const pump = async () => {
      try {
        for (;;) {
          const client = session.client;
          const name = session.tmux;
          if (!client || !name || session.disposed) break;
          let next: { action: HistoryAction; lines: number } | null = null;
          const queued = history.queue.shift();
          if (queued) next = { action: queued, lines: 0 };
          else if (history.scroll !== 0) {
            const step = Math.max(-MAX_SCROLL_LINES, Math.min(MAX_SCROLL_LINES, history.scroll));
            history.scroll -= step;
            next = { action: 'scroll', lines: step };
          }
          if (!next) break;
          const { stdout } = await this.exec(client, historyScript(name, next.action, next.lines));
          const state = parseHistoryState(stdout);
          if (next.action === 'exit' && state?.inMode) session.channel?.write('q');
          if (state && !session.disposed)
            this.emit({ type: 'history', sessionId: session.id, ...state });
        }
      } finally {
        history.busy = false;
      }
    };
    void pump().catch(() => undefined);
  }

  /**
   * Connects through the host's jump hosts (if any) to the host itself and
   * logs in to each. Every hop checks its own pinned host key and uses its
   * own login; the connections in front of the target stay in `session.jumps`.
   */
  private async connectChain(
    session: Session,
    current: () => boolean,
    host: HostInfo | null,
  ): Promise<Client> {
    this.endJumps(session);
    const { request } = session;
    const target: Hop = {
      host: unbracket(request.host),
      port: request.port,
      username: request.username,
      auth: request.auth,
      label: host?.name ?? `${request.username}@${unbracket(request.host)}`,
      jump: false,
      agentForward: host?.agentForward === true,
    };
    let jumps: Hop[] = [];
    if (host) {
      let chain: HostInfo[];
      try {
        chain = resolveChain(host, this.hosts?.list() ?? []);
      } catch (error) {
        throw new SshError(
          'invalid_request',
          error instanceof JumpError ? error.message : 'The jump hosts could not be worked out',
        );
      }
      jumps = chain.map((jump) => ({
        host: jump.address,
        port: jump.port,
        username: jump.username,
        auth: jump.auth,
        label: jump.name,
        jump: true,
        agentForward: false,
      }));
    }
    let previous: { client: Client; hop: Hop } | null = null;
    for (const hop of [...jumps, target]) {
      if (!current()) throw new SshError('connection_lost', 'Cancelled');
      try {
        const sock = previous
          ? await this.forwardThrough(previous.client, previous.hop, hop)
          : undefined;
        const client = await this.handshake(session, current, hop, sock);
        if (!hop.jump) return client;
        session.jumps.push(client);
        previous = { client, hop };
      } catch (error) {
        if (!hop.jump || !(error instanceof SshError)) throw error;
        throw new SshError(error.code, `Jump host ${hop.label}: ${error.message}`);
      }
    }
    throw new SshError('invalid_request', 'Nothing to connect to');
  }

  /** A tunnel from a connected jump host to the next hop's SSH port. */
  private forwardThrough(client: Client, via: Hop, next: Hop): Promise<Duplex> {
    return new Promise<Duplex>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SshError('timeout', `${via.label} timed out reaching ${next.label}`)),
        this.options.connectTimeoutMs,
      );
      try {
        client.forwardOut('127.0.0.1', 0, unbracket(next.host), next.port, (error, stream) => {
          clearTimeout(timer);
          if (error) {
            reject(
              new SshError(
                'unreachable',
                `Jump host ${via.label} could not reach ${next.label} (${unbracket(next.host)}:${next.port})`,
              ),
            );
          } else resolve(stream);
        });
      } catch {
        clearTimeout(timer);
        reject(new SshError('connection_lost', `Jump host ${via.label} disconnected`));
      }
    });
  }

  private endJumps(session: Session) {
    for (const jump of session.jumps.splice(0).reverse()) {
      jump.end();
      jump.destroy();
    }
  }

  /** Connects and authenticates one hop, asking the user about an unknown host key and for secrets. */
  private handshake(
    session: Session,
    current: () => boolean,
    hop: Hop,
    sock: Duplex | undefined,
  ): Promise<Client> {
    const host = unbracket(hop.host);
    const { auth } = hop;

    if (this.vault?.state !== 'unlocked') {
      return Promise.reject(new SshError('vault_locked', 'Unlock the vault to connect'));
    }
    if (auth.kind === 'key' && !this.keys?.material(auth.keyId)) {
      return Promise.reject(new SshError('invalid_key', 'That key is no longer in the vault'));
    }
    if (auth.kind === 'agent') {
      const location = locateAgent(auth.agent);
      if (!location.ok) return Promise.reject(new SshError('auth_failed', location.message));
    }
    const pins = this.knownHosts.pinsFor(host, hop.port);
    // The agent ssh2 offers for forwarding (requested per channel, see `open`).
    const forwardFrom = hop.agentForward
      ? locateAgent(auth.kind === 'agent' ? auth.agent : 'system')
      : null;

    return new Promise<Client>((resolve, reject) => {
      const client = new Client();
      session.client = client;
      let settled = false;
      /** Set when we refuse a host key or the user cancels a prompt. */
      let failure: SshError | null = null;
      let timer: NodeJS.Timeout | undefined;

      const fail = (error: SshError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.end();
        client.destroy();
        reject(error);
      };
      const startTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => fail(new SshError('timeout', 'Timed out connecting to the host')),
          this.options.connectTimeoutMs,
        );
      };
      /** Time the user spends on a prompt does not count against the connect timeout. */
      const whileAsking: Asking = async (ask) => {
        clearTimeout(timer);
        try {
          return await ask();
        } finally {
          if (!settled) startTimer();
        }
      };

      client.on('ready', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.savePasswordIfAsked(session, hop);
        resolve(client);
      });
      client.on('error', (error: Error & { level?: string; code?: string }) => {
        if (failure) fail(failure);
        else if (error.level === 'client-authentication') {
          fail(
            new SshError(
              'auth_failed',
              auth.kind === 'password'
                ? 'The server rejected the user name or password'
                : auth.kind === 'agent'
                  ? "The server accepted none of the agent's keys"
                  : 'The server rejected the user name or key',
            ),
          );
        } else if (error.level === 'agent') {
          fail(new SshError('auth_failed', 'The SSH agent could not be used'));
        } else if (error.level === 'client-timeout' || /timed out/i.test(error.message)) {
          fail(new SshError('timeout', 'Timed out connecting to the host'));
        } else {
          fail(new SshError('unreachable', `Could not connect: ${error.message}`));
        }
      });
      client.on('close', () => {
        fail(failure ?? new SshError('unreachable', 'The server closed the connection'));
      });
      client.once('connect', () => client.setNoDelay(true));

      const authHandler = this.authHandler(session, hop, current, whileAsking, (error) => {
        failure = error;
      });

      const config: ConnectConfig = {
        host,
        port: hop.port,
        username: hop.username,
        ...(sock && { sock: sock as NonNullable<ConnectConfig['sock']> }),
        ...(forwardFrom?.ok && { agent: forwardFrom.path }),
        // Our own timers: the time spent on prompts must not count.
        readyTimeout: 0,
        keepaliveInterval: this.options.keepaliveIntervalMs,
        keepaliveCountMax: this.options.keepaliveCountMax,
        ...(pins.length > 0 && { algorithms: { serverHostKey: hostKeyAlgorithmsFor(pins) } }),
        authHandler,
        hostVerifier: (presented: Buffer, verify: (valid: boolean) => void) => {
          const verdict = this.knownHosts.check(host, hop.port, presented);
          if (verdict === 'trusted') return verify(true);
          let key: ReturnType<typeof describeHostKey>;
          try {
            key = describeHostKey(presented);
          } catch {
            failure = new SshError('unreachable', 'The server sent a malformed host key');
            return verify(false);
          }
          if (verdict === 'mismatch') {
            this.reportChangedKey(session.id, host, hop.port, key);
            failure = new SshError(
              'host_key_mismatch',
              `The host key for ${host}:${hop.port} has changed (now ${key.algorithm} ${key.fingerprint}). ` +
                'This could be an attack; the connection was refused.',
            );
            return verify(false);
          }
          void whileAsking(() =>
            this.askHostKey(session.id, host, hop.port, key.algorithm, key.fingerprint),
          ).then(async (accept) => {
            if (settled) return;
            if (!accept || !current()) {
              failure = new SshError('host_key_rejected', 'The host key was not accepted');
              verify(false);
              return;
            }
            try {
              await this.knownHosts.accept(host, hop.port, key);
            } catch {
              // Locked meanwhile, or the disk is full: trusted for this connection only.
              console.error('Could not save the accepted host key');
            }
            verify(true);
          });
        },
      };

      startTimer();
      try {
        client.connect(config);
      } catch (error) {
        fail(new SshError('invalid_request', (error as Error).message));
      }
    });
  }

  /** A typed password the user asked to keep is saved once the hop accepted it. */
  private savePasswordIfAsked(session: Session, hop: Hop) {
    const host = unbracket(hop.host);
    const id = passwordId(host, hop.port, hop.username);
    if (!session.remember.has(id)) return;
    session.remember.delete(id);
    const password = session.passwords.get(id);
    if (password === undefined) return;
    const saved: SavedPassword = { host, port: hop.port, username: hop.username, password };
    void this.vault
      ?.put('password', id, saved)
      .catch(() => console.error('Could not save the password'));
  }

  /**
   * Chooses the next login method. Key logins offer the stored key (asking
   * for its passphrase if needed); agent logins offer the agent's keys;
   * password logins use the saved or typed password (asking again when
   * rejected) and fall back to keyboard-interactive, whose server prompts are
   * shown to the user.
   */
  private authHandler(
    session: Session,
    hop: Hop,
    current: () => boolean,
    whileAsking: Asking,
    setFailure: (error: SshError) => void,
  ): AuthHandlerMiddleware {
    const { username } = hop;
    let keyOffered = false;
    let passwordTries = 0;
    let keyboardTried = false;

    const keyboard = (
      name: string,
      instructions: string,
      _lang: string,
      prompts: Prompt[],
      finish: KeyboardInteractiveCallback,
    ) => {
      if (prompts.length === 0) return finish([]);
      void whileAsking(() =>
        this.ask(session.id, 'keyboard-interactive', {
          title: clean(name, 100) || `${hop.label} asks`,
          message: clean(instructions, 2000),
          prompts: prompts.slice(0, 10).map((p) => ({
            label: clean(p.prompt, 200) || 'Response',
            echo: p.echo === true,
          })),
          canRemember: false,
        }),
      ).then((answer) => {
        if (!answer || !current()) {
          setFailure(new SshError('auth_cancelled', 'Login cancelled'));
          session.client?.end();
          return;
        }
        finish(prompts.map((_, i) => answer.answers[i] ?? ''));
      });
    };

    const step = async (methodsLeft: string[] | null) => {
      const auth = hop.auth;
      if (auth.kind === 'key') {
        if (keyOffered) return false as const;
        keyOffered = true;
        const unlocked = await this.unlockKey(session, auth.keyId, whileAsking);
        return { type: 'publickey' as const, username, ...unlocked };
      }
      if (auth.kind === 'agent') {
        if (keyOffered) return false as const;
        keyOffered = true;
        const location = locateAgent(auth.agent);
        if (!location.ok) throw new SshError('auth_failed', location.message);
        return { type: 'agent' as const, username, agent: agentFor(location.path) };
      }
      // Learn which methods the server offers before asking for anything.
      if (methodsLeft === null) return { type: 'none' as const, username };
      if (methodsLeft.includes('password') && passwordTries < MAX_SECRET_ATTEMPTS) {
        const retry = passwordTries > 0;
        passwordTries++;
        const password = await this.passwordFor(session, hop, retry, whileAsking);
        return { type: 'password' as const, username, password };
      }
      if (methodsLeft.includes('keyboard-interactive') && !keyboardTried) {
        keyboardTried = true;
        return { type: 'keyboard-interactive' as const, username, prompt: keyboard };
      }
      return false as const;
    };

    return (methodsLeft, _partialSuccess, next) => {
      step(methodsLeft as string[] | null).then(
        // `false` ends authentication (ssh2 accepts it; its types do not say so).
        (method) => next(method as Parameters<typeof next>[0]),
        (error: unknown) => {
          setFailure(
            error instanceof SshError
              ? error
              : new SshError('auth_failed', 'The login could not be completed'),
          );
          next(false as never);
        },
      );
    };
  }

  /** The stored key in a form ssh2 can use, asking for its passphrase if needed. */
  private async unlockKey(
    session: Session,
    keyId: string,
    whileAsking: Asking,
  ): Promise<{ key: string; passphrase?: string }> {
    const keys = this.keys;
    const material = keys?.material(keyId);
    if (!keys || !material) throw new SshError('invalid_key', 'That key is no longer in the vault');
    if (!material.encrypted) return { key: material.privateKey };
    const known = material.passphrase ?? this.passphrases.get(keyId);
    if (known !== undefined && !(parsePrivateKey(material.privateKey, known) instanceof Error)) {
      return { key: material.privateKey, passphrase: known };
    }
    const { label } = keys.describe(keyId);
    for (let attempt = 0; attempt < MAX_SECRET_ATTEMPTS; attempt++) {
      const answer = await whileAsking(() =>
        this.ask(session.id, 'passphrase', {
          title: `Passphrase for ${label}`,
          message: attempt > 0 ? 'That passphrase is wrong; try again' : '',
          prompts: [{ label: 'Passphrase', echo: false }],
          canRemember: true,
        }),
      );
      if (!answer) throw new SshError('auth_cancelled', 'Login cancelled');
      const passphrase = answer.answers[0] ?? '';
      if (parsePrivateKey(material.privateKey, passphrase) instanceof Error) continue;
      this.passphrases.set(keyId, passphrase);
      if (answer.remember) {
        await keys.savePassphrase(keyId, passphrase).catch(() => {
          console.error('Could not save the passphrase');
        });
      }
      return { key: material.privateKey, passphrase };
    }
    throw new SshError('invalid_key', 'The passphrase for the private key is wrong');
  }

  private async passwordFor(session: Session, hop: Hop, retry: boolean, whileAsking: Asking) {
    const { port, username } = hop;
    const host = unbracket(hop.host);
    const savedId = passwordId(host, port, username);
    if (!retry) {
      const known = session.passwords.get(savedId);
      if (known !== undefined) return known;
      const saved = this.vault?.get<SavedPassword>('password', savedId);
      if (saved) {
        session.passwords.set(savedId, saved.password);
        return saved.password;
      }
    }
    session.passwords.delete(savedId);
    const where = `${username}@${host}${port === 22 ? '' : `:${port}`}`;
    const answer = await whileAsking(() =>
      this.ask(session.id, 'password', {
        title: hop.jump ? `Password for ${where} (jump host)` : `Password for ${where}`,
        message: retry ? 'The server rejected the password; try again' : '',
        prompts: [{ label: 'Password', echo: false }],
        canRemember: true,
      }),
    );
    if (!answer) throw new SshError('auth_cancelled', 'Login cancelled');
    const password = answer.answers[0] ?? '';
    session.passwords.set(savedId, password);
    if (answer.remember) session.remember.add(savedId);
    else session.remember.delete(savedId);
    if (retry) {
      // A saved password that no longer works is not offered again.
      await this.vault?.delete('password', savedId).catch(() => false);
    }
    return password;
  }

  private ask(sessionId: string, kind: PromptKind, prompt: PromptText): Promise<PromptReply> {
    const requestId = `p${++this.nextPrompt}`;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.answerPrompt(requestId, null, false),
        this.options.promptTimeoutMs,
      );
      this.prompts.set(requestId, {
        sessionId,
        resolve: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
      });
      this.emit({ type: 'prompt', sessionId, requestId, kind, ...prompt });
    });
  }

  private askHostKey(
    sessionId: string,
    host: string,
    port: number,
    algorithm: string,
    fingerprint: string,
  ): Promise<boolean> {
    const requestId = `k${++this.nextPrompt}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => this.answerHostKey(requestId, false),
        this.options.promptTimeoutMs,
      );
      this.hostKeyPrompts.set(requestId, {
        sessionId,
        resolve: (accept) => {
          clearTimeout(timer);
          resolve(accept);
        },
      });
      this.emit({ type: 'host-key', sessionId, requestId, host, port, algorithm, fingerprint });
    });
  }

  /** Keeps the presented key engine-side and tells the user what changed. */
  private reportChangedKey(
    sessionId: string,
    host: string,
    port: number,
    key: ReturnType<typeof describeHostKey>,
  ) {
    const now = Date.now();
    for (const [id, change] of this.changedKeys) {
      if (change.expires < now || change.sessionId === sessionId) this.changedKeys.delete(id);
    }
    const requestId = `c${++this.nextPrompt}`;
    this.changedKeys.set(requestId, {
      sessionId,
      host,
      port,
      key: { algorithm: key.algorithm, key: key.key },
      expires: now + CHANGE_TOKEN_MS,
    });
    this.emit({
      type: 'host-key-changed',
      sessionId,
      requestId,
      host,
      port,
      algorithm: key.algorithm,
      fingerprint: key.fingerprint,
      previous: this.knownHosts.previous(host, port),
    });
  }

  private cancelPrompts(sessionId: string) {
    for (const [requestId, prompt] of this.hostKeyPrompts) {
      if (prompt.sessionId === sessionId) this.answerHostKey(requestId, false);
    }
    for (const [requestId, prompt] of this.prompts) {
      if (prompt.sessionId === sessionId) this.answerPrompt(requestId, null, false);
    }
  }

  /* ----- Connected --------------------------------------------------------- */

  /** A connected session: a shell (`channel`) or a `hold` connection (no channel). */
  private attach(
    session: Session,
    generation: number,
    client: Client,
    channel: ClientChannel | null,
  ) {
    session.client = client;
    session.channel = channel;
    session.sftp = null;
    session.state = 'ready';
    const current = () => !session.disposed && session.generation === generation;
    let exitCode: number | null = null;
    let lost: SshError | null = null;
    let closed = false;

    const finish = () => {
      if (closed) return;
      closed = true;
      client.end();
      this.endJumps(session);
      if (!current()) return;
      session.state = 'closed';
      session.channel = null;
      session.client = null;
      session.sftp = null;
      this.forwards.pause(session.id);
      this.transfers.interruptSession(session.id);
      if (lost && (exitCode === null || channel === null)) {
        this.emit({ type: 'error', sessionId: session.id, code: lost.code, message: lost.message });
      }
      this.emit({
        type: 'closed',
        sessionId: session.id,
        // A shell that ended without a status (killed by a signal) still ended.
        exitCode: channel === null ? null : lost ? exitCode : (exitCode ?? 0),
      });
    };

    if (channel) {
      const onData = (chunk: Buffer) => {
        if (!current()) return;
        session.unacked += chunk.length;
        this.emit({
          type: 'data',
          sessionId: session.id,
          data: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        });
        if (!session.paused && session.unacked > HIGH_WATER_BYTES) {
          session.paused = true;
          channel.pause();
        }
      };
      channel.on('data', onData);
      channel.stderr.on('data', onData);
      channel.on('exit', (code: number | null) => {
        exitCode = typeof code === 'number' ? code : null;
      });
      channel.on('close', finish);
    }
    client.on('error', (error: Error) => {
      lost ??= new SshError('connection_lost', `Connection lost: ${error.message}`);
    });
    client.on('close', () => {
      lost ??= closed ? null : new SshError('connection_lost', 'Connection lost');
      finish();
    });

    // Size may have changed while connecting.
    if (
      channel &&
      (session.cols !== session.request.cols || session.rows !== session.request.rows)
    ) {
      channel.setWindow(session.rows, session.cols, 0, 0);
    }
    if (channel && session.hostId !== null && !session.counted) {
      session.counted = true;
      void this.hosts?.touch(session.hostId).catch(() => undefined);
    }
    this.emit({ type: 'ready', sessionId: session.id, tmux: session.tmux });
    // Forwards and transfers the last drop interrupted continue; saved
    // forwards marked "start automatically" open on the first session to the host.
    void this.forwards.resume(session.id, client).then(() => this.autoForwards(session, client));
    this.transfers.resumeSession(session.id, () => this.filesOf(session.id));
  }

  private async autoForwards(session: Session, client: Client) {
    const host = session.host;
    if (!host || session.state !== 'ready' || session.client !== client) return;
    for (const saved of host.forwards) {
      if (!saved.auto || this.forwards.runs(host.id, saved.id)) continue;
      const { id, auto: _auto, label: _label, ...spec } = saved;
      await this.forwards
        .start(session.id, client, spec, { hostId: host.id, savedId: id, keepFailed: true })
        .catch(() => undefined);
    }
  }

  private teardown(session: Session) {
    session.state = 'closed';
    session.channel?.close();
    session.client?.end();
    session.client?.destroy();
    this.endJumps(session);
    session.channel = null;
    session.client = null;
    session.sftp = null;
  }
}

const HOST_RE = new RegExp(HOST_PATTERN);
const USER_RE = new RegExp(USER_PATTERN);

/** Why a ~/.ssh/config entry cannot be imported as is; empty when it can. */
function configProblem(entry: SshConfigHost): string {
  if (!entry.hostName || entry.hostName.length > 253 || !HOST_RE.test(entry.hostName)) {
    return 'The host name is not a plain address';
  }
  if (!USER_RE.test(entry.user)) return 'No usable user name';
  if (!(entry.port >= 1 && entry.port <= 65535)) return 'The port is not valid';
  return '';
}

function configLabel(alias: string): string {
  return clean(alias, 64) || 'host';
}

function localUser(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

function unbracket(host: string): string {
  return host.replace(/^\[(.*)\]$/, '$1');
}

/** Vault id of a saved password (no host names in item ids). */
function passwordId(host: string, port: number, username: string): string {
  return createHash('sha256')
    .update(`${username}\n${host.toLowerCase()}\n${port}`)
    .digest('hex')
    .slice(0, 32);
}

/** Server-supplied prompt text: printable characters only (tabs and newlines kept). */
function clean(text: string, max: number): string {
  return text.replace(UNPRINTABLE, '').trim().slice(0, max);
}
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** `name-1.ext`, `name-2.ext`… the first that is free in the remote folder. */
async function freeRemoteName(
  files: RemoteFiles,
  directory: string,
  name: string,
  taken: Set<string>,
): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (taken.has(candidate)) continue;
    if ((await files.lstatOrNull(posix.join(directory, candidate))) === null) return candidate;
  }
  throw new CallError('exists', `Too many files called ${name} in that folder`);
}

async function readSmallFile(path: string, maxBytes: number, tooLarge: string): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new CallError('io', 'That is not a file');
    if (info.size > maxBytes) throw new CallError('io', tooLarge);
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof CallError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CallError('not_found', 'The file does not exist');
    }
    throw new CallError('io', 'The file could not be read');
  }
}
