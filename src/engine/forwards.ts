/**
 * Port forwards over a session's SSH connection: local (-L), remote (-R) and
 * dynamic SOCKS5 (-D). Listeners bind to loopback unless the user explicitly
 * allowed another address. A forward belongs to one session: it pauses when
 * the connection drops, reopens when it is back, and goes when the session
 * closes. Bytes and open connections are counted for the status list.
 */
import { createServer, connect as tcpConnect, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2';
import type { ForwardSpec } from '../shared/ipc.js';
import type { ForwardEvent } from '../shared/protocol.js';
import { CallError } from './errors.js';
import { replyBytes, REPLY, socksHandshake } from './socks.js';

const MAX_FORWARDS = 64;
const MAX_CONNECTIONS_PER_FORWARD = 256;
const BYTES_EMIT_MS = 1000;

interface Forward {
  info: ForwardEvent;
  spec: ForwardSpec;
  server: Server | null;
  /** The remote listener (address and port as the server bound them). */
  remote: { client: Client; address: string; port: number } | null;
  sockets: Set<Duplex>;
}

/** 127.0.0.0/8, ::1 and localhost: only this computer can connect. */
export function isLoopback(address: string): boolean {
  const plain = address.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return plain === 'localhost' || plain === '::1' || /^127(\.\d{1,3}){3}$/.test(plain);
}

/** Checks a forward the user asked for; throws a CallError the user can read. */
export function checkSpec(spec: ForwardSpec): void {
  if (!isLoopback(spec.bindAddress) && !spec.allowPublic) {
    throw new CallError(
      'invalid_request',
      `Listening on ${spec.bindAddress} lets other computers use this tunnel; confirm it first`,
    );
  }
  if (spec.kind === 'dynamic') {
    if (spec.destHost !== '' || spec.destPort !== 0) {
      throw new CallError('invalid_request', 'A SOCKS forward has no fixed destination');
    }
  } else if (spec.destHost === '' || spec.destPort === 0) {
    throw new CallError('invalid_request', 'Enter the destination address and port');
  }
}

export class Forwards {
  private readonly forwards = new Map<string, Forward>();
  /** Clients that already route incoming `tcp connection`s to our remote forwards. */
  private readonly routed = new WeakSet<Client>();
  private readonly bytesTimers = new Map<string, NodeJS.Timeout>();
  private nextId = 0;

  constructor(private readonly emit: (sessionId: string, forwards: ForwardEvent[]) => void) {}

  list(): ForwardEvent[] {
    return [...this.forwards.values()].map((f) => ({ ...f.info }));
  }

  ofSession(sessionId: string): ForwardEvent[] {
    return this.list().filter((f) => f.sessionId === sessionId);
  }

  /** A saved forward of the host is running (on any session). */
  runs(hostId: string, savedId: string): boolean {
    return [...this.forwards.values()].some(
      (f) => f.info.hostId === hostId && f.info.savedId === savedId,
    );
  }

  async start(
    sessionId: string,
    client: Client,
    spec: ForwardSpec,
    meta: { hostId: string | null; savedId: string | null; keepFailed?: boolean },
  ): Promise<ForwardEvent> {
    checkSpec(spec);
    if (this.forwards.size >= MAX_FORWARDS) {
      throw new CallError('invalid_request', `At most ${MAX_FORWARDS} forwards at once`);
    }
    if (meta.hostId && meta.savedId && this.runs(meta.hostId, meta.savedId)) {
      // A failed earlier attempt makes way for this one.
      for (const [id, other] of this.forwards) {
        if (other.info.savedId === meta.savedId && other.info.state === 'failed') {
          this.forwards.delete(id);
          this.changed(other.info.sessionId);
        }
      }
    }
    if (meta.hostId && meta.savedId && this.runs(meta.hostId, meta.savedId)) {
      throw new CallError('exists', 'That forward is already running');
    }
    const forward: Forward = {
      info: {
        id: `w${++this.nextId}`,
        sessionId,
        hostId: meta.hostId,
        savedId: meta.savedId,
        kind: spec.kind,
        bindAddress: spec.bindAddress,
        bindPort: spec.bindPort,
        destHost: spec.destHost,
        destPort: spec.destPort,
        state: 'starting',
        error: '',
        connections: 0,
        bytesIn: 0,
        bytesOut: 0,
      },
      spec,
      server: null,
      remote: null,
      sockets: new Set(),
    };
    this.forwards.set(forward.info.id, forward);
    try {
      await this.open(forward, client);
    } catch (error) {
      if (meta.keepFailed) {
        // Started on its own (a saved "automatic" forward): keep it visible as failed.
        forward.info.state = 'failed';
        forward.info.error = error instanceof CallError ? error.message : 'Could not start';
        this.changed(sessionId);
        return { ...forward.info };
      }
      this.forwards.delete(forward.info.id);
      this.changed(sessionId);
      throw error;
    }
    return { ...forward.info };
  }

  stop(sessionId: string, id: string): void {
    const forward = this.forwards.get(id);
    if (!forward || forward.info.sessionId !== sessionId) {
      throw new CallError('not_found', 'No such forward');
    }
    this.close(forward);
    this.forwards.delete(id);
    this.changed(sessionId);
  }

  /** The connection dropped: listeners close, the forwards wait for it to come back. */
  pause(sessionId: string): void {
    let any = false;
    for (const forward of this.forwards.values()) {
      if (forward.info.sessionId !== sessionId) continue;
      this.close(forward);
      forward.info.state = 'paused';
      forward.info.error = 'Waiting for the connection';
      any = true;
    }
    if (any) this.changed(sessionId);
  }

  /** The connection is back: reopen what was paused. */
  async resume(sessionId: string, client: Client): Promise<void> {
    for (const forward of this.forwards.values()) {
      if (forward.info.sessionId !== sessionId || forward.info.state !== 'paused') continue;
      forward.info.state = 'starting';
      try {
        await this.open(forward, client);
      } catch (error) {
        forward.info.state = 'failed';
        forward.info.error = error instanceof CallError ? error.message : 'Could not reopen';
        this.changed(sessionId);
      }
    }
  }

  /** The session closed for good. */
  drop(sessionId: string): void {
    let any = false;
    for (const [id, forward] of this.forwards) {
      if (forward.info.sessionId !== sessionId) continue;
      this.close(forward);
      this.forwards.delete(id);
      any = true;
    }
    clearTimeout(this.bytesTimers.get(sessionId));
    this.bytesTimers.delete(sessionId);
    if (any) this.emit(sessionId, []);
  }

  /* ----- Opening --------------------------------------------------------- */

  private async open(forward: Forward, client: Client): Promise<void> {
    const { spec } = forward;
    if (spec.kind === 'remote') {
      await this.openRemote(forward, client);
    } else {
      const server = createServer((socket) => this.accept(forward, client, socket));
      server.maxConnections = MAX_CONNECTIONS_PER_FORWARD;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => reject(listenError(error, spec));
        server.once('error', onError);
        server.listen({ host: spec.bindAddress, port: spec.bindPort, exclusive: true }, () => {
          server.off('error', onError);
          resolve();
        });
      });
      server.on('error', () => undefined);
      forward.server = server;
    }
    forward.info.state = 'listening';
    forward.info.error = '';
    this.changed(forward.info.sessionId);
  }

  private async openRemote(forward: Forward, client: Client) {
    const { spec } = forward;
    const port = await new Promise<number>((resolve, reject) => {
      try {
        client.forwardIn(spec.bindAddress, spec.bindPort, (error, bound) => {
          if (error) {
            reject(
              new CallError(
                'io',
                `The server refused to listen on ${spec.bindAddress}:${spec.bindPort} (port in use, or remote forwarding is off)`,
              ),
            );
          } else resolve(bound || spec.bindPort);
        });
      } catch {
        reject(new CallError('not_connected', 'The session is not connected'));
      }
    });
    forward.remote = { client, address: spec.bindAddress, port };
    if (!this.routed.has(client)) {
      this.routed.add(client);
      client.on('tcp connection', (details, accept, reject) =>
        this.incoming(client, details, accept, reject),
      );
    }
  }

  /** A connection to one of our remote listeners: connect it to its local destination. */
  private incoming(
    client: Client,
    details: TcpConnectionDetails,
    accept: () => ClientChannel,
    reject: () => void,
  ) {
    const forward = [...this.forwards.values()].find(
      (f) =>
        f.remote?.client === client &&
        f.remote.port === details.destPort &&
        f.info.state === 'listening',
    );
    if (!forward || forward.sockets.size >= MAX_CONNECTIONS_PER_FORWARD) {
      reject();
      return;
    }
    const local = tcpConnect({ host: forward.spec.destHost, port: forward.spec.destPort });
    local.once('connect', () => {
      const channel = accept();
      this.join(forward, local, channel);
    });
    local.once('error', () => {
      reject();
      local.destroy();
    });
  }

  /** A local client connected to a -L or -D listener. */
  private accept(forward: Forward, client: Client, socket: Socket) {
    socket.setNoDelay(true);
    if (forward.spec.kind === 'local') {
      this.out(client, socket, forward.spec.destHost, forward.spec.destPort).then(
        (channel) => this.join(forward, socket, channel),
        () => socket.destroy(),
      );
      return;
    }
    // Dynamic: the SOCKS5 client names the destination.
    socket.setTimeout(30_000, () => socket.destroy());
    socksHandshake(socket).then(
      ({ request, early }) => {
        socket.setTimeout(0);
        this.out(client, socket, request.host, request.port).then(
          (channel) => {
            socket.write(replyBytes(REPLY.succeeded));
            if (early.length > 0) channel.write(early);
            this.join(forward, socket, channel);
          },
          () => socket.end(replyBytes(REPLY.hostUnreachable)),
        );
      },
      () => socket.destroy(),
    );
  }

  private out(client: Client, socket: Socket, host: string, port: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      try {
        client.forwardOut(
          socket.remoteAddress ?? '127.0.0.1',
          socket.remotePort ?? 0,
          host,
          port,
          (error, channel) => (error ? reject(error) : resolve(channel)),
        );
      } catch (error) {
        reject(error as Error);
      }
    });
  }

  /** Pipes both ways, counting bytes (In: towards this computer). */
  private join(forward: Forward, local: Socket, channel: ClientChannel) {
    const sessionId = forward.info.sessionId;
    forward.sockets.add(local);
    forward.sockets.add(channel);
    forward.info.connections++;
    this.changed(sessionId);
    const toLocal = forward.spec.kind !== 'remote';
    local.on('data', (chunk: Buffer) => {
      if (toLocal) forward.info.bytesOut += chunk.length;
      else forward.info.bytesIn += chunk.length;
      this.bytesChanged(sessionId);
    });
    channel.on('data', (chunk: Buffer) => {
      if (toLocal) forward.info.bytesIn += chunk.length;
      else forward.info.bytesOut += chunk.length;
      this.bytesChanged(sessionId);
    });
    local.pipe(channel).pipe(local);
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      local.destroy();
      channel.destroy();
      forward.sockets.delete(local);
      forward.sockets.delete(channel);
      forward.info.connections = Math.max(0, forward.info.connections - 1);
      this.changed(sessionId);
    };
    local.on('close', end);
    local.on('error', end);
    channel.on('close', end);
    channel.on('error', end);
  }

  private close(forward: Forward) {
    forward.server?.close();
    forward.server = null;
    if (forward.remote) {
      const { client, address, port } = forward.remote;
      try {
        client.unforwardIn(address, port, () => undefined);
      } catch {
        // The connection is already gone.
      }
      forward.remote = null;
    }
    for (const socket of forward.sockets) socket.destroy();
    forward.sockets.clear();
    forward.info.connections = 0;
  }

  /* ----- Reporting ------------------------------------------------------- */

  private changed(sessionId: string) {
    clearTimeout(this.bytesTimers.get(sessionId));
    this.bytesTimers.delete(sessionId);
    this.emit(sessionId, this.ofSession(sessionId));
  }

  private bytesChanged(sessionId: string) {
    if (this.bytesTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.bytesTimers.delete(sessionId);
      this.emit(sessionId, this.ofSession(sessionId));
    }, BYTES_EMIT_MS);
    timer.unref();
    this.bytesTimers.set(sessionId, timer);
  }
}

function listenError(error: NodeJS.ErrnoException, spec: ForwardSpec): CallError {
  const where = `${spec.bindAddress}:${spec.bindPort}`;
  switch (error.code) {
    case 'EADDRINUSE':
      return new CallError('exists', `Port ${where} is already in use on this computer`);
    case 'EACCES':
      return new CallError(
        'permission_denied',
        `This computer does not allow listening on ${where} (ports below 1024 need admin rights)`,
      );
    case 'EADDRNOTAVAIL':
    case 'ENOTFOUND':
      return new CallError(
        'invalid_request',
        `${spec.bindAddress} is not an address of this computer`,
      );
    default:
      return new CallError('io', `Could not listen on ${where}`);
  }
}
