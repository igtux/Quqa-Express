import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quote, sh } from './shell.js';
import {
  attachCommand,
  historyScript,
  killCommand,
  listCommand,
  parseHistoryState,
  parseList,
} from './tmux.js';

const NAME = `quqa-${'0123456789abcdef'.repeat(2)}`;

// These run the scripts in a real POSIX shell, which Windows does not have.
const posix = process.platform !== 'win32';

describe('shell quoting', () => {
  it
    .runIf(posix)
    .each([`x'; touch /tmp/pwned; echo '`, '$(id)', '`id`', 'a b\tc\nd', '--help', '*', "''"])(
    'keeps %j one literal word',
    (value) => {
      const out = execFileSync('/bin/sh', ['-c', sh`printf %s ${value}`.text], {
        encoding: 'utf8',
      });
      expect(out).toBe(value);
    },
  );

  it('refuses NUL bytes', () => {
    expect(() => quote('a\0b')).toThrow();
  });
});

describe('tmux commands', () => {
  it('are built only from quqa session names', () => {
    for (const bad of ['jarvis-0', 'quqa-xyz', `${NAME}; rm -rf /`, `quqa-${'A'.repeat(32)}`, '']) {
      expect(() => attachCommand(bad)).toThrow();
      expect(() => killCommand(bad)).toThrow();
      expect(() => historyScript(bad, 'enter')).toThrow();
    }
  });

  it('attach creates or re-attaches and turns on OSC 52 passthrough', () => {
    expect(attachCommand(NAME)).toBe(
      `tmux new-session -A -s '${NAME}' ';' 'set-option' '-s' 'set-clipboard' 'on' ';' 'set-option' '-g' 'allow-passthrough' 'on'`,
    );
  });

  it('kill asks for an exact match', () => {
    expect(killCommand(NAME)).toBe(`tmux kill-session -t '=${NAME}'`);
  });

  it('history scrolls are bounded', () => {
    expect(historyScript(NAME, 'scroll', -10_000)).toContain(`-N '500' -X 'scroll-up'`);
    expect(historyScript(NAME, 'scroll', 3)).toContain(`-N '3' -X 'scroll-down'`);
    expect(historyScript(NAME, 'enter')).toContain(`tmux copy-mode -t '=${NAME}:'`);
  });

  it.runIf(posix)('list runs in a POSIX shell when tmux is missing', () => {
    // A PATH with `sh` and nothing else.
    const bin = mkdtempSync(join(tmpdir(), 'quqa-sh-'));
    symlinkSync('/bin/sh', join(bin, 'sh'));
    try {
      const out = execFileSync('/bin/sh', ['-c', listCommand()], {
        encoding: 'utf8',
        env: { PATH: bin },
      });
      expect(parseList(out).available).toBe(false);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('parseList', () => {
  it('keeps quqa sessions only, with idle time and the pane folder', () => {
    const other = 'jarvis-0123';
    const output = [
      `${NAME}|1|1000|1090|vim|/home/u/my|dir`,
      `${other}|0|1000|1000|bash|/`,
      `quqa-${'f'.repeat(32)}|0|2000|2000|bash|/tmp\r`,
      'garbage',
    ].join('\n');
    const { available, sessions } = parseList(output, 2100);
    expect(available).toBe(true);
    expect(sessions.map((s) => s.name)).toEqual([`quqa-${'f'.repeat(32)}`, NAME]);
    expect(sessions[1]).toEqual({
      name: NAME,
      attached: 1,
      createdAt: new Date(1_000_000).toISOString(),
      idleSeconds: 1010,
      path: '/home/u/my|dir',
      command: 'vim',
    });
  });

  it('reads an empty answer (no tmux server) as no sessions', () => {
    expect(parseList('')).toEqual({ available: true, sessions: [] });
  });
});

describe('parseHistoryState', () => {
  it('parses tmux reports', () => {
    expect(parseHistoryState('1 12 400\n')).toEqual({ inMode: true, position: 12, size: 400 });
    expect(parseHistoryState('0  400')).toEqual({ inMode: false, position: 0, size: 400 });
    expect(parseHistoryState('no server')).toBeNull();
  });
});
