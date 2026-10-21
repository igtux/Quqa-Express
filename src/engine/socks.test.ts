import { createServer, connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { replyBytes, REPLY, socksHandshake } from './socks.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A listener that runs the handshake on each client and reports the result. */
async function listen() {
  const results: (Awaited<ReturnType<typeof socksHandshake>> | Error)[] = [];
  const server = createServer((socket) => {
    socksHandshake(socket).then(
      (result) => {
        results.push(result);
        socket.end(replyBytes(REPLY.succeeded));
      },
      (error: Error) => results.push(error),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, results };
}

function talk(port: number, ...messages: Buffer[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const socket: Socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('connect', () => {
      for (const message of messages) socket.write(message);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks)));
    socket.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

const until = async <T>(probe: () => T | undefined) => {
  for (let i = 0; i < 200; i++) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
};

describe('SOCKS5 handshake', () => {
  it('accepts CONNECT to a domain, IPv4 and IPv6, keeping early data', async () => {
    const { port, results } = await listen();
    const domain = Buffer.from('db.internal');
    const reply = await talk(
      port,
      Buffer.from([5, 2, 2, 0]),
      Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, Buffer.from([0x15, 0x38])]),
      Buffer.from('hello'),
    );
    expect([...reply.subarray(0, 2)]).toEqual([5, 0]);
    expect(reply[3]).toBe(REPLY.succeeded);
    const first = await until(() => results[0]);
    expect(first).toMatchObject({ request: { host: 'db.internal', port: 5432 } });
    if (!(first instanceof Error)) expect(first.early.toString()).toBe('hello');

    await talk(port, Buffer.from([5, 1, 0]), Buffer.from([5, 1, 0, 1, 10, 0, 0, 7, 0, 80]));
    expect(await until(() => results[1])).toMatchObject({
      request: { host: '10.0.0.7', port: 80 },
    });

    const v6 = Buffer.alloc(16);
    v6[15] = 1;
    await talk(
      port,
      Buffer.from([5, 1, 0]),
      Buffer.concat([Buffer.from([5, 1, 0, 4]), v6, Buffer.from([0, 22])]),
    );
    expect(await until(() => results[2])).toMatchObject({
      request: { host: '0:0:0:0:0:0:0:1', port: 22 },
    });
  });

  it('refuses authentication-only clients, BIND/UDP, bad versions and bad names', async () => {
    const { port, results } = await listen();
    expect([...(await talk(port, Buffer.from([5, 1, 2])))]).toEqual([5, 0xff]);
    const bind = await talk(
      port,
      Buffer.from([5, 1, 0]),
      Buffer.from([5, 2, 0, 1, 1, 2, 3, 4, 0, 80]),
    );
    expect(bind[3]).toBe(REPLY.commandNotSupported);
    await talk(port, Buffer.from([4, 1, 0, 80, 1, 2, 3, 4, 0]));
    const bad = Buffer.from('a b;rm');
    const name = await talk(
      port,
      Buffer.from([5, 1, 0]),
      Buffer.concat([Buffer.from([5, 1, 0, 3, bad.length]), bad, Buffer.from([0, 80])]),
    );
    expect(name[3]).toBe(REPLY.addressNotSupported);
    await until(() => (results.length >= 4 ? true : undefined));
    expect(results.every((r) => r instanceof Error)).toBe(true);
  });
});
