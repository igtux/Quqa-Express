/**
 * Smoke test of the built app: the window is hardened and served from
 * app://, the vault is created and locks/unlocks, keys are generated, hosts
 * are added and found on the hosts screen, the host-key prompt and the
 * engine-side password prompt gate a session, risky pastes ask first, the
 * terminal follows resizes; two tabs, a split, the switcher, the sessions
 * dock, and a tmux session that survives closing its tab and a restart.
 *
 *   docker compose -f docker/compose.yml run --rm dev xvfb-run -a pnpm test:ui
 *
 * Note: on Linux Playwright starts Electron with --no-sandbox (Chromium's OS
 * sandbox); the renderer's web preferences are still checked below. The app
 * runs against a throw-away profile and is told to act as if the system had
 * no key store, so the vault needs a master password.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const HOST = process.env['QUQA_TEST_SSH_HOST'];
const PORT = process.env['QUQA_TEST_SSH_PORT'] ?? '22';
const USER = process.env['QUQA_TEST_SSH_USER'] ?? 'quqa';
const PASSWORD = process.env['QUQA_TEST_SSH_PASSWORD'] ?? 'quqa-test-password';
const VAULT_PASSWORD = 'ui smoke master password';
const HOST_NAME = 'test sshd';
const MARK = `mark-${Date.now().toString(36)}`;

let app: ElectronApplication;
let page: Page;
let profile: string;

test.describe.configure({ mode: 'serial' });

async function launch() {
  // QUQA_APP_EXECUTABLE: test a packaged build instead of out/ (it must be
  // built with the enableNodeCliInspectArguments fuse left on).
  const executable = process.env['QUQA_APP_EXECUTABLE'];
  app = await electron.launch({
    ...(executable && { executablePath: executable }),
    args: [...(executable ? [] : ['out/main/index.js'])],
    env: {
      ...process.env,
      QUQA_TEST_HOOKS: '1',
      QUQA_USER_DATA: profile,
      QUQA_TEST_NO_OS_KEYSTORE: '1',
    },
  });
  // Main and engine diagnostics end up in the test log.
  app.process().stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
}

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'quqa-ui-'));
  await launch();
});

test.afterAll(async () => {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
});

const terminalText = () => page.evaluate(() => window.__quqaTest?.text() ?? '');
const tabs = () => page.evaluate(() => window.__quqaTest?.tabs() ?? 0);
const panes = () => page.evaluate(() => window.__quqaTest?.panes() ?? 0);
const section = (name: string) =>
  page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name, exact: true });
const status = () => page.locator('.terminal-window:not([hidden]) [data-testid="terminal-status"]');

test('the page is served from app://, has no Node access, a strict CSP and only the bridge API', async () => {
  const facts = await page.evaluate(async () => ({
    url: location.href,
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    api: Object.keys(window.quqa).sort(),
    csp:
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content') ?? '',
    popup: window.open('https://example.com/') === null,
    outside: await fetch('app://quqa/../main/index.js').then(
      (r) => r.status,
      () => 'blocked',
    ),
    file: await fetch('file:///etc/passwd').then(
      () => 'loaded',
      () => 'blocked',
    ),
  }));
  expect(facts.url).toBe('app://quqa/index.html');
  expect(facts.require).toBe('undefined');
  expect(facts.process).toBe('undefined');
  expect(facts.api).toEqual(
    [
      'ack',
      'answerHostKey',
      'answerPrompt',
      'attention',
      'call',
      'clipboardRead',
      'clipboardWrite',
      'connect',
      'disconnect',
      'input',
      'notify',
      'onEvent',
      'onNotificationClick',
      'onVaultChange',
      'reconnect',
      'resize',
      'testHooks',
      'tmux',
      'toggleFullScreen',
    ].sort(),
  );
  expect(facts.csp).toContain("default-src 'none'");
  expect(facts.csp).toContain("script-src 'self'");
  expect(facts.csp).not.toContain('unsafe-eval');
  expect(facts.popup).toBe(true);
  expect(facts.outside).toBe(404);
  expect(facts.file).toBe('blocked');

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const web = BrowserWindow.getAllWindows()[0]?.webContents;
    const p = (
      web as unknown as { getLastWebPreferences(): Record<string, unknown> }
    ).getLastWebPreferences();
    return {
      contextIsolation: p['contextIsolation'],
      sandbox: p['sandbox'],
      nodeIntegration: p['nodeIntegration'],
    };
  });
  expect(prefs).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false });

  // Remote content is blocked.
  const fetched = await page.evaluate(() =>
    fetch('https://example.com/').then(
      () => 'loaded',
      () => 'blocked',
    ),
  );
  expect(fetched).toBe('blocked');
});

test('the main process rejects malformed IPC and secrets in intents', async () => {
  const results = await page.evaluate(async () => {
    const api = window.quqa as unknown as {
      connect(request: unknown): Promise<unknown>;
      call(method: string, params: unknown): Promise<{ ok: boolean; code?: string }>;
    };
    const connect = (request: unknown) =>
      api.connect(request).then(
        () => 'accepted',
        (e: unknown) => String(e),
      );
    const base = { host: 'server', port: 22, username: 'x', cols: 80, rows: 24 };
    const saved = { hostId: 'h_0123456789abcdef', cols: 80, rows: 24 };
    return {
      badHost: await connect({ ...base, host: 'bad host', auth: { kind: 'password' } }),
      password: await connect({ ...base, auth: { kind: 'password', password: 'x' } }),
      key: await connect({ ...base, auth: { kind: 'key', privateKey: 'x' } }),
      tmux: await connect({ ...saved, action: { type: 'shell', tmux: 'x; reboot' } }),
      command: await connect({ ...saved, action: { type: 'exec', command: 'id' } }),
      unknown: (await api.call('vault.export', {})).code,
      proto: (await api.call('__proto__', {})).code,
      path: (await api.call('keys.importFile', { label: 'k', savePassphrase: false, path: '/x' }))
        .code,
      configPath: (await api.call('sshConfig.preview', { chooseFile: false, path: '/x' })).code,
    };
  });
  expect(results.badHost).toMatch(/Invalid connection details/);
  expect(results.password).toMatch(/Invalid connection details/);
  expect(results.key).toMatch(/Invalid connection details/);
  expect(results.tmux).toMatch(/Invalid connection details/);
  expect(results.command).toMatch(/Invalid connection details/);
  expect(results.unknown).toBe('invalid_request');
  expect(results.proto).toBe('invalid_request');
  expect(results.path).toBe('invalid_request');
  expect(results.configPath).toBe('invalid_request');
});

test('creates the vault with a master password and shows the hosts screen', async () => {
  const form = page.getByRole('form', { name: 'Create vault' });
  await expect(form).toBeVisible();
  await form.getByLabel('Master password').fill(VAULT_PASSWORD);
  await form.getByLabel('Repeat the password').fill('different');
  await form.getByRole('button', { name: 'Create vault' }).click();
  await expect(form.getByRole('alert')).toHaveText(/do not match/);
  await form.getByLabel('Master password').fill(VAULT_PASSWORD);
  await form.getByLabel('Repeat the password').fill(VAULT_PASSWORD);
  await form.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByRole('region', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByText('No hosts yet.')).toBeVisible();
});

test('generates a key and shows only public data', async () => {
  await section('Keys').click();
  await page.getByLabel('New key name').fill('ui-smoke');
  await page.getByRole('button', { name: 'Generate Ed25519' }).click();
  await expect(page.getByTestId('key-fingerprint')).toHaveText(/^SHA256:[A-Za-z0-9+/]{43}$/);
  await expect(page.getByTestId('key-row')).toContainText('ssh-ed25519');
  expect(await page.content()).not.toMatch(/PRIVATE KEY/);
  await section('Hosts').click();
});

test('adds, validates, searches, duplicates and deletes hosts', async () => {
  await page.getByRole('button', { name: 'Add host' }).click();
  const form = page.getByRole('dialog', { name: 'Add host' });
  await form.getByLabel('Name').fill(HOST_NAME);
  await form.getByLabel('Address').fill('bad address');
  await form.getByLabel('User').fill(USER);
  await form.getByRole('button', { name: 'Add host' }).click();
  await expect(form.getByRole('alert')).toHaveText(/host name or IP address/);
  await form.getByLabel('Address').fill(HOST ?? '127.0.0.1');
  await form.getByLabel('Port').fill(PORT);
  await form.getByLabel('Group').fill('Lab');
  await form.getByLabel('Tags').fill('test, docker');
  await form.getByLabel(/Resumable sessions \(tmux\)/).check();
  await form.getByLabel('Notes').fill('The disposable test server');
  await form.getByRole('button', { name: 'Add host' }).click();
  await expect(form).toBeHidden();

  const card = page.getByRole('listitem', { name: HOST_NAME });
  await expect(card).toBeVisible();
  await expect(card).toContainText(`${USER}@`);
  await expect(card).toContainText('tmux');
  await expect(card).toContainText('#docker');
  // Latency is checked on its own (TCP connect to the SSH port).
  if (HOST) await expect(card.locator('.ssh-card-latency')).toHaveText(/^\d+ ms$/);

  // Duplicate, then search, then delete the copy.
  await card.getByRole('button', { name: `Duplicate ${HOST_NAME}` }).click();
  const copy = page.getByRole('dialog', { name: `Duplicate ${HOST_NAME}` });
  await copy.getByLabel('Name').fill('scratch copy');
  await copy.getByRole('button', { name: 'Add host' }).click();
  await expect(page.getByTestId('host-card')).toHaveCount(2);
  await page.getByLabel('Search hosts').fill('scratch');
  await expect(page.getByTestId('host-card')).toHaveCount(1);
  await page.getByLabel('Search hosts').fill('tag:docker');
  await expect(page.getByTestId('host-card')).toHaveCount(2);
  await page.getByLabel('Search hosts').fill('');
  await page.getByRole('button', { name: 'Delete scratch copy' }).click();
  await page
    .getByRole('dialog', { name: 'Delete scratch copy?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(page.getByTestId('host-card')).toHaveCount(1);
  await expect(page.getByTestId('hosts-stats')).toContainText('1 host');
});

test('connects, verifies the host key, asks for the password, warns on a risky paste, resizes', async () => {
  test.skip(!HOST, 'QUQA_TEST_SSH_HOST is not set');
  await page.getByRole('button', { name: `Open a terminal on ${HOST_NAME}` }).click();

  const dialog = page.getByRole('dialog', { name: 'Unknown host key' });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('host-key-fingerprint')).toContainText(/SHA256:[A-Za-z0-9+/]{43}/);
  await dialog.getByRole('button', { name: 'Accept and connect' }).click();

  const login = page.getByRole('dialog', { name: /^Password for / });
  await expect(login).toBeVisible();
  await login.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await login.getByLabel('Save the password in the vault').check();
  await login.getByRole('button', { name: 'Log in' }).click();

  await expect(status()).toHaveText('Connected');
  expect(['webgl', 'dom']).toContain(await page.evaluate(() => window.__quqaTest?.renderer()));
  // tmux is installed on the test server: the terminal runs in a quqa session.
  expect(await page.evaluate(() => window.__quqaTest?.tmux())).toMatch(/^quqa-[0-9a-f]{32}$/);

  await page.keyboard.type("echo ui''-ok\n");
  await expect.poll(terminalText).toMatch(/ui-ok/);

  // A paste with an escape sequence (it could end bracketed paste) asks first.
  await app.evaluate(({ clipboard }) => clipboard.writeText('echo pasted\u001b[201~; id\n'));
  await page.keyboard.press('Control+Shift+V');
  const paste = page.getByRole('dialog', { name: 'Paste this?' });
  await expect(paste).toBeVisible();
  await expect(page.getByTestId('paste-preview')).toContainText('⟨ESC⟩[201~');
  await paste.getByRole('button', { name: 'Cancel' }).click();
  await expect(paste).toBeHidden();
  expect(await terminalText()).not.toMatch(/pasted/);
  await expect(page.getByRole('textbox', { name: 'Terminal input' }).first()).toBeFocused();

  await page.keyboard.type('clear; stty size\n');
  await expect.poll(terminalText).toMatch(/^\d+ \d+\s*$/m);
  const before = (await terminalText()).match(/^(\d+) (\d+)\s*$/m)?.[0];

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 560));
  await page.waitForTimeout(600);
  await page.keyboard.type('clear; stty size\n');
  await expect
    .poll(async () => (await terminalText()).match(/^(\d+) (\d+)\s*$/m)?.[0])
    .not.toBe(before);
});

test('opens a second tab with the saved password, splits it, and switches with Ctrl+Shift+K', async () => {
  test.skip(!HOST, 'QUQA_TEST_SSH_HOST is not set');
  await page.keyboard.press('Control+Shift+T');
  await expect.poll(tabs).toBe(2);
  await expect(page.getByTestId('app-tab')).toHaveCount(2);
  await expect(status()).toHaveText('Connected');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.type(`export QUQA_MARK=${MARK}; echo second-tab\n`);
  await expect.poll(terminalText).toMatch(/^second-tab/m);
  // Rename it (double-click the tab); the name sticks to its tmux session.
  await page.getByTestId('app-tab').nth(1).dblclick();
  await page.getByLabel('Session name').fill('marked');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('app-tab').nth(1)).toContainText('marked');

  // Split side by side: a second pane in the same tab, with pane headers.
  await page.keyboard.press('Control+Shift+D');
  await expect.poll(panes).toBe(2);
  const visibleTab = page.locator('.terminal-window:not([hidden])');
  await expect(visibleTab.getByTestId('terminal-body')).toHaveClass(/split-view/);
  await expect(visibleTab.getByTestId('terminal-pane')).toHaveCount(2);
  await expect(visibleTab.locator('.terminal-pane.active-pane')).toHaveCount(1);
  await expect(visibleTab.locator('.terminal-pane[data-state="connected"]')).toHaveCount(2);
  await page.keyboard.type('echo in-split\n');
  await expect.poll(terminalText).toMatch(/^in-split/m);
  // Closing a pane returns to single view.
  await visibleTab.getByRole('button', { name: 'Close this pane' }).last().click();
  await expect.poll(panes).toBe(1);
  await expect(visibleTab.getByTestId('terminal-body')).not.toHaveClass(/split-view/);

  // The switcher lists both sessions and jumps between them.
  await page.keyboard.press('Control+Shift+K');
  const switcher = page.getByRole('dialog', { name: 'Switch terminal session' });
  await expect(switcher).toBeVisible();
  await expect(switcher.getByRole('option')).toHaveCount(2);
  await switcher.getByLabel('Find a session').fill('tsshd');
  await expect(switcher.getByRole('option')).toHaveCount(2);
  await switcher.getByLabel('Find a session').fill('zzzz');
  await expect(switcher.getByRole('option')).toHaveCount(0);
  await switcher.getByLabel('Find a session').fill('mrkd');
  await expect(switcher.getByRole('option')).toHaveCount(1);
  await switcher.getByLabel('Find a session').fill('');
  // Sorted by name: "marked" (this tab) first, then the first tab.
  await expect(switcher.getByRole('option').first()).toContainText('marked');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(switcher).toBeHidden();
  await expect(page.getByTestId('app-tab').first()).toHaveAttribute('aria-selected', 'true');
  // The first tab's last command was `clear; stty size`.
  expect(await terminalText()).toMatch(/^\d+ \d+\s*$/m);
  expect(await terminalText()).not.toMatch(/second-tab/);

  // Ctrl+Tab cycles tabs.
  await page.keyboard.press('Control+Tab');
  await expect(page.getByTestId('app-tab').nth(1)).toHaveAttribute('aria-selected', 'true');
});

test('keeps a tmux session when its tab closes and re-attaches it from the host', async () => {
  test.skip(!HOST, 'QUQA_TEST_SSH_HOST is not set');
  // Close the second tab: tmux keeps running on the host.
  await page
    .getByTestId('app-tab')
    .nth(1)
    .getByRole('button', { name: /^Close / })
    .click();
  await expect.poll(tabs).toBe(1);

  // The dock lists the open terminal and the detached session.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  const dock = page.getByRole('dialog', { name: 'Sessions' });
  await expect(dock).toBeVisible();
  // The open terminal, the closed tab's session and the closed pane's session
  // (and any session an earlier, interrupted run left on the server).
  await expect.poll(() => dock.getByTestId('dock-row').count()).toBeGreaterThanOrEqual(3);
  await expect(dock.getByTestId('dock-row').filter({ hasText: 'marked' })).toContainText(
    'Detached',
  );
  await dock.getByRole('button', { name: 'Close panel' }).click();

  await page.getByRole('tab', { name: 'Hosts' }).first().click();
  await page.getByRole('button', { name: `Sessions on ${HOST_NAME}` }).click();
  const sessions = page.getByRole('dialog', { name: `Sessions on ${HOST_NAME}` });
  await expect.poll(() => sessions.getByTestId('host-session').count()).toBeGreaterThanOrEqual(2);
  await sessions
    .getByTestId('host-session')
    .filter({ hasText: 'marked' })
    .getByRole('button', { name: 'Attach' })
    .click();
  await expect.poll(tabs).toBe(2);
  await expect(status()).toHaveText('Connected');
  await page.keyboard.type('echo got-$QUQA_MARK\n');
  await expect.poll(terminalText).toMatch(new RegExp(`got-${MARK}`));
});

test('keeps hosts and secrets sealed in the vault file', async () => {
  const text = readFileSync(join(profile, 'vault.json'), 'utf8');
  expect(text).toContain('"format": "quqa-vault"');
  expect(text).not.toContain(VAULT_PASSWORD);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toMatch(/PRIVATE KEY|ui-smoke|test sshd|The disposable/);
  if (HOST) expect(text).not.toContain(HOST);
});

test('locks and unlocks the vault over open terminals', async () => {
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  const form = page.getByRole('form', { name: 'Unlock vault' });
  await expect(form).toBeVisible();
  await form.getByLabel('Master password').fill('wrong password');
  await form.getByRole('button', { name: 'Unlock' }).click();
  await expect(form.getByRole('alert')).toHaveText('Wrong master password');
  await form.getByLabel('Master password').fill(VAULT_PASSWORD);
  await form.getByRole('button', { name: 'Unlock' }).click();
  await expect(form).toBeHidden();
});

test('re-opens the tabs after a restart and re-attaches the tmux session', async () => {
  test.skip(!HOST, 'QUQA_TEST_SSH_HOST is not set');
  // Let the debounced layout save reach the vault.
  await page.waitForTimeout(800);
  await app.close();
  await launch();
  const form = page.getByRole('form', { name: 'Unlock vault' });
  await form.getByLabel('Master password').fill(VAULT_PASSWORD);
  await form.getByRole('button', { name: 'Unlock' }).click();
  await expect.poll(tabs).toBe(2);
  await page.getByTestId('app-tab').nth(1).click();
  await expect(status()).toHaveText('Connected');
  await page.keyboard.type('echo again-$QUQA_MARK\n');
  await expect.poll(terminalText).toMatch(new RegExp(`again-${MARK}`));

  // End it on the host from the dock (with a confirm); its tab closes.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  const dock = page.getByRole('dialog', { name: 'Sessions' });
  const row = dock.getByTestId('dock-row').filter({ hasText: 'Live' });
  await row.first().click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await dock.getByRole('button', { name: 'Close all' }).click();
  await page
    .getByRole('dialog', { name: 'Close every terminal?' })
    .getByRole('button', { name: 'Close all' })
    .click();
  await expect.poll(tabs).toBe(0);
  await dock.getByRole('button', { name: 'Close panel' }).click();

  // End the sessions on the host (each with a confirm), so test runs do not pile them up.
  await page.getByRole('tab', { name: 'Hosts' }).first().click();
  await page.getByRole('button', { name: `Sessions on ${HOST_NAME}` }).click();
  const sessions = page.getByRole('dialog', { name: `Sessions on ${HOST_NAME}` });
  const rows = sessions.getByTestId('host-session');
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(3);
  for (let left = await rows.count(); left > 0; left--) {
    await rows.first().getByRole('button', { name: 'End…' }).click();
    await page
      .getByRole('dialog', { name: 'End this session on the host?' })
      .getByRole('button', { name: 'End session' })
      .click();
    await expect(rows).toHaveCount(left - 1);
  }
  await sessions.getByRole('button', { name: 'Refresh' }).click();
  await expect(sessions).toContainText('No detached sessions');
});
