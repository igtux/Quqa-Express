/**
 * Local terminals (ADR 0007) with the real node-pty: the PTY engine spawns
 * the shells main would detect on this computer, with main's arguments and
 * environment. Runs everywhere `pnpm test` runs (no server needed): on Linux
 * the login shell; on Windows (CI's windows-latest) PowerShell 7, Windows
 * PowerShell and cmd through ConPTY, each checked for UTF-8 both ways with
 * Georgian text.
 */
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  detectShells,
  shellArgs,
  shellEnvironment,
  systemShellEnvironment,
  type ShellSpec,
} from '../../src/main/local-shells.js';
import type { SessionEvent, ShellId } from '../../src/shared/ipc.js';
import { loadNodePty } from '../../src/pty/node-pty.js';
import { PtyEngine } from '../../src/pty/pty-engine.js';

const GEORGIAN = 'გამარჯობა';
const GEORGIAN_UTF8 = Buffer.from(GEORGIAN, 'utf8');
const windows = process.platform === 'win32';
const shells = await detectShells(systemShellEnvironment());

class Shell {
  readonly events: SessionEvent[] = [];
  private readonly engine: PtyEngine;
  private bytes = Buffer.alloc(0);
  private ids = 0;
  readonly sessionId: string;

  constructor(shell: ShellSpec) {
    this.engine = new PtyEngine(loadNodePty(), (event) => {
      this.events.push(event);
      if (event.type === 'data') {
        this.bytes = Buffer.concat([this.bytes, Buffer.from(event.data)]);
        this.engine.handle({ type: 'ack', sessionId: event.sessionId, bytes: event.data.length });
      }
    });
    this.sessionId = `s${++this.ids}`;
    this.engine.handle({
      type: 'spawn',
      sessionId: this.sessionId,
      file: shell.file,
      args: shellArgs(shell, { home: true, platform: process.platform }),
      cwd: homedir(),
      env: shellEnvironment(process.env),
      cols: 80,
      rows: 24,
    });
  }

  /** All output so far as bytes (what the renderer receives). */
  get output(): Buffer {
    return this.bytes;
  }

  /** Output with escape sequences removed (ConPTY repaints with cursor moves). */
  get text(): string {
    return (
      this.bytes
        .toString('utf8')
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]/g, '')
    );
  }

  type(data: string) {
    this.engine.handle({ type: 'input', sessionId: this.sessionId, data, encoding: 'utf8' });
  }

  resize(cols: number, rows: number) {
    this.engine.handle({ type: 'resize', sessionId: this.sessionId, cols, rows });
  }

  kill() {
    this.engine.handle({ type: 'kill', sessionId: this.sessionId });
  }

  async waitFor(check: () => boolean, what: string, ms = 20_000) {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) {
        throw new Error(
          `Timed out waiting for ${what}; output: ${JSON.stringify(this.text.slice(-600))}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  closed(): number | null | undefined {
    const event = this.events.find((e) => e.type === 'closed');
    return event?.type === 'closed' ? event.exitCode : undefined;
  }
}

const shell = (id: ShellId) => shells.find((s) => s.id === id);

describe('local shells on this computer', () => {
  it('detects at least one shell', () => {
    expect(shells.length).toBeGreaterThan(0);
    if (windows) {
      expect(shells.map((s) => s.id)).toContain('powershell');
      expect(shells.map((s) => s.id)).toContain('cmd');
    } else {
      expect(shells[0]?.id).toBe('login');
    }
  });
});

describe.skipIf(windows)('the login shell through node-pty', () => {
  it('echoes Georgian as UTF-8, follows resizes, reports the exit code', async () => {
    const login = shell('login');
    if (!login) throw new Error('No login shell');
    const term = new Shell(login);
    await term.waitFor(() => term.events.some((e) => e.type === 'ready'), 'ready');
    // The joined word appears only in the output, never in the echoed command.
    term.type(`printf '%s%s\\n' 'გამ' 'არჯობა'\r`);
    await term.waitFor(() => term.output.includes(GEORGIAN_UTF8), 'the Georgian output');
    term.resize(100, 30);
    term.type('stty size\r');
    await term.waitFor(() => term.text.includes('30 100'), 'the new size');
    term.type('echo "TERM=$TERM COLORTERM=$COLORTERM"\r');
    await term.waitFor(
      () => term.text.includes('TERM=xterm-256color COLORTERM=truecolor'),
      'TERM and COLORTERM',
    );
    term.type('exit 7\r');
    await term.waitFor(() => term.closed() !== undefined, 'the exit');
    expect(term.closed()).toBe(7);
  });

  it('ends the shell when the tab closes', async () => {
    const login = shell('login');
    if (!login) throw new Error('No login shell');
    const term = new Shell(login);
    await term.waitFor(() => term.events.some((e) => e.type === 'ready'), 'ready');
    term.kill();
    expect(term.closed()).toBeNull();
  });
});

describe.runIf(windows)('PowerShell and cmd through ConPTY', () => {
  for (const id of ['pwsh', 'powershell'] as const) {
    it(`${id}: Write-Output of Georgian comes back as UTF-8 bytes; console in UTF-8`, async () => {
      const spec = shell(id);
      if (!spec) throw new Error(`${id} was not detected`);
      const term = new Shell(spec);
      await term.waitFor(() => /PS [^\r\n]*>/.test(term.text), 'the prompt', 45_000);
      term.type(`Write-Output ('გამ' + 'არჯობა')\r`);
      await term.waitFor(() => term.output.includes(GEORGIAN_UTF8), 'the Georgian output');
      term.type(
        'Write-Output ("enc=" + [Console]::OutputEncoding.WebName + "/" + [Console]::InputEncoding.WebName)\r',
      );
      await term.waitFor(() => term.text.includes('enc=utf-8/utf-8'), 'the console encodings');
      term.type(`Write-Output ('TERM=' + $env:TERM)\r`);
      await term.waitFor(() => term.text.includes('TERM=xterm-256color'), 'TERM');
      term.type('exit 7\r');
      await term.waitFor(() => term.closed() !== undefined, 'the exit');
      expect(term.closed()).toBe(7);
    }, 90_000);
  }

  it('cmd: code page 65001, Georgian echo', async () => {
    const spec = shell('cmd');
    if (!spec) throw new Error('cmd was not detected');
    const term = new Shell(spec);
    await term.waitFor(() => />\s*$/.test(term.text), 'the prompt', 30_000);
    term.type('chcp\r');
    await term.waitFor(() => term.text.includes('65001'), 'code page 65001');
    term.type(`echo ${GEORGIAN}\r`);
    await term.waitFor(
      () => term.text.split(GEORGIAN).length >= 3,
      'the Georgian echo (typed and printed)',
    );
    term.type('exit 5\r');
    await term.waitFor(() => term.closed() !== undefined, 'the exit');
    expect(term.closed()).toBe(5);
  }, 60_000);

  it('closing a tab ends a running PowerShell', async () => {
    const spec = shell('powershell');
    if (!spec) throw new Error('powershell was not detected');
    const term = new Shell(spec);
    await term.waitFor(() => term.events.some((e) => e.type === 'ready'), 'ready');
    term.kill();
    expect(term.closed()).toBeNull();
  }, 30_000);
});
