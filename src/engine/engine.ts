/**
 * The SSH engine: one ssh2 connection with one PTY shell per session. Runs in
 * an Electron utilityProcess (see index.ts) and is plain Node, so tests drive
 * it directly. Credentials arrive with `connect`, stay in this process only,
 * and are kept for the session's life so a lost connection can be re-opened
 * without the renderer sending them again.
 *
 * Connection handling follows Jarvis NG's ConnectionPool
 * (apps/ssh-gateway/src/ssh/connection-pool.ts), same owner: strict host-key
 * checking, TCP_NODELAY, keepalives, error mapping. Unlike the gateway, an
 * unknown host key is shown to the user, who must accept it (trust on first
 * use); a changed key is refused.
 */
import ssh2, { type Client as SshClient, type ClientChannel, type ConnectConfig } from 'ssh2';
import Value from 'typebox/value';
import { EngineCommand } from '../shared/engine-protocol.js';
import type { ConnectRequest, SessionEvent, SshErrorCode } from '../shared/ipc.js';
import { describeHostKey, hostKeyAlgorithmsFor } from './host-keys.js';
import { KnownHosts } from './known-hosts.js';

// ssh2 is CommonJS: Node's ESM loader exposes only its default export.
const { Client, utils } = ssh2;
type Client = SshClient;

export interface EngineOptions {
  /** TCP connect + SSH handshake, not counting time the user spends on a host-key prompt. */
  connectTimeoutMs?: number;
  /** How long a host-key prompt waits for the user. */
  hostKeyPromptTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  maxSessions?: number;
}

/** Output not yet rendered by the terminal before the channel is paused. */
export const HIGH_WATER_BYTES = 1024 * 1024;
/** Paused output resumes once the terminal has caught up to this. */
export const LOW_WATER_BYTES = 256 * 1024;

const DEFAULTS: Required<EngineOptions> = {
  connectTimeoutMs: 20_000,
  hostKeyPromptTimeoutMs: 5 * 60_000,
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
  request: ConnectRequest;
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
}

interface PendingPrompt {
  sessionId: string;
  resolve: (accept: boolean) => void;
}

export class Engine {
  private readonly sessions = new Map<string, Session>();
  private readonly prompts = new Map<string, PendingPrompt>();
  private readonly options: Required<EngineOptions>;
  private nextPrompt = 0;

  constructor(
    private readonly emit: (event: SessionEvent) => void,
    readonly knownHosts = new KnownHosts(),
    options: EngineOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
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
      case 'shutdown':
        this.shutdown();
        break;
    }
  }

  connect(sessionId: string, request: ConnectRequest): void {
    if (this.sessions.has(sessionId)) return;
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
      request,
      cols: request.cols,
      rows: request.rows,
      client: null,
      channel: null,
      generation: 0,
      state: 'closed',
      unacked: 0,
      paused: false,
      disposed: false,
    };
    this.sessions.set(sessionId, session);
    void this.open(session);
  }

  reconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      // E.g. the engine restarted: the credentials are gone with it.
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
    this.teardown(session);
    // Drop the credentials with the session.
    session.request = { ...session.request, auth: { kind: 'password', password: '-' } };
    this.emit({ type: 'closed', sessionId, exitCode: null });
  }

  answerHostKey(requestId: string, accept: boolean): void {
    const prompt = this.prompts.get(requestId);
    if (!prompt) return;
    this.prompts.delete(requestId);
    prompt.resolve(accept);
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id);
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
    const current = () => !session.disposed && session.generation === generation;

    try {
      const client = await this.handshake(session, current);
      if (!current()) {
        client.end();
        return;
      }
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        client.shell(
          { term: 'xterm-256color', cols: session.cols, rows: session.rows },
          (error, stream) => (error ? reject(error) : resolve(stream)),
        );
      }).catch((error: unknown) => {
        client.end();
        throw new SshError(
          'unreachable',
          `The server did not open a shell: ${(error as Error).message}`,
        );
      });
      if (!current()) {
        channel.close();
        client.end();
        return;
      }
      this.attach(session, generation, client, channel);
    } catch (error) {
      if (!current()) return;
      session.state = 'closed';
      session.client = null;
      session.channel = null;
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

  /** Connects and authenticates, asking the user about an unknown host key. */
  private handshake(session: Session, current: () => boolean): Promise<Client> {
    const { request } = session;
    const host = request.host.replace(/^\[(.*)\]$/, '$1');
    const auth = request.auth;
    const pins = this.knownHosts.pinsFor(host, request.port);

    let privateKey: Buffer | undefined;
    if (auth.kind === 'key') {
      privateKey = Buffer.from(auth.privateKey, 'utf8');
      const parsed = utils.parseKey(privateKey, auth.passphrase || undefined);
      if (parsed instanceof Error) {
        const message = /passphrase|decrypt|bad decrypt|integrity/i.test(parsed.message)
          ? auth.passphrase
            ? 'The passphrase for the private key is wrong'
            : 'The private key is encrypted: enter its passphrase'
          : 'The private key could not be read (OpenSSH, PEM or PuTTY format expected)';
        return Promise.reject(new SshError('invalid_key', message));
      }
    }

    return new Promise<Client>((resolve, reject) => {
      const client = new Client();
      session.client = client;
      let settled = false;
      let hostKeyFailure: SshError | null = null;
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

      client.on('ready', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(client);
      });
      client.on('error', (error: Error & { level?: string; code?: string }) => {
        if (hostKeyFailure) fail(hostKeyFailure);
        else if (error.level === 'client-authentication') {
          fail(
            new SshError(
              'auth_failed',
              auth.kind === 'password'
                ? 'The server rejected the user name or password'
                : 'The server rejected the user name or key',
            ),
          );
        } else if (error.level === 'client-timeout' || /timed out/i.test(error.message)) {
          fail(new SshError('timeout', 'Timed out connecting to the host'));
        } else {
          fail(new SshError('unreachable', `Could not connect: ${error.message}`));
        }
      });
      client.on('close', () => {
        fail(hostKeyFailure ?? new SshError('unreachable', 'The server closed the connection'));
      });
      client.once('connect', () => client.setNoDelay(true));

      // Password logins on servers that only offer keyboard-interactive.
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        if (auth.kind !== 'password') return finish([]);
        finish(prompts.map((prompt) => (prompt.echo ? '' : auth.password)));
      });

      const config: ConnectConfig = {
        host,
        port: request.port,
        username: request.username,
        // Our own timers: the time spent on the host-key prompt must not count.
        readyTimeout: 0,
        keepaliveInterval: this.options.keepaliveIntervalMs,
        keepaliveCountMax: this.options.keepaliveCountMax,
        ...(pins.length > 0 && { algorithms: { serverHostKey: hostKeyAlgorithmsFor(pins) } }),
        ...(auth.kind === 'password'
          ? { password: auth.password, tryKeyboard: true }
          : {
              privateKey: privateKey ?? Buffer.alloc(0),
              ...(auth.passphrase && { passphrase: auth.passphrase }),
            }),
        hostVerifier: (presented: Buffer, verify: (valid: boolean) => void) => {
          const verdict = this.knownHosts.check(host, request.port, presented);
          if (verdict === 'trusted') return verify(true);
          let key: ReturnType<typeof describeHostKey>;
          try {
            key = describeHostKey(presented);
          } catch {
            hostKeyFailure = new SshError('unreachable', 'The server sent a malformed host key');
            return verify(false);
          }
          if (verdict === 'mismatch') {
            hostKeyFailure = new SshError(
              'host_key_mismatch',
              `The host key for ${host}:${request.port} has changed (now ${key.algorithm} ${key.fingerprint}). ` +
                'This could be an attack; the connection was refused.',
            );
            return verify(false);
          }
          clearTimeout(timer);
          void this.askUser(session.id, host, request.port, key.algorithm, key.fingerprint).then(
            (accept) => {
              if (settled) return;
              if (!accept || !current()) {
                hostKeyFailure = new SshError('host_key_rejected', 'The host key was not accepted');
                verify(false);
                return;
              }
              this.knownHosts.accept(host, request.port, key);
              startTimer();
              verify(true);
            },
          );
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

  private askUser(
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
        this.options.hostKeyPromptTimeoutMs,
      );
      this.prompts.set(requestId, {
        sessionId,
        resolve: (accept) => {
          clearTimeout(timer);
          resolve(accept);
        },
      });
      this.emit({ type: 'host-key', sessionId, requestId, host, port, algorithm, fingerprint });
    });
  }

  private cancelPrompts(sessionId: string) {
    for (const [requestId, prompt] of this.prompts) {
      if (prompt.sessionId === sessionId) this.answerHostKey(requestId, false);
    }
  }

  /* ----- Connected --------------------------------------------------------- */

  private attach(session: Session, generation: number, client: Client, channel: ClientChannel) {
    session.client = client;
    session.channel = channel;
    session.state = 'ready';
    const current = () => !session.disposed && session.generation === generation;
    let exitCode: number | null = null;
    let lost: SshError | null = null;
    let closed = false;

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

    const finish = () => {
      if (closed) return;
      closed = true;
      client.end();
      if (!current()) return;
      session.state = 'closed';
      session.channel = null;
      session.client = null;
      if (lost && exitCode === null) {
        this.emit({ type: 'error', sessionId: session.id, code: lost.code, message: lost.message });
      }
      this.emit({
        type: 'closed',
        sessionId: session.id,
        // A shell that ended without a status (killed by a signal) still ended.
        exitCode: lost ? exitCode : (exitCode ?? 0),
      });
    };
    channel.on('close', finish);
    client.on('error', (error: Error) => {
      lost ??= new SshError('connection_lost', `Connection lost: ${error.message}`);
    });
    client.on('close', () => {
      lost ??= closed ? null : new SshError('connection_lost', 'Connection lost');
      finish();
    });

    // Size may have changed while connecting.
    if (session.cols !== session.request.cols || session.rows !== session.request.rows) {
      channel.setWindow(session.rows, session.cols, 0, 0);
    }
    this.emit({ type: 'ready', sessionId: session.id });
  }

  private teardown(session: Session) {
    session.state = 'closed';
    session.channel?.close();
    session.client?.end();
    session.client?.destroy();
    session.channel = null;
    session.client = null;
  }
}
