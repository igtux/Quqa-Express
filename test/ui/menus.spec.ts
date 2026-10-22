/**
 * The menus (components/Menu.tsx): the main menu, the local shells menu, a
 * tab's right-click menu, a host card's More menu and a dock card's menu.
 * Each opens inside the window, answers the arrow keys and Escape, does what
 * it says, and is screenshotted in both app themes into
 * `ui-screenshots/menus/`.
 *
 *   docker compose -f docker/compose.yml run --rm dev sh -c 'xvfb-run -a pnpm test:ui test/ui/menus.spec.ts'
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

const VAULT_PASSWORD = 'menus test master password';
const SHOTS = join('ui-screenshots', 'menus');
const GEORGIAN_HOST = 'ვებ სერვერი';

let app: ElectronApplication;
let page: Page;
let profile: string;

test.describe.configure({ mode: 'serial' });

const shot = (name: string) =>
  page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });

/** The menu is fully inside the window and the page did not scroll. */
async function expectInside(menu: Locator) {
  const box = await menu.boundingBox();
  expect(box).not.toBeNull();
  const view =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  if (!box) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  const scrolled = await page.evaluate(() => {
    const all = [document.scrollingElement, ...document.querySelectorAll('.app-shell, .app-main')];
    return all.some((e) => e && (e.scrollLeft !== 0 || e.scrollTop !== 0));
  });
  expect(scrolled).toBe(false);
}

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'quqa-menus-'));
  mkdirSync(SHOTS, { recursive: true });
  app = await electron.launch({
    args: ['out/main/index.js', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
    env: {
      ...process.env,
      QUQA_TEST_HOOKS: '1',
      QUQA_USER_DATA: profile,
      QUQA_TEST_NO_OS_KEYSTORE: '1',
    },
  });
  app.process().stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 800 }),
  );
  const form = page.getByRole('form', { name: 'Create vault' });
  await form.getByLabel('Master password', { exact: true }).fill(VAULT_PASSWORD);
  await form.getByLabel('Repeat the password').fill(VAULT_PASSWORD);
  await form.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByRole('region', { name: 'Hosts' })).toBeVisible();
  for (const name of [GEORGIAN_HOST, 'database-01']) {
    await page.evaluate(async (name) => {
      await window.quqa.call('hosts.save', {
        host: {
          name,
          address: '192.0.2.10',
          port: 22,
          username: 'root',
          auth: { kind: 'password' },
          os: 'linux',
          group: 'prod',
          tags: [],
          notes: '',
          color: '',
          tmux: false,
          jumpHostId: null,
          proxyJump: '',
          scheme: '',
          font: '',
          agentForward: false,
          fileRoots: [],
          uploadDir: '',
          osc52: 'ask',
          forwards: [],
        },
      });
    }, name);
  }
  const sections = page.getByRole('tablist', { name: 'Sections' });
  await sections.getByRole('tab', { name: 'Keys', exact: true }).click();
  await sections.getByRole('tab', { name: 'Hosts', exact: true }).click();
  await expect(page.getByTestId('host-card')).toHaveCount(2);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
});

test('the main menu: grouped, keyboard friendly, and it opens what it says', async () => {
  const button = page.getByRole('button', { name: 'Main menu' });
  await button.click();
  const menu = page.getByRole('menu', { name: 'Main menu' });
  await expect(menu).toBeVisible();
  await expectInside(menu);
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveText([
    /Look and notifications/,
    /Keyboard shortcuts/,
    /Check for updates/,
    /About quqa-express/,
    /Lock/,
  ]);
  await expect(menu).toContainText('F1');
  // The first item has focus; the arrows move it and wrap around.
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await shot('01-glass-main-menu');
  // Escape closes it and gives focus back to the button.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();

  await button.click();
  await menu.getByRole('menuitem', { name: 'About quqa-express' }).click();
  const about = page.getByRole('dialog', { name: 'About quqa-express' });
  await expect(about).toBeVisible();
  await about.getByRole('button', { name: 'Close' }).click();

  // A click on the button again closes it.
  await button.click();
  await expect(menu).toBeVisible();
  await button.click();
  await expect(menu).toBeHidden();
});

test('a host card keeps its main buttons and moves the rest into More', async () => {
  const card = page.getByRole('listitem', { name: GEORGIAN_HOST });
  await expect(card.getByRole('button')).toHaveCount(4);
  await card.getByRole('button', { name: `More for ${GEORGIAN_HOST}` }).click();
  const menu = page.getByRole('menu', { name: `${GEORGIAN_HOST} actions` });
  await expect(menu.getByRole('menuitem')).toHaveText([
    /Ping/,
    /Install a key/,
    /Edit/,
    /Duplicate/,
    /Delete/,
  ]);
  await expectInside(menu);
  await shot('02-glass-host-more');
  await menu.getByRole('menuitem', { name: 'Duplicate…' }).click();
  const copy = page.getByRole('dialog', { name: `Duplicate ${GEORGIAN_HOST}` });
  await expect(copy).toBeVisible();
  await copy.getByRole('button', { name: 'Cancel' }).click();
});

test('the local shells menu', async () => {
  await page.getByRole('button', { name: 'Local shells' }).click();
  const menu = page.getByRole('menu', { name: 'Local shells' });
  await expect(menu).toContainText('default');
  await expect(menu.getByRole('menuitem', { name: 'In a folder…' })).toBeVisible();
  await expectInside(menu);
  await shot('03-glass-local-shells');
  await menu.getByRole('menuitem').first().click();
  await expect(menu).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.__quqaTest?.state()), { timeout: 30_000 })
    .toBe('connected');
});

test("a tab's right-click menu renames, splits and closes", async () => {
  const tab = page.getByTestId('app-tab').first();
  await tab.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: /tab$/ });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Ctrl+Shift+D');
  await expectInside(menu);
  await shot('04-glass-tab-menu');

  await menu.getByRole('menuitem', { name: 'Rename…' }).click();
  const rename = page.getByLabel('Session name');
  await rename.fill('agents');
  await rename.press('Enter');
  await expect(tab).toContainText('agents');

  await tab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Split side by side' }).click();
  await expect.poll(() => page.evaluate(() => window.__quqaTest?.panes())).toBe(2);

  // Keyboard: the context-menu key on a focused tab opens it too.
  await tab.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: /tab$/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: /tab$/ })).toBeHidden();
});

test('the dock card menu stays inside the window', async () => {
  await page.keyboard.press('Control+Shift+S');
  const row = page.getByTestId('dock-row').first();
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: /actions$/ });
  await expect(menu.getByRole('menuitem', { name: 'Rename…' })).toBeVisible();
  await expectInside(menu);
  await shot('05-glass-dock-menu');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.keyboard.press('Control+Shift+S');
});

test('Classic theme menus', async () => {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'Look and notifications' }).click();
  const look = page.getByRole('dialog', { name: 'Look and notifications' });
  await look.getByRole('radio', { name: /Classic/ }).click();
  await look.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic');
  await page.getByRole('button', { name: 'Main menu' }).click();
  await shot('06-classic-main-menu');
  await page.keyboard.press('Escape');
  await page.getByTestId('app-tab').first().click({ button: 'right' });
  await shot('07-classic-tab-menu');
  await page.keyboard.press('Escape');

  // Close the tab from its menu; the local shell ends with it.
  await page.getByTestId('app-tab').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close tab' }).click();
  await expect(page.getByTestId('app-tab')).toHaveCount(0);
});
