/**
 * The look of the app, screen by screen, in both app themes: screenshots go
 * to `ui-screenshots/` (CI uploads them) for a designer's eye. Also checks
 * that Georgian text uses the bundled fonts, in the UI and in the terminal
 * with the WebGL and the DOM renderer, and shows the update badge and panel
 * with a fake releases list (the app never reaches GitHub in tests).
 *
 *   docker compose -f docker/compose.yml run --rm dev xvfb-run -a pnpm test:ui
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const PORT = Number(process.env['QUQA_TEST_SSH_PORT'] ?? '22');
const USER = process.env['QUQA_TEST_SSH_USER'] ?? 'quqa';
const PASSWORD = process.env['QUQA_TEST_SSH_PASSWORD'] ?? 'quqa-test-password';
const VAULT_PASSWORD = 'look test master password';
const SHOTS = 'ui-screenshots';
/** Mkhedruli, Mtavruli capitals and Asomtavruli. */
const GEORGIAN = 'გამარჯობა, მსოფლიო! ქართული ტექსტი — ᲥᲐᲠᲗᲣᲚᲘ ႠႡႢ';
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

let app: ElectronApplication;
let page: Page;
let profile: string;

test.describe.configure({ mode: 'serial' });

const shot = (name: string) =>
  page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
const section = (name: string) =>
  page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name, exact: true });

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'quqa-look-'));
  mkdirSync(SHOTS, { recursive: true });
  const releases = join(profile, 'releases.json');
  const tag = 'v9.9.9';
  writeFileSync(
    releases,
    JSON.stringify([
      {
        tag_name: tag,
        html_url: `https://github.com/igtux/Quqa-Express/releases/tag/${tag}`,
        draft: false,
        prerelease: false,
        published_at: '2026-10-21T09:00:00Z',
        body: [
          "## What's new",
          '',
          '- **Georgian** text looks right: ქართული ტექსტი in the terminal and the UI',
          '- A new *Liquid glass* theme; `Classic` stays one click away',
          '- Update check with [release notes](https://github.com/igtux/Quqa-Express/releases)',
          '- <script>alert(1)</script> stays text',
          '',
          '## Download',
          '',
          '- the setup exe',
        ].join('\n'),
        assets: [],
      },
    ]),
  );
  app = await electron.launch({
    // SwiftShader WebGL under Xvfb, so the WebGL renderer is checked too.
    args: ['out/main/index.js', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
    env: {
      ...process.env,
      QUQA_TEST_HOOKS: '1',
      QUQA_USER_DATA: profile,
      QUQA_TEST_NO_OS_KEYSTORE: '1',
      QUQA_TEST_RELEASES: releases,
    },
  });
  app.process().stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 800 }),
  );
});

test.afterAll(async () => {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
});

test('vault set-up and the empty hosts screen', async () => {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'glass');
  const form = page.getByRole('form', { name: 'Create vault' });
  await expect(form).toBeVisible();
  await shot('01-glass-create-vault');
  await form.getByLabel('Master password', { exact: true }).fill(VAULT_PASSWORD);
  await form.getByLabel('Repeat the password').fill(VAULT_PASSWORD);
  await form.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByText('No hosts yet.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await shot('02-glass-hosts-empty');
});

test('Georgian in the UI uses the bundled Noto Sans Georgian', async () => {
  const hosts: [string, string, string, string][] = [
    ['ვებ სერვერი', 'web', 'prod', 'ძირითადი საიტი, nginx + php-fpm'],
    ['database-01', 'db', 'prod', 'PostgreSQL 17 primary'],
    ['სატესტო', 'web', 'staging', ''],
    ['backup box', '', 'ops', 'Nightly borg backups'],
  ];
  for (const [name, group, tag, notes] of hosts) {
    await page.evaluate(
      async ({ name, group, tag, notes, address, port, user }) => {
        await window.quqa.call('hosts.save', {
          host: {
            name,
            address,
            port,
            username: user,
            auth: { kind: 'password' },
            os: 'linux',
            group,
            tags: [tag],
            notes,
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
      },
      { name, group, tag, notes, address: HOST ?? '127.0.0.1', port: PORT, user: USER },
    );
  }
  await section('Keys').click();
  await section('Hosts').click();
  await expect(page.getByTestId('host-card')).toHaveCount(4);
  await page.waitForTimeout(800);

  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      sans: document.fonts.check('16px "Quqa Georgian Sans"', 'ქ'),
      mono: document.fonts.check('16px "BPG Courier"', 'ქ'),
      loaded: [...document.fonts]
        .filter((f) => f.status === 'loaded')
        .map((f) => f.family.replaceAll('"', '')),
    };
  });
  expect(fonts.sans).toBe(true);
  expect(fonts.mono).toBe(true);
  expect(fonts.loaded).toContain('Quqa Georgian Sans');
  await shot('03-glass-hosts-georgian');
});

test('the update badge and its panel render the notes as safe Markdown', async () => {
  const badge = page.getByRole('button', { name: 'Update available' });
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await shot('04-glass-update-badge');
  await badge.click();
  const panel = page.getByRole('dialog', { name: 'Update available' });
  await expect(panel).toContainText('quqa-express 9.9.9');
  await expect(panel).toContainText(`you have ${version}`);
  await expect(panel).toContainText('<script>alert(1)</script> stays text');
  await expect(panel.locator('script')).toHaveCount(0);
  await expect(panel).not.toContainText('the setup exe');
  await expect(panel.getByRole('button', { name: 'Open download page' })).toBeVisible();
  await shot('05-glass-update-panel');
  await panel.getByRole('button', { name: 'release notes' }).click();
  const confirm = page.getByRole('dialog', { name: 'Open this link?' });
  await expect(confirm).toContainText('https://github.com/igtux/Quqa-Express/releases');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await panel.getByRole('button', { name: 'Later' }).click();
  await expect(panel).toBeHidden();
  await expect(badge).toBeVisible();
});

test('a terminal shows Georgian in one cell per letter, with WebGL and the DOM renderer', async () => {
  test.skip(!HOST, 'QUQA_TEST_SSH_HOST is not set');
  await page.getByRole('button', { name: 'Open a terminal on ვებ სერვერი' }).click();
  await page
    .getByRole('dialog', { name: 'Unknown host key' })
    .getByRole('button', { name: 'Accept and connect' })
    .click();
  const login = page.getByRole('dialog', { name: /^Password for / });
  await login.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await login.getByLabel('Save the password in the vault').check();
  await login.getByRole('button', { name: 'Log in' }).click();
  const text = () => page.evaluate(() => window.__quqaTest?.text() ?? '');
  await expect.poll(() => page.evaluate(() => window.__quqaTest?.state())).toBe('connected');
  await page.keyboard.type(
    `clear; printf '\\033[1;32m%s\\033[0m\\n' '${GEORGIAN}'; echo 'ASCII ruler: 0123456789012345678901234567890123456789'; printf 'ქართ|%.0s' 1 2 3 4 5 6; echo; ls --color=always -la /etc | head -12\n`,
  );
  await expect.poll(text).toContain('ქართული ტექსტი');
  await page.keyboard.press('Control+Shift+S');
  await page.waitForTimeout(600);
  // Xvfb may have no WebGL2; then xterm already uses the DOM renderer.
  const renderer = await page.evaluate(() => window.__quqaTest?.renderer());
  await shot(`06-glass-terminal-${renderer}-georgian`);
  await page.locator('.terminal-window:not([hidden]) .xterm-screen').screenshot({
    path: join(SHOTS, `07-terminal-${renderer}-georgian-closeup.png`),
  });

  await page.evaluate(() => window.__quqaTest?.useDomRenderer());
  await expect.poll(() => page.evaluate(() => window.__quqaTest?.renderer())).toBe('dom');
  await page.waitForTimeout(400);
  // Each Georgian letter takes one cell: the row's spans line up with the ruler.
  const widths = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.terminal-window:not([hidden]) .xterm-rows > div')];
    const row = rows.find((r) => r.textContent?.startsWith('ქართ|ქართ'));
    const ruler = rows.find((r) => r.textContent?.startsWith('ASCII ruler'));
    /** Width of the first `n` characters of a row, across its spans. */
    const measure = (r: Element | undefined, n: number) => {
      if (!r) return -1;
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let seen = 0;
      let first: Node | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        first ??= node;
        const length = node.textContent?.length ?? 0;
        if (seen + length >= n) {
          range.setStart(first, 0);
          range.setEnd(node, n - seen);
          return range.getBoundingClientRect().width;
        }
        seen += length;
      }
      return -1;
    };
    return { georgian: measure(row, 30), ascii: measure(ruler, 30) };
  });
  expect(widths.georgian).toBeGreaterThan(0);
  expect(Math.abs(widths.georgian - widths.ascii)).toBeLessThan(2);
  await page.locator('.terminal-window:not([hidden]) .xterm-screen').screenshot({
    path: join(SHOTS, '08-terminal-dom-georgian-closeup.png'),
  });
  await page.keyboard.press('Control+Shift+S');
});

test('dialogs, file browser and menus in the glass theme', async () => {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'Look and notifications' }).click();
  const look = page.getByRole('dialog', { name: 'Look and notifications' });
  await expect(look).toBeVisible();
  await shot('09-glass-look-dialog');
  await look.getByRole('button', { name: 'Cancel' }).click();

  await page.keyboard.press('F1');
  await page
    .getByRole('dialog', { name: 'Keyboard shortcuts' })
    .getByRole('button', { name: 'About quqa-express' })
    .click();
  const about = page.getByRole('dialog', { name: 'About quqa-express' });
  await expect(about.getByLabel('Check for updates automatically')).toBeChecked();
  await shot('10-glass-about');
  await about.getByRole('button', { name: 'Close' }).click();

  if (HOST) {
    await page.keyboard.press('Control+Shift+H');
    await page.getByRole('button', { name: 'Files on ვებ სერვერი' }).click();
    const files = page.getByRole('dialog', { name: 'Files — ვებ სერვერი' });
    await expect(files).toBeVisible();
    await expect(files.getByTestId('files-path')).toHaveText(`/home/${USER}`, { timeout: 15_000 });
    await page.waitForTimeout(500);
    await shot('11-glass-files');
    await files.getByRole('button', { name: 'Close files' }).click();
    await expect(files).toBeHidden();
  }
  await page.keyboard.press('Control+Shift+K');
  await page.waitForTimeout(300);
  await shot('12-glass-switcher');
  await page.keyboard.press('Escape');
});

test('Classic is one click away and still looks like before', async () => {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'Look and notifications' }).click();
  const look = page.getByRole('dialog', { name: 'Look and notifications' });
  await look.getByRole('radio', { name: /Classic/ }).click();
  await look.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic');
  await page.keyboard.press('Control+Shift+H');
  await shot('13-classic-hosts');
  if (HOST) {
    await page.getByTestId('app-tab').first().click();
    await page.waitForTimeout(300);
    await shot('14-classic-terminal');
  }
  expect(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))).toMatchObject({
    theme: 'classic',
  });
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'Look and notifications' }).click();
  await look.getByRole('radio', { name: /Liquid glass/ }).click();
  await look.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'glass');
});

test('locked: "Forgot password? Start over" moves the vault aside', async () => {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.getByRole('menuitem', { name: 'Lock' }).click();
  const unlock = page.getByRole('form', { name: 'Unlock vault' });
  await expect(unlock).toBeVisible();
  await shot('15-glass-unlock');
  await page.getByRole('button', { name: 'Forgot password? Start over' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start over with a new vault?' });
  await expect(dialog).toContainText('is not touched');
  const start = dialog.getByRole('button', { name: 'Start over' });
  await expect(start).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill('delete');
  await expect(start).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill('DELETE');
  await shot('16-glass-start-over');
  await start.click();
  const create = page.getByRole('form', { name: 'Create vault' });
  await expect(create).toBeVisible();
  await expect(create).toContainText('vault-backups');
  await expect(page.getByTestId('app-tab')).toHaveCount(0);
  await shot('17-glass-after-start-over');
});
