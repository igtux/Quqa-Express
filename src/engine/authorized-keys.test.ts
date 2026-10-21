import { describe, expect, it } from 'vitest';
import { appendText, hasAuthorizedKey } from './authorized-keys.js';

const KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF2K8STiP1WH2Lprxl+eGXhAus3a9xSArFcbGbeKFb4Y quqa@laptop';

describe('authorized_keys', () => {
  it('finds the key with or without options and comment, not in comments', () => {
    expect(hasAuthorizedKey('', KEY)).toBe(false);
    expect(hasAuthorizedKey(`${KEY}\n`, KEY)).toBe(true);
    const bare = KEY.split(' ').slice(0, 2).join(' ');
    expect(hasAuthorizedKey(`ssh-rsa AAAAB3Nza other\r\n${bare}\r\n`, KEY)).toBe(true);
    expect(hasAuthorizedKey(`no-pty,from="10.0.0.0/8" ${bare} old comment\n`, KEY)).toBe(true);
    expect(hasAuthorizedKey(`# ${KEY}\n`, KEY)).toBe(false);
    expect(hasAuthorizedKey(`${bare}X\n`, KEY)).toBe(false);
    expect(() => hasAuthorizedKey('', 'not a key')).toThrow();
  });

  it('appends on its own line', () => {
    expect(appendText('', KEY)).toBe(`${KEY}\n`);
    expect(appendText('ssh-rsa AAAA x', KEY)).toBe(`\n${KEY}\n`);
    expect(appendText('ssh-rsa AAAA x\n', `${KEY}\n`)).toBe(`${KEY}\n`);
  });
});
