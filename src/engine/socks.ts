/**
 * The SOCKS5 handshake for dynamic forwards (-D): no authentication, CONNECT
 * only (RFC 1928). Anything else is refused with the matching reply code.
 * The connection itself leaves from the SSH server (`forwardOut`).
 */
import { isIP } from 'node:net';
import type { Socket } from 'node:net';

export interface SocksRequest {
  host: string;
  port: number;
}

const VERSION = 5;
const NO_AUTH = 0;
const NO_ACCEPTABLE = 0xff;
const CONNECT = 1;
export const REPLY = {
  succeeded: 0,
  failure: 1,
  notAllowed: 2,
  hostUnreachable: 4,
  refused: 5,
  commandNotSupported: 7,
  addressNotSupported: 8,
} as const;

/** Waits for `bytes` more bytes, keeping what arrived beyond them for the next read. */
class Reader {
  private buffer = Buffer.alloc(0);
  private waiting: {
    bytes: number;
    resolve: (b: Buffer) => void;
    reject: (e: Error) => void;
  } | null = null;
  private failed: Error | null = null;

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.once('error', (error) => this.fail(error));
    socket.once('close', () => this.fail(new Error('closed')));
  }

  private onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 1024) this.fail(new Error('too much data before the request'));
    this.check();
  };

  private fail(error: Error) {
    this.failed ??= error;
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error);
  }

  private check() {
    const waiting = this.waiting;
    if (!waiting || this.buffer.length < waiting.bytes) return;
    this.waiting = null;
    const head = this.buffer.subarray(0, waiting.bytes);
    this.buffer = this.buffer.subarray(waiting.bytes);
    waiting.resolve(Buffer.from(head));
  }

  read(bytes: number): Promise<Buffer> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiting = { bytes, resolve, reject };
      this.check();
    });
  }

  /** Stops reading; returns bytes that came after the request (the client's first data). */
  release(): Buffer {
    this.socket.off('data', this.onData);
    return this.buffer;
  }
}

/**
 * Runs the handshake on a fresh client socket. Resolves with the requested
 * destination and the bytes the client already sent after the request;
 * `reply(code)` must then be called once the outcome is known.
 */
export async function socksHandshake(
  socket: Socket,
): Promise<{ request: SocksRequest; early: Buffer }> {
  const reader = new Reader(socket);
  const [version, count] = await reader.read(2);
  if (version !== VERSION || count === undefined || count === 0) {
    socket.destroy();
    throw new Error('Not a SOCKS5 client');
  }
  const methods = await reader.read(count);
  if (!methods.includes(NO_AUTH)) {
    socket.end(Buffer.from([VERSION, NO_ACCEPTABLE]));
    throw new Error('The SOCKS client needs authentication');
  }
  socket.write(Buffer.from([VERSION, NO_AUTH]));

  const [v, command, , type] = await reader.read(4);
  if (v !== VERSION) {
    socket.destroy();
    throw new Error('Bad SOCKS request');
  }
  let host: string;
  if (type === 1) {
    host = [...(await reader.read(4))].join('.');
  } else if (type === 3) {
    const [length] = await reader.read(1);
    host = (await reader.read(length ?? 0)).toString('latin1');
  } else if (type === 4) {
    const raw = await reader.read(16);
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(raw.readUInt16BE(i).toString(16));
    host = groups.join(':');
  } else {
    socket.end(replyBytes(REPLY.addressNotSupported));
    throw new Error('Unsupported SOCKS address type');
  }
  const port = (await reader.read(2)).readUInt16BE(0);
  if (command !== CONNECT) {
    socket.end(replyBytes(REPLY.commandNotSupported));
    throw new Error('Only SOCKS CONNECT is supported');
  }
  if (!validHost(host) || port === 0) {
    socket.end(replyBytes(REPLY.addressNotSupported));
    throw new Error('Bad SOCKS destination');
  }
  return { request: { host, port }, early: reader.release() };
}

/** A SOCKS5 reply with an all-zero IPv4 bound address. */
export function replyBytes(code: number): Buffer {
  return Buffer.from([VERSION, code, 0, 1, 0, 0, 0, 0, 0, 0]);
}

const HOSTNAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,252})$/;

function validHost(host: string): boolean {
  return isIP(host) !== 0 || HOSTNAME.test(host);
}
