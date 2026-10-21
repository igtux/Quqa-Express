/**
 * Start-up smoke test, also run on Windows CI against the packaged app
 * (QUQA_APP_EXECUTABLE, built with the inspect fuse on so Playwright can
 * attach): the window opens, the vault is created (with the OS key store
 * when there is one, which is DPAPI on Windows), the first-run welcome and
 * the hosts screen render, About shows the version, and after a restart the
 * vault opens again and the window comes back where it was.
 *
 *   docker compose -f docker/compose.yml run --rm dev xvfb-run -a pnpm test:smoke
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const VAULT_PASSWORD = 'smoke test master password';
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

let app: ElectronApplication | undefined;
let page: Page;
let profile: string;

test.describe.configure({ mode: 'serial' });

function running(): ElectronApplication {
  if (!app) throw new Error('The app is not running');
  return app;
}

async function launch() {
  const executable = process.env['QUQA_APP_EXECUTABLE'];
  app = await electron.launch({
    ...(executable && { executablePath: executable }),
    args: executable ? [] : ['out/main/index.js'],
    env: { ...process.env, QUQA_TEST_HOOKS: '1', QUQA_USER_DATA: profile },
    timeout: 60_000,
  });
  app.process().stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
}

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'quqa-smoke-'));
  await launch();
});

test.afterAll(async () => {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
});

test('the main window opens', async () => {
  await expect(page).toHaveTitle('quqa-express');
  const shown = await running().evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { visible: window?.isVisible() ?? false, title: window?.getTitle() ?? '' };
  });
  expect(shown).toEqual({ visible: true, title: 'quqa-express' });
});

test('creates the vault and shows the first-run welcome and the hosts screen', async () => {
  const form = page.getByRole('form', { name: 'Create vault' });
  await expect(form).toBeVisible();
  // Without an OS key store (e.g. Linux without a keyring) a password is required.
  const password = form.getByLabel('Master password');
  if (await password.isVisible()) {
    await password.fill(VAULT_PASSWORD);
    await form.getByLabel('Repeat the password').fill(VAULT_PASSWORD);
  }
  await form.getByRole('button', { name: 'Create vault' }).click();

  const welcome = page.getByRole('dialog', { name: 'Welcome to quqa-express' });
  await expect(welcome).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Import hosts…' })).toBeEnabled();
  await welcome.getByRole('button', { name: 'Done' }).click();
  await expect(welcome).toBeHidden();

  await expect(page.getByRole('region', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByText('No hosts yet.')).toBeVisible();
  expect(existsSync(join(profile, 'vault.json'))).toBe(true);
});

test('About shows the version, licence and source', async () => {
  await page.keyboard.press('F1');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts).toBeVisible();
  await shortcuts.getByRole('button', { name: 'About quqa-express' }).click();
  const about = page.getByRole('dialog', { name: 'About quqa-express' });
  await expect(about.getByTestId('app-version')).toHaveText(`Version ${version}`);
  await expect(about).toContainText('Apache License 2.0');
  await expect(about).toContainText('github.com/igtux/Quqa-Express');
  await about.getByRole('button', { name: 'Close' }).click();
  await expect(about).toBeHidden();
});

test('after a restart the vault opens again and the window keeps its size', async () => {
  await running().evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 900, height: 600 });
  });
  await running().close();
  app = undefined;
  expect(existsSync(join(profile, 'window-state.json'))).toBe(true);

  await launch();
  const unlock = page.getByRole('form', { name: 'Unlock vault' });
  const hosts = page.getByRole('region', { name: 'Hosts' });
  // An OS-protected vault unlocks by itself; a password vault asks.
  await expect(unlock.or(hosts)).toBeVisible();
  if (await unlock.isVisible()) {
    const password = unlock.getByLabel('Master password');
    if (await password.isVisible()) await password.fill(VAULT_PASSWORD);
    await unlock.getByRole('button', { name: 'Unlock' }).click();
  }
  await expect(hosts).toBeVisible();
  await expect(page.getByText('No hosts yet.')).toBeVisible();
  const size = await running().evaluate(({ BrowserWindow }) => {
    const bounds = BrowserWindow.getAllWindows()[0]?.getNormalBounds();
    return { width: bounds?.width, height: bounds?.height };
  });
  expect(size).toEqual({ width: 900, height: 600 });
});
