import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';
import { EngineCalls, EngineCommand } from './engine-protocol.js';
import { PtyCommand } from './pty-protocol.js';
import {
  AckMessage,
  AppCalls,
  ClipboardText,
  ConnectRequest,
  HostKeyAnswer,
  InputMessage,
  LocalOpenRequest,
  MAX_CLIPBOARD_LENGTH,
  MAX_INPUT_LENGTH,
  MAX_PRIVATE_KEY_LENGTH,
  PromptAnswer,
  NotifyMessage,
  ResizeMessage,
  SessionMessage,
  TmuxMessage,
  UiState,
} from './ipc.js';

const connect = {
  host: 'server.example.com',
  port: 22,
  username: 'deploy',
  auth: { kind: 'password' },
  cols: 80,
  rows: 24,
};

describe('ConnectRequest', () => {
  it('accepts password logins and stored keys by id, never secrets', () => {
    expect(Value.Check(ConnectRequest, connect)).toBe(true);
    expect(
      Value.Check(ConnectRequest, {
        ...connect,
        auth: { kind: 'key', keyId: 'key_0123456789abcdef' },
      }),
    ).toBe(true);
    for (const auth of [
      { kind: 'password', password: 'secret' },
      { kind: 'key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----' },
      { kind: 'key', keyId: 'key_0123456789abcdef', passphrase: 'pw' },
      { kind: 'key', keyId: '../key' },
      { kind: 'key', keyId: 'key_0123456789ABCDEF' },
    ]) {
      expect(Value.Check(ConnectRequest, { ...connect, auth })).toBe(false);
    }
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
    expect(Value.Check(ConnectRequest, { ...connect, auth: { kind: 'key' } })).toBe(false);
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

  it('carries Georgian, Mtavruli and emoji paste text exactly, within the limits', () => {
    const georgian = 'გამარჯობა, მსოფლიო! ქართული ტექსტი — ႢႠႰႨႡ ᲒᲐᲛᲐᲠᲯᲝᲑᲐ 🇬🇪👋';
    expect(Value.Check(ClipboardText, georgian)).toBe(true);
    expect(Value.Check(InputMessage, { sessionId: 's1', data: georgian, encoding: 'utf8' })).toBe(
      true,
    );
    expect(Value.Check(ClipboardText, 'x'.repeat(MAX_CLIPBOARD_LENGTH + 1))).toBe(false);
  });

  it('checks prompt answers', () => {
    expect(Value.Check(PromptAnswer, { requestId: 'p1', answers: ['pw'], remember: false })).toBe(
      true,
    );
    expect(Value.Check(PromptAnswer, { requestId: 'p1', answers: null, remember: false })).toBe(
      true,
    );
    expect(Value.Check(PromptAnswer, { requestId: 'k1', answers: [], remember: false })).toBe(
      false,
    );
    expect(Value.Check(PromptAnswer, { requestId: 'p1', answers: ['x'] })).toBe(false);
    expect(
      Value.Check(PromptAnswer, {
        requestId: 'p1',
        answers: Array.from({ length: 11 }, () => 'a'),
        remember: false,
      }),
    ).toBe(false);
    expect(
      Value.Check(PromptAnswer, { requestId: 'p1', answers: ['x'.repeat(1025)], remember: false }),
    ).toBe(false);
  });
});

describe('AppCalls', () => {
  const check = (method: keyof typeof AppCalls, params: unknown) =>
    Value.Check(AppCalls[method].params, params);

  it('accepts well-formed parameters', () => {
    expect(check('vault.status', {})).toBe(true);
    expect(check('vault.create', {})).toBe(true);
    expect(check('vault.create', { password: 'long enough', portable: true })).toBe(true);
    expect(check('keys.generate', { label: 'laptop 2026' })).toBe(true);
    expect(
      check('keys.import', { label: 'k', privateKey: '-----BEGIN', savePassphrase: false }),
    ).toBe(true);
    expect(check('hostKeys.forget', { host: 'server', port: 22 })).toBe(true);
    expect(check('hostKeys.replace', { requestId: 'c12' })).toBe(true);
    expect(check('vault.updateSettings', { autoLockMinutes: 15, lockOnSleep: true })).toBe(true);
  });

  it('rejects hostile parameters', () => {
    expect(check('vault.status', { extra: 1 })).toBe(false);
    expect(check('vault.create', { password: '' })).toBe(false);
    expect(check('keys.generate', { label: '' })).toBe(false);
    expect(check('keys.generate', { label: 'two\nlines' })).toBe(false);
    expect(check('keys.generate', { label: 'tab\there' })).toBe(false);
    expect(check('keys.generate', { label: 'x'.repeat(65) })).toBe(false);
    expect(
      check('keys.import', {
        label: 'k',
        privateKey: 'k'.repeat(MAX_PRIVATE_KEY_LENGTH + 1),
        savePassphrase: false,
      }),
    ).toBe(false);
    // The renderer never names a file path; main asks with its own dialog.
    expect(
      check('keys.importFile', { label: 'k', savePassphrase: false, path: '/etc/shadow' }),
    ).toBe(false);
    expect(check('hostKeys.importKnownHosts', { chooseFile: false, path: '/x' })).toBe(false);
    expect(check('keys.delete', { id: '../../vault' })).toBe(false);
    expect(check('hostKeys.forget', { host: 'a b', port: 22 })).toBe(false);
    expect(check('hostKeys.replace', { requestId: 'k1' })).toBe(false);
    expect(check('vault.updateSettings', { autoLockMinutes: -1, lockOnSleep: true })).toBe(false);
  });

  it('never returns a field that could hold a secret', () => {
    const secretish = /private|passphrase|password|secret|osKey|dataKey|^key$/i;
    const offenders: string[] = [];
    const walk = (schema: unknown, path: string) => {
      if (typeof schema !== 'object' || schema === null) return;
      const node = schema as Record<string, unknown>;
      const properties = node['properties'] as Record<string, unknown> | undefined;
      for (const [name, child] of Object.entries(properties ?? {})) {
        const flag = (child as { type?: unknown }).type === 'boolean';
        if (secretish.test(name) && !flag) offenders.push(`${path}.${name}`);
        walk(child, `${path}.${name}`);
      }
      for (const key of ['anyOf', 'oneOf', 'allOf']) {
        for (const child of (node[key] as unknown[] | undefined) ?? []) walk(child, path);
      }
      walk(node['items'], `${path}[]`);
      if (typeof node['additionalProperties'] === 'object') {
        walk(node['additionalProperties'], `${path}{}`);
      }
      if (properties && node['additionalProperties'] !== false) offenders.push(`${path} (open)`);
    };
    for (const [method, { result }] of Object.entries(AppCalls)) walk(result, method);
    for (const [method, { result }] of Object.entries(EngineCalls))
      walk(result, `engine:${method}`);
    expect(offenders).toEqual([]);
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
      { type: 'prompt-answer', requestId: 'p3', answers: ['pw'], remember: true },
      { type: 'call', callId: 1, method: 'keys.list', params: {} },
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

describe('Phase 3 messages', () => {
  const NAME = `quqa-${'0123456789abcdef'.repeat(2)}`;
  const hostConnect = (action: unknown) => ({
    hostId: 'h_0123456789abcdef',
    action,
    cols: 80,
    rows: 24,
  });

  it('connects to a saved host by id only, with a tmux name of our own pattern', () => {
    expect(Value.Check(ConnectRequest, hostConnect({ type: 'shell', tmux: NAME }))).toBe(true);
    expect(Value.Check(ConnectRequest, hostConnect({ type: 'shell', tmux: null }))).toBe(true);
    expect(Value.Check(ConnectRequest, hostConnect({ type: 'list' }))).toBe(true);
    expect(Value.Check(ConnectRequest, hostConnect({ type: 'end', session: NAME }))).toBe(true);
    for (const action of [
      { type: 'shell', tmux: 'jarvis-0' },
      { type: 'shell', tmux: `${NAME}; reboot` },
      { type: 'shell', tmux: NAME, command: 'id' },
      { type: 'end', session: '-t evil' },
      { type: 'exec', command: 'id' },
    ]) {
      expect(Value.Check(ConnectRequest, hostConnect(action))).toBe(false);
    }
    expect(
      Value.Check(ConnectRequest, { ...hostConnect({ type: 'list' }), host: 'x', password: 'x' }),
    ).toBe(false);
    expect(Value.Check(ConnectRequest, { ...hostConnect({ type: 'list' }), hostId: 'h_x' })).toBe(
      false,
    );
  });

  it('checks tmux list / end / history messages', () => {
    expect(Value.Check(TmuxMessage, { sessionId: 's1', op: 'list' })).toBe(true);
    expect(Value.Check(TmuxMessage, { sessionId: 's1', op: 'end', session: NAME })).toBe(true);
    expect(
      Value.Check(TmuxMessage, { sessionId: 's1', op: 'history', action: 'scroll', lines: -20 }),
    ).toBe(true);
    expect(Value.Check(TmuxMessage, { sessionId: 's1', op: 'end', session: 'x' })).toBe(false);
    expect(
      Value.Check(TmuxMessage, { sessionId: 's1', op: 'history', action: 'scroll', lines: 501 }),
    ).toBe(false);
    expect(
      Value.Check(TmuxMessage, { sessionId: 's1', op: 'history', action: 'send-keys', lines: 0 }),
    ).toBe(false);
    expect(Value.Check(TmuxMessage, { sessionId: 's1', op: 'run', command: 'id' })).toBe(false);
  });

  it('checks notifications: short single lines and our tags', () => {
    expect(Value.Check(NotifyMessage, { title: 'web needs you', body: 'web', tag: 't3' })).toBe(
      true,
    );
    expect(Value.Check(NotifyMessage, { title: 'a\u001b]8;;x', body: '', tag: 't3' })).toBe(false);
    expect(Value.Check(NotifyMessage, { title: 'x'.repeat(121), body: '', tag: 't3' })).toBe(false);
    expect(Value.Check(NotifyMessage, { title: 'x', body: '', tag: 'file:///x' })).toBe(false);
  });

  it('keeps the UI state free of secrets and bounded', () => {
    const ui = {
      scheme: 'dracula',
      font: 'system',
      zoom: 0,
      notifications: true,
      sound: false,
      restoreTabs: true,
      groupDock: true,
      favorites: [{ hostId: 'h_0123456789abcdef', session: NAME }],
      aliases: [{ session: NAME, label: 'build' }],
      forgotten: [],
      layout: {
        tabs: [{ split: 'h', panes: [{ hostId: 'h_0123456789abcdef', session: null }] }],
        active: 0,
      },
    };
    expect(Value.Check(UiState, ui)).toBe(true);
    expect(Value.Check(UiState, { ...ui, password: 'x' })).toBe(false);
    expect(Value.Check(UiState, { ...ui, zoom: 99 })).toBe(false);
    expect(Value.Check(UiState, { ...ui, scheme: '../x' })).toBe(false);
    expect(
      Value.Check(UiState, {
        ...ui,
        layout: { tabs: [{ split: 'h', panes: [] }], active: 0 },
      }),
    ).toBe(false);
  });

  it('never lets the renderer name a file for the ssh config import', () => {
    const check = (method: keyof typeof AppCalls, params: unknown) =>
      Value.Check(AppCalls[method].params, params);
    expect(check('sshConfig.preview', { chooseFile: false })).toBe(true);
    expect(check('sshConfig.preview', { chooseFile: false, path: '/etc/passwd' })).toBe(false);
    expect(
      check('sshConfig.import', {
        token: 'a'.repeat(32),
        aliases: ['web'],
        importKeys: true,
        tmux: false,
      }),
    ).toBe(true);
    expect(
      check('sshConfig.import', {
        token: 'a'.repeat(32),
        aliases: ['web'],
        importKeys: true,
        tmux: false,
        identityFile: '/etc/shadow',
      }),
    ).toBe(false);
    expect(check('hosts.ping', { ids: [] })).toBe(false);
    expect(check('hosts.delete', { id: 'h_0123456789abcdef' })).toBe(false);
  });
});

describe('Phase 4 calls', () => {
  const check = (method: keyof typeof AppCalls, params: unknown) =>
    Value.Check(AppCalls[method].params, params);
  const sessionId = 's1';

  it('takes absolute remote paths and plain new names only', () => {
    expect(check('files.list', { sessionId })).toBe(true);
    expect(check('files.list', { sessionId, path: '/home/me' })).toBe(true);
    expect(check('files.list', { sessionId, path: '/C:/Users/me' })).toBe(true);
    for (const path of ['home/me', '~/x', '', '/a\u0000b', `/${'a'.repeat(5000)}`]) {
      expect(check('files.list', { sessionId, path })).toBe(false);
    }
    expect(check('files.list', { sessionId: 'x; rm', path: '/' })).toBe(false);
    const mkdir = (name: string) => check('files.mkdir', { sessionId, parent: '/tmp', name });
    expect(mkdir('reports 2026')).toBe(true);
    for (const name of ['', '.', '..', 'a/b', 'a\nb', 'x'.repeat(256)]) {
      expect(mkdir(name)).toBe(false);
    }
    expect(mkdir('...')).toBe(true);
  });

  it('uploads by grant only, never by local path', () => {
    const upload = {
      sessionId,
      directory: null,
      grants: ['g0123456789abcdef01234567'],
      conflict: 'ask',
      wait: false,
    };
    expect(check('files.upload', upload)).toBe(true);
    expect(check('files.upload', { ...upload, grants: ['/etc/passwd'] })).toBe(false);
    expect(check('files.upload', { ...upload, files: [{ path: '/etc/shadow', name: 'x' }] })).toBe(
      false,
    );
    expect(check('files.upload', { ...upload, conflict: 'clobber' })).toBe(false);
    expect(check('files.download', { sessionId, paths: ['/var/log/syslog'] })).toBe(true);
    expect(check('files.download', { sessionId, paths: ['/x'], folder: '/tmp' })).toBe(false);
    // The clipboard intent names only the session: main reads the clipboard itself.
    expect(check('files.pasteClipboard', { sessionId })).toBe(true);
    expect(check('files.pasteClipboard', { sessionId, path: '/tmp/x.png' })).toBe(false);
    expect(check('files.pasteClipboard', { sessionId, format: 'FileNameW' })).toBe(false);
    expect(check('files.pasteClipboard', { sessionId: '../s1' })).toBe(false);
    expect(check('files.pasteClipboard', {})).toBe(false);
  });

  it('takes forwards with an explicit public opt-in and valid addresses', () => {
    const spec = {
      kind: 'local',
      bindAddress: '127.0.0.1',
      bindPort: 8080,
      destHost: 'db.internal',
      destPort: 5432,
      allowPublic: false,
    };
    expect(check('forwards.start', { sessionId, spec })).toBe(true);
    expect(
      check('forwards.start', {
        sessionId,
        spec: { ...spec, kind: 'dynamic', destHost: '', destPort: 0 },
      }),
    ).toBe(true);
    for (const bad of [
      { bindAddress: 'a b' },
      { bindPort: 0 },
      { bindPort: 70000 },
      { destHost: 'x;y' },
      { kind: 'x11' },
      { allowPublic: 'yes' },
      { command: 'id' },
    ]) {
      expect(check('forwards.start', { sessionId, spec: { ...spec, ...bad } })).toBe(false);
    }
  });

  it('chooses agents only by kind, never by socket path', () => {
    expect(check('agent.list', { agent: 'system' })).toBe(true);
    expect(check('agent.list', { agent: 'pageant' })).toBe(true);
    expect(check('agent.list', { agent: '/tmp/evil.sock' })).toBe(false);
    expect(
      Value.Check(ConnectRequest, { ...connect, auth: { kind: 'agent', agent: 'system' } }),
    ).toBe(true);
    expect(
      Value.Check(ConnectRequest, { ...connect, auth: { kind: 'agent', path: '/tmp/a.sock' } }),
    ).toBe(false);
  });

  it('checks the new host fields', () => {
    const host = {
      name: 'web',
      address: 'web.example.com',
      port: 22,
      username: 'me',
      auth: { kind: 'password' },
      os: 'linux',
      group: '',
      tags: [],
      notes: '',
      color: '',
      tmux: false,
      jumpHostId: null,
      proxyJump: '',
      scheme: '',
      font: '',
      agentForward: false,
      fileRoots: ['/srv/app'],
      uploadDir: '~/uploads',
      osc52: 'ask',
      forwards: [],
    };
    expect(check('hosts.save', { host })).toBe(true);
    for (const bad of [
      { fileRoots: ['srv'] },
      { uploadDir: 'uploads' },
      { uploadDir: '~/a\nb' },
      { osc52: 'always' },
      { forwards: [{ id: 'f_x' }] },
    ]) {
      expect(check('hosts.save', { host: { ...host, ...bad } })).toBe(false);
    }
    expect(check('hosts.setOsc52', { id: 'h_0123456789abcdef', policy: 'allow' })).toBe(true);
    expect(check('hosts.setOsc52', { id: 'h_0123456789abcdef', policy: 'read' })).toBe(false);
  });

  it('lets the engine receive local paths only from main', () => {
    const engineUpload = EngineCalls['files.upload'].params;
    expect(
      Value.Check(engineUpload, {
        sessionId,
        directory: null,
        files: [{ path: '/tmp/clipboard_1.png', name: 'clipboard_1.png' }],
        conflict: 'rename',
        wait: true,
      }),
    ).toBe(true);
    // The renderer's call has no `files`, the engine's no `grants`.
    expect(
      Value.Check(engineUpload, {
        sessionId,
        directory: null,
        grants: ['g'],
        conflict: 'ask',
        wait: false,
      }),
    ).toBe(false);
  });
});

describe('local terminals (ADR 0007)', () => {
  const open = { shellId: 'pwsh', folder: null, cols: 120, rows: 30 };
  const check = (method: keyof typeof AppCalls, params: unknown) =>
    Value.Check(AppCalls[method].params, params);

  it('opens a detected shell by id, in the home folder or a chosen folder by token', () => {
    expect(Value.Check(LocalOpenRequest, open)).toBe(true);
    for (const shellId of ['pwsh', 'powershell', 'cmd', 'wsl', 'login']) {
      expect(Value.Check(LocalOpenRequest, { ...open, shellId })).toBe(true);
    }
    expect(Value.Check(LocalOpenRequest, { ...open, folder: `d${'a1'.repeat(12)}` })).toBe(true);
  });

  it('never takes a program, a command line, arguments or a path from the renderer', () => {
    const hostile: unknown[] = [
      { ...open, shellId: 'C:\\Windows\\System32\\cmd.exe' },
      { ...open, shellId: 'pwsh -c calc' },
      { ...open, shellId: 'bash' },
      { ...open, command: 'calc.exe' },
      { ...open, args: ['-c', 'rm -rf ~'] },
      { ...open, env: { PATH: '/tmp' } },
      { ...open, cwd: 'C:\\' },
      { ...open, folder: 'C:\\Users' },
      { ...open, folder: '/etc' },
      { ...open, folder: `g${'a1'.repeat(12)}` },
      { ...open, cols: 0 },
      { shellId: 'pwsh', folder: null },
    ];
    for (const request of hostile) expect(Value.Check(LocalOpenRequest, request)).toBe(false);
  });

  it('checks the local calls and the default-shell setting', () => {
    expect(check('local.shells', {})).toBe(true);
    expect(check('local.shells', { platform: 'win32' })).toBe(false);
    expect(check('local.chooseFolder', {})).toBe(true);
    expect(check('local.chooseFolder', { path: 'C:\\' })).toBe(false);
    expect(check('local.pasteClipboard', { sessionId: 's3' })).toBe(true);
    expect(check('local.pasteClipboard', { sessionId: 's3', path: '/tmp/x' })).toBe(false);
    expect(check('local.droppedPaths', { grants: [`g${'0'.repeat(24)}`] })).toBe(true);
    expect(check('local.droppedPaths', { grants: ['/etc/passwd'] })).toBe(false);
    expect(check('app.setSettings', { localShell: 'cmd' })).toBe(true);
    expect(check('app.setSettings', { localShell: null })).toBe(true);
    expect(check('app.setSettings', { localShell: 'C:\\evil.exe' })).toBe(false);
  });

  it('lets the PTY process receive a program and its arguments only from main', () => {
    const spawn = {
      type: 'spawn',
      sessionId: 's1',
      file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      args: ['-NoLogo'],
      cwd: 'C:\\Users\\me',
      env: { TERM: 'xterm-256color' },
      cols: 80,
      rows: 24,
    };
    expect(Value.Check(PtyCommand, spawn)).toBe(true);
    expect(Value.Check(PtyCommand, { ...spawn, shell: true })).toBe(false);
    expect(Value.Check(PtyCommand, { type: 'kill', sessionId: 's1' })).toBe(true);
    expect(Value.Check(PtyCommand, { type: 'kill', sessionId: 's1', signal: 'SIGKILL' })).toBe(
      false,
    );
  });
});
