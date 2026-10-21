/**
 * Start-up smoke test, also run on Windows CI against the packaged app
 * (QUQA_APP_EXECUTABLE, built with the inspect fuse on so Playwright can
 * attach): the window opens, the vault is created (with the OS key store
 * when there is one, which is DPAPI on Windows) and the app goes straight to
 * the hosts screen, a host with a Georgian name renders in the bundled
 * Georgian font (screenshot in ui-screenshots/), a local terminal runs the
 * default shell (PowerShell on Windows) with Georgian output, About shows the version and
 * the update setting, after a restart the vault opens again and the window
 * comes back where it was, and "Start over" moves the vault aside.
 *
 *   docker compose -f docker/compose.yml run --rm dev xvfb-run -a pnpm test:smoke
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
const GEORGIAN_HOST = 'ქართული სერვერი';
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

test('creates the vault and goes straight to the hosts screen', async () => {
  const form = page.getByRole('form', { name: 'Create vault' });
  await expect(form).toBeVisible();
  // Without an OS key store (e.g. Linux without a keyring) a password is required.
  const password = form.getByLabel('Master password', { exact: true });
  if (await password.isVisible()) {
    await password.fill(VAULT_PASSWORD);
    await form.getByLabel('Repeat the password').fill(VAULT_PASSWORD);
  }
  await form.getByRole('button', { name: 'Create vault' }).click();

  await expect(page.getByRole('region', { name: 'Hosts' })).toBeVisible();
  await expect(page.getByText('No hosts yet.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(existsSync(join(profile, 'vault.json'))).toBe(true);

  // Importing from ~/.ssh is offered, not forced.
  await page.getByRole('button', { name: 'Import from ~/.ssh' }).first().click();
  const imports = page.getByRole('dialog', { name: 'Import from ~/.ssh' });
  await expect(imports.getByRole('button', { name: 'Import hosts…' })).toBeEnabled();
  await imports.getByRole('button', { name: 'Done' }).click();
  await expect(imports).toBeHidden();
});

test('Georgian text renders in the bundled Georgian fonts', async () => {
  await page.getByRole('button', { name: 'Add host' }).first().click();
  const form = page.getByRole('dialog', { name: 'Add host' });
  await form.getByLabel('Name').fill(GEORGIAN_HOST);
  await form.getByLabel('Address').fill('192.0.2.10');
  await form.getByLabel('User').fill('root');
  await form.getByLabel('Notes').fill('გამარჯობა, მსოფლიო! ქართული ტექსტი');
  await form.getByRole('button', { name: 'Add host' }).click();
  await expect(form).toBeHidden();
  const card = page.getByRole('listitem', { name: GEORGIAN_HOST });
  await expect(card).toContainText(GEORGIAN_HOST);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      sans: document.fonts.check('16px "Quqa Georgian Sans"', 'ქ'),
      mono: document.fonts.check('16px "BPG Courier"', 'ქ'),
    };
  });
  expect(fonts).toEqual({ sans: true, mono: true });
  mkdirSync('ui-screenshots', { recursive: true });
  await page.screenshot({ path: join('ui-screenshots', 'smoke-georgian-hosts.png') });

  // The terminal font samples and preview carry Georgian too.
  await page.getByRole('button', { name: 'Look and notifications' }).click();
  const look = page.getByRole('dialog', { name: 'Look and notifications' });
  await expect(look).toContainText('გამარჯობა, მსოფლიო');
  await page.screenshot({ path: join('ui-screenshots', 'smoke-georgian-look.png') });
  await look.getByRole('button', { name: 'Cancel' }).click();

  await card.getByRole('button', { name: `Delete ${GEORGIAN_HOST}` }).click();
  await page
    .getByRole('dialog', { name: `Delete ${GEORGIAN_HOST}?` })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(page.getByText('No hosts yet.')).toBeVisible();
});

test('a local terminal runs the default shell, in UTF-8, and starts again after exit', async () => {
  const windows = process.platform === 'win32';
  const hooks = () =>
    page.evaluate(() => ({
      state: window.__quqaTest?.state() ?? 'none',
      local: window.__quqaTest?.local() ?? false,
      text: window.__quqaTest?.text() ?? '',
    }));
  // The shell menu lists what main detected; the default is marked.
  await page.getByRole('button', { name: 'Local shells' }).click();
  const menu = page.getByRole('menu', { name: 'Local shells' });
  await expect(menu).toContainText(windows ? 'PowerShell' : 'sh');
  await expect(menu).toContainText('default');
  mkdirSync('ui-screenshots', { recursive: true });
  await page.screenshot({ path: join('ui-screenshots', 'smoke-local-menu.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await page.getByRole('button', { name: 'New local terminal' }).click();
  await expect(page.getByTestId('terminal-tab')).toBeVisible();
  await expect.poll(async () => (await hooks()).state, { timeout: 30_000 }).toBe('connected');
  expect((await hooks()).local).toBe(true);
  await expect(page.getByTestId('terminal-tab').getByText('local', { exact: true })).toBeVisible();
  if (windows) {
    await expect.poll(async () => (await hooks()).text, { timeout: 30_000 }).toMatch(/PS .*>/);
  }
  // The joined word appears only in the output, not in the typed command.
  await page.keyboard.type(
    windows ? "Write-Output ('გამ' + 'არჯობა')" : "printf '%s%s\\n' 'გამ' 'არჯობა'",
  );
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await hooks()).text, { timeout: 15_000 }).toContain('გამარჯობა');
  mkdirSync('ui-screenshots', { recursive: true });
  await page.screenshot({ path: join('ui-screenshots', 'smoke-local-terminal.png') });

  await page.keyboard.type('exit 3');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await hooks()).state, { timeout: 15_000 }).toBe('ended');
  await expect(page.getByTestId('terminal-pane')).toContainText('exited with code 3');
  await page.getByTestId('terminal-pane').getByRole('button', { name: 'Start again' }).click();
  await expect.poll(async () => (await hooks()).state, { timeout: 30_000 }).toBe('connected');

  await page
    .getByTestId('terminal-tab')
    .getByRole('button', { name: 'Close (ends the shell and its programs)' })
    .click();
  await expect(page.getByTestId('terminal-tab')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Hosts' })).toBeVisible();
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
  // On by default; tests never reach GitHub (main skips the check under test hooks).
  await expect(about.getByLabel('Check for updates automatically')).toBeChecked();
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
    const password = unlock.getByLabel('Master password', { exact: true });
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

test('"Start over" moves the vault aside and offers a new one', async () => {
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  const unlock = page.getByRole('form', { name: 'Unlock vault' });
  await expect(unlock).toBeVisible();
  await unlock.getByRole('button', { name: /Start over$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Start over with a new vault?' });
  await dialog.getByLabel(/to confirm/).fill('DELETE');
  await dialog.getByRole('button', { name: 'Start over' }).click();
  await expect(page.getByRole('form', { name: 'Create vault' })).toContainText('vault-backups');
  expect(existsSync(join(profile, 'vault.json'))).toBe(false);
  const [folder] = readdirSync(join(profile, 'vault-backups'));
  expect(readdirSync(join(profile, 'vault-backups', folder as string))).toContain('vault.json');
});
