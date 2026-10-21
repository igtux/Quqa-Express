/**
 * Latency of a saved host: the time a TCP connection to its SSH port takes.
 * Nothing is sent and no login happens; the socket closes as soon as it is
 * open. (ICMP needs privileges; an SSH-level ping needs a login.)
 */
import { connect } from 'node:net';

export const PING_TIMEOUT_MS = 3000;

export function tcpPing(
  host: string,
  port: number,
  timeoutMs = PING_TIMEOUT_MS,
): Promise<{ ms: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = connect({ host, port });
    let done = false;
    const finish = (ms: number | null, error: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ms, error });
    };
    const timer = setTimeout(() => finish(null, 'No answer'), timeoutMs);
    socket.once('connect', () => finish(Math.round((performance.now() - started) * 10) / 10, null));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(null, pingError(error.code)));
  });
}

function pingError(code: string | undefined): string {
  switch (code) {
    case 'ECONNREFUSED':
      return 'Connection refused';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Unknown host name';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Host unreachable';
    case 'ETIMEDOUT':
      return 'No answer';
    default:
      return 'Not reachable';
  }
}

/** Runs `task` over `items` with at most `limit` at a time. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
