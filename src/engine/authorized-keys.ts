/**
 * "Install my public key on this host": appends a vault key's public half to
 * `~/.ssh/authorized_keys` over SFTP, once. `~/.ssh` is created with mode
 * 0700 and a new `authorized_keys` with 0600 (what sshd's StrictModes wants);
 * an existing file keeps its mode and contents and is only appended to.
 */
import { posix } from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import { CallError } from './errors.js';
import { NO_SUCH_FILE, sftpCall, sftpCode, translate } from './remote-files.js';

const MAX_AUTHORIZED_KEYS_BYTES = 1024 * 1024;

/** The `type base64` part of a public key line (options and comment ignored). */
function keyOf(line: string): string | null {
  const fields = line.trim().split(/\s+/);
  for (let i = 0; i < fields.length - 1; i++) {
    const type = fields[i] ?? '';
    const body = fields[i + 1] ?? '';
    if (/^(ssh-|ecdsa-|sk-)[A-Za-z0-9@.-]+$/.test(type) && /^[A-Za-z0-9+/]+={0,3}$/.test(body)) {
      return `${type} ${body}`;
    }
  }
  return null;
}

/** True if `text` (an authorized_keys file) already holds `publicKey`, with or without options. */
export function hasAuthorizedKey(text: string, publicKey: string): boolean {
  const wanted = keyOf(publicKey);
  if (!wanted) throw new CallError('invalid_key', 'That is not an OpenSSH public key');
  return text
    .split(/\r?\n/)
    .some((line) => !line.trimStart().startsWith('#') && keyOf(line) === wanted);
}

/** What to append so the file ends with the key on its own line. */
export function appendText(existing: string, publicKey: string): string {
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  return `${separator}${publicKey.trim()}\n`;
}

export async function installAuthorizedKey(
  sftp: SFTPWrapper,
  publicKey: string,
): Promise<{ added: boolean; path: string }> {
  try {
    const home = await sftpCall<string>((done) => sftp.realpath('.', done));
    const dir = posix.join(home, '.ssh');
    const path = posix.join(dir, 'authorized_keys');
    try {
      const info = await sftpCall<{ isDirectory(): boolean }>((done) => sftp.stat(dir, done));
      if (!info.isDirectory()) throw new CallError('io', '~/.ssh on the host is not a folder');
    } catch (error) {
      if (sftpCode(error) !== NO_SUCH_FILE) throw error;
      await sftpCall((done) => sftp.mkdir(dir, { mode: 0o700 }, done));
    }
    let existing = '';
    let created = false;
    try {
      const info = await sftpCall<{ size: number; isFile(): boolean }>((done) =>
        sftp.stat(path, done),
      );
      if (!info.isFile()) throw new CallError('io', 'authorized_keys on the host is not a file');
      if (info.size > MAX_AUTHORIZED_KEYS_BYTES) {
        throw new CallError('io', 'authorized_keys on the host is too large to check');
      }
      existing = (await sftpCall<Buffer>((done) => sftp.readFile(path, done))).toString('utf8');
    } catch (error) {
      if (sftpCode(error) !== NO_SUCH_FILE) throw error;
      created = true;
    }
    if (hasAuthorizedKey(existing, publicKey)) return { added: false, path };
    await sftpCall((done) =>
      sftp.appendFile(path, appendText(existing, publicKey), { mode: 0o600 }, done),
    );
    if (created) await sftpCall((done) => sftp.chmod(path, 0o600, done));
    return { added: true, path };
  } catch (error) {
    throw translate(error);
  }
}
