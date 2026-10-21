/**
 * Smoke test of the built app: the window is hardened, the
 * quick-connect form opens a session, the host-key prompt gates it, and the
 * terminal shows remote output and follows window resizes.
 *
 *   docker compose -f docker/compose.yml run --rm dev xvfb-run -a pnpm test:ui
 *
 * Note: on Linux Playwright starts Electron with --no-sandbox (Chromium's OS
 * sandbox); the renderer's web preferences are still checked below.
 */
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

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  // QUQA_APP_EXECUTABLE: test a packaged build instead of out/ (it must be
  // built with the enableNodeCliInspectArguments fuse left on).
  const executable = process.env['QUQA_APP_EXECUTABLE'];
  app = await electron.launch({
    ...(executable && { executablePath: executable }),
    args: [...(executable ? [] : ['out/main/index.js'])],
    env: { ...process.env, QUQA_TEST_HOOKS: '1' },
  });
  // Main and engine diagnostics end up in the test log.
  app.process().stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

const terminalText = () => page.evaluate(() => window.__quqaTest?.text() ?? '');

test('the page has no Node access, a strict CSP and only the bridge API', async () => {
  const facts = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    api: Object.keys(window.quqa).sort(),
    csp:
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content') ?? '',
    popup: window.open('https://example.com/') === null,
  }));
  expect(facts.require).toBe('undefined');
  expect(facts.process).toBe('undefined');
  expect(facts.api).toEqual(
    [
      'ack',
      'answerHostKey',
      'attention',
      'clipboardRead',
      'clipboardWrite',
      'connect',
      'disconnect',
      'input',
      'onEvent',
      'reconnect',
      'resize',
      'testHooks',
    ].sort(),
  );
  expect(facts.csp).toContain("default-src 'none'");
  expect(facts.csp).toContain("script-src 'self'");
  expect(facts.csp).not.toContain('unsafe-eval');
  expect(facts.popup).toBe(true);

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

test('the main process rejects malformed IPC', async () => {
  const error = await page.evaluate(() =>
    window.quqa
      .connect({
        host: 'bad host',
        port: 22,
        username: 'x',
        auth: { kind: 'password', password: 'x' },
        cols: 80,
        rows: 24,
      })
      .then(
        () => 'accepted',
        (e: unknown) => String(e),
      ),
  );
  expect(error).toMatch(/Invalid connection details/);
});

test('connects, verifies the host key, runs a command and resizes', async () => {
  test.skip(!HOST, 'QUQA_TEST_SSH_HOST is not set');
  await page.getByLabel('Host').fill(`${HOST}`);
  await page.getByLabel('Port').fill(PORT);
  await page.getByLabel('User').fill(USER);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Connect' }).click();

  const dialog = page.getByRole('dialog', { name: 'Unknown host key' });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('host-key-fingerprint')).toContainText(/SHA256:[A-Za-z0-9+/]{43}/);
  await dialog.getByRole('button', { name: 'Accept and connect' }).click();

  await expect(page.getByTestId('terminal-status')).toHaveText('Connected');
  const renderer = await page.evaluate(() => window.__quqaTest?.renderer());
  expect(['webgl', 'dom']).toContain(renderer);

  await page.keyboard.type("echo ui''-ok\n");
  await expect.poll(terminalText).toMatch(/^ui-ok$/m);

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
});
