import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { EngineCommand } from './engine-protocol.js';
import {
  AckMessage,
  ClipboardText,
  ConnectRequest,
  HostKeyAnswer,
  InputMessage,
  MAX_INPUT_LENGTH,
  MAX_PRIVATE_KEY_LENGTH,
  ResizeMessage,
  SessionMessage,
} from './ipc.js';

const connect = {
  host: 'server.example.com',
  port: 22,
  username: 'deploy',
  auth: { kind: 'password', password: 'secret' },
  cols: 80,
  rows: 24,
};

describe('ConnectRequest', () => {
  it('accepts password and key logins', () => {
    expect(Value.Check(ConnectRequest, connect)).toBe(true);
    expect(
      Value.Check(ConnectRequest, {
        ...connect,
        auth: { kind: 'key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----', passphrase: 'pw' },
      }),
    ).toBe(true);
    expect(
      Value.Check(ConnectRequest, { ...connect, auth: { kind: 'key', privateKey: 'k' } }),
    ).toBe(true);
  });

  it.each(['10.0.0.1', '::1', '[fe80::1]', 'host-1.lan', 'localhost', 'a.b.c.'])(
    'accepts host %s',
    (host) => expect(Value.Check(ConnectRequest, { ...connect, host })).toBe(true),
  );

  it.each([
    '',
    'two words',
    'http://example.com',
    'host;rm -rf /',
    '-oProxyCommand=x',
    'host/path',
    'a'.repeat(254),
  ])('rejects host %j', (host) => {
    expect(Value.Check(ConnectRequest, { ...connect, host })).toBe(false);
  });

  it.each(['root', 'first.last', 'DOMAIN\\user', 'user@corp.example'])(
    'accepts user %s',
    (username) => expect(Value.Check(ConnectRequest, { ...connect, username })).toBe(true),
  );

  it.each(['', 'a b', '-oX', 'x'.repeat(65), 'a\nb'])('rejects user %j', (username) => {
    expect(Value.Check(ConnectRequest, { ...connect, username })).toBe(false);
  });

  it('rejects bad ports, sizes, extra fields and unknown auth kinds', () => {
    for (const port of [0, 65536, 22.5, '22']) {
      expect(Value.Check(ConnectRequest, { ...connect, port })).toBe(false);
    }
    expect(Value.Check(ConnectRequest, { ...connect, cols: 1 })).toBe(false);
    expect(Value.Check(ConnectRequest, { ...connect, rows: 501 })).toBe(false);
    expect(Value.Check(ConnectRequest, { ...connect, extra: true })).toBe(false);
    expect(Value.Check(ConnectRequest, { ...connect, auth: { kind: 'agent' } })).toBe(false);
    expect(
      Value.Check(ConnectRequest, {
        ...connect,
        auth: { kind: 'password', password: 'x', privateKey: 'y' },
      }),
    ).toBe(false);
    expect(
      Value.Check(ConnectRequest, { ...connect, auth: { kind: 'password', password: '' } }),
    ).toBe(false);
    expect(
      Value.Check(ConnectRequest, {
        ...connect,
        auth: { kind: 'key', privateKey: 'k'.repeat(MAX_PRIVATE_KEY_LENGTH + 1) },
      }),
    ).toBe(false);
    expect(Value.Check(ConnectRequest, null)).toBe(false);
    expect(Value.Check(ConnectRequest, 'connect')).toBe(false);
  });
});

describe('session messages', () => {
  it('checks input', () => {
    expect(Value.Check(InputMessage, { sessionId: 's1', data: 'ls\r', encoding: 'utf8' })).toBe(
      true,
    );
    expect(Value.Check(InputMessage, { sessionId: 's1', data: '\x1b[M', encoding: 'binary' })).toBe(
      true,
    );
    expect(Value.Check(InputMessage, { sessionId: 's1', data: '', encoding: 'utf8' })).toBe(false);
    expect(
      Value.Check(InputMessage, {
        sessionId: 's1',
        data: 'x'.repeat(MAX_INPUT_LENGTH + 1),
        encoding: 'utf8',
      }),
    ).toBe(false);
    expect(Value.Check(InputMessage, { sessionId: 'x1', data: 'a', encoding: 'utf8' })).toBe(false);
    expect(Value.Check(InputMessage, { sessionId: 's1', data: 'a', encoding: 'hex' })).toBe(false);
  });

  it('checks resize, ack, session and host-key answers', () => {
    expect(Value.Check(ResizeMessage, { sessionId: 's2', cols: 120, rows: 40 })).toBe(true);
    expect(Value.Check(ResizeMessage, { sessionId: 's2', cols: 0, rows: 40 })).toBe(false);
    expect(Value.Check(ResizeMessage, { sessionId: 's2', cols: 1001, rows: 40 })).toBe(false);
    expect(Value.Check(AckMessage, { sessionId: 's2', bytes: 4096 })).toBe(true);
    expect(Value.Check(AckMessage, { sessionId: 's2', bytes: -1 })).toBe(false);
    expect(Value.Check(SessionMessage, { sessionId: 's2' })).toBe(true);
    expect(Value.Check(SessionMessage, { sessionId: 's2', more: 1 })).toBe(false);
    expect(Value.Check(HostKeyAnswer, { requestId: 'k1', accept: true })).toBe(true);
    expect(Value.Check(HostKeyAnswer, { requestId: 'k1', accept: 'yes' })).toBe(false);
    expect(Value.Check(HostKeyAnswer, { requestId: '../k1', accept: true })).toBe(false);
    expect(Value.Check(ClipboardText, 'hello')).toBe(true);
    expect(Value.Check(ClipboardText, 42)).toBe(false);
  });
});

describe('EngineCommand', () => {
  it('accepts each command shape', () => {
    const commands = [
      { type: 'connect', sessionId: 's1', request: connect },
      { type: 'input', sessionId: 's1', data: 'a', encoding: 'utf8' },
      { type: 'resize', sessionId: 's1', cols: 80, rows: 24 },
      { type: 'ack', sessionId: 's1', bytes: 10 },
      { type: 'disconnect', sessionId: 's1' },
      { type: 'reconnect', sessionId: 's1' },
      { type: 'host-key-answer', requestId: 'k3', accept: false },
      { type: 'shutdown' },
    ];
    for (const command of commands) expect(Value.Check(EngineCommand, command)).toBe(true);
  });

  it('rejects unknown types and extra fields', () => {
    expect(Value.Check(EngineCommand, { type: 'exec', command: 'id' })).toBe(false);
    expect(Value.Check(EngineCommand, { type: 'disconnect', sessionId: 's1', all: true })).toBe(
      false,
    );
    expect(
      Value.Check(EngineCommand, { type: 'connect', sessionId: 's1', request: { host: 'x' } }),
    ).toBe(false);
  });
});
