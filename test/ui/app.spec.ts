/**
 * Smoke test of the built app: the window is hardened and served from
 * app://, the vault is created and locks/unlocks, keys are generated, the
 * host-key prompt and the engine-side password prompt gate a session, risky
 * pastes ask first, and the terminal shows remote output and follows resizes.
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

let app: ElectronApplication;
let page: Page;
let profile: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'quqa-ui-'));
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
});

test.afterAll(async () => {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
});

const terminalText = () => page.evaluate(() => window.__quqaTest?.text() ?? '');

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
      'onEvent',
      'onVaultChange',
      'reconnect',
      'resize',
      'testHooks',
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
    return {
      badHost: await connect({ ...base, host: 'bad host', auth: { kind: 'password' } }),
      password: await connect({ ...base, auth: { kind: 'password', password: 'x' } }),
      key: await connect({ ...base, auth: { kind: 'key', privateKey: 'x' } }),
      unknown: (await api.call('vault.export', {})).code,
      proto: (await api.call('__proto__', {})).code,
      path: (await api.call('keys.importFile', { label: 'k', savePassphrase: false, path: '/x' }))
        .code,
    };
  });
  expect(results.badHost).toMatch(/Invalid connection details/);
  expect(results.password).toMatch(/Invalid connection details/);
  expect(results.key).toMatch(/Invalid connection details/);
  expect(results.unknown).toBe('invalid_request');
  expect(results.proto).toBe('invalid_request');
  expect(results.path).toBe('invalid_request');
});

test('creates the vault with a master password', async () => {
  const form = page.getByRole('form', { name: 'Create vault' });
  await expect(form).toBeVisible();
  await form.getByLabel('Master password').fill(VAULT_PASSWORD);
  await form.getByLabel('Repeat the password').fill('different');
  await form.getByRole('button', { name: 'Create vault' }).click();
  await expect(form.getByRole('alert')).toHaveText(/do not match/);
  await form.getByLabel('Master password').fill(VAULT_PASSWORD);
  await form.getByLabel('Repeat the password').fill(VAULT_PASSWORD);
  await form.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByRole('form', { name: 'Quick connect' })).toBeVisible();
});

test('generates a key and shows only public data', async () => {
  await page.getByRole('tab', { name: 'Keys', exact: true }).click();
  await page.getByLabel('New key name').fill('ui-smoke');
  await page.getByRole('button', { name: 'Generate Ed25519' }).click();
  await expect(page.getByTestId('key-fingerprint')).toHaveText(/^SHA256:[A-Za-z0-9+/]{43}$/);
  await expect(page.getByTestId('key-row')).toContainText('ssh-ed25519');
  expect(await page.content()).not.toMatch(/PRIVATE KEY/);
  await page.getByRole('tab', { name: 'Connect' }).click();
});

test('connects, verifies the host key, asks for the password, warns on a risky paste, resizes', async () => {
  test.skip(!HOST, 'QUQA_TEST_SSH_HOST is not set');
  await page.getByLabel('Host').fill(`${HOST}`);
  await page.getByLabel('Port').fill(PORT);
  await page.getByLabel('User').fill(USER);
  await page.getByRole('button', { name: 'Connect' }).click();

  const dialog = page.getByRole('dialog', { name: 'Unknown host key' });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('host-key-fingerprint')).toContainText(/SHA256:[A-Za-z0-9+/]{43}/);
  await dialog.getByRole('button', { name: 'Accept and connect' }).click();

  const login = page.getByRole('dialog', { name: /^Password for / });
  await expect(login).toBeVisible();
  await login.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await login.getByLabel('Save the password in the vault').check();
  await login.getByRole('button', { name: 'Log in' }).click();

  await expect(page.getByTestId('terminal-status')).toHaveText('Connected');
  const renderer = await page.evaluate(() => window.__quqaTest?.renderer());
  expect(['webgl', 'dom']).toContain(renderer);

  await page.keyboard.type("echo ui''-ok\n");
  await expect.poll(terminalText).toMatch(/^ui-ok$/m);

  // A paste with an escape sequence (it could end bracketed paste) asks first.
  await app.evaluate(({ clipboard }) => clipboard.writeText('echo pasted\u001b[201~; id\n'));
  await page.keyboard.press('Control+Shift+V');
  const paste = page.getByRole('dialog', { name: 'Paste this?' });
  await expect(paste).toBeVisible();
  await expect(page.getByTestId('paste-preview')).toContainText('⟨ESC⟩[201~');
  await paste.getByRole('button', { name: 'Cancel' }).click();
  await expect(paste).toBeHidden();
  expect(await terminalText()).not.toMatch(/pasted/);
  await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeFocused();

  await page.keyboard.type('stty size\n');
  await expect.poll(terminalText).toMatch(/^\d+ \d+$/m);
  const before = (await terminalText()).match(/^(\d+) (\d+)$/m);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(700, 420));
  await page.waitForTimeout(600);
  await page.keyboard.type('clear; stty size\n');
  await expect
    .poll(async () => (await terminalText()).match(/^(\d+) (\d+)$/m)?.[0])
    .not.toBe(before?.[0]);

  await page.getByRole('button', { name: /Disconnect/ }).click();
  await expect(page.getByRole('form', { name: 'Quick connect' })).toBeVisible();

  await page.getByRole('tab', { name: 'Host keys' }).click();
  await expect(page.getByRole('list', { name: 'Trusted hosts' })).toContainText(`${HOST}`);
  await page.getByRole('tab', { name: 'Connect' }).click();
});

test('keeps secrets sealed in the vault file', async () => {
  const text = readFileSync(join(profile, 'vault.json'), 'utf8');
  expect(text).toContain('"format": "quqa-vault"');
  expect(text).not.toContain(VAULT_PASSWORD);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toMatch(/PRIVATE KEY|ui-smoke/);
});

test('locks and unlocks the vault', async () => {
  await page.getByRole('button', { name: /Lock/ }).click();
  const form = page.getByRole('form', { name: 'Unlock vault' });
  await expect(form).toBeVisible();
  await form.getByLabel('Master password').fill('wrong password');
  await form.getByRole('button', { name: 'Unlock' }).click();
  await expect(form.getByRole('alert')).toHaveText('Wrong master password');
  await form.getByLabel('Master password').fill(VAULT_PASSWORD);
  await form.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('form', { name: 'Quick connect' })).toBeVisible();
});

test('reconnects with the pinned host key and the saved password', async () => {
  test.skip(!HOST, 'QUQA_TEST_SSH_HOST is not set');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('terminal-status')).toHaveText('Connected');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /Disconnect/ }).click();
  await expect(page.getByRole('form', { name: 'Quick connect' })).toBeVisible();
});
