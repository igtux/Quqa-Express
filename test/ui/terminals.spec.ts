/**
 * Several terminals drawing with WebGL at once (regression test for
 * 0.1.0-beta.9: opening a second local tab left the first one showing
 * scattered letters). xterm's WebGL addon shares one glyph atlas between
 * terminals with the same font and colours; clearing it for one terminal
 * must redraw all of them.
 *
 * The app runs with SwiftShader WebGL under Xvfb, like look.spec.ts. A
 * terminal's pixels are compared before and after: the share of its "ink"
 * (pixels that differ from the background) that changed must stay small.
 *
 *   docker compose -f docker/compose.yml run --rm dev sh -c 'xvfb-run -a pnpm test:ui test/ui/terminals.spec.ts'
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

const VAULT_PASSWORD = 'terminals test master password';
const windows = process.platform === 'win32';

let app: ElectronApplication | undefined;
let page: Page;
let profile: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'quqa-terminals-'));
  // Also run by Windows CI against the packaged app (QUQA_APP_EXECUTABLE), with PowerShell.
  const executable = process.env['QUQA_APP_EXECUTABLE'];
  const gpu = ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
  app = await electron.launch({
    ...(executable && { executablePath: executable }),
    args: executable ? gpu : ['out/main/index.js', ...gpu],
    timeout: 60_000,
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
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1100, height: 720 }),
  );
});

test.afterAll(async () => {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
});

const hooks = () =>
  page.evaluate(() => ({
    state: window.__quqaTest?.state() ?? 'none',
    renderer: window.__quqaTest?.renderer() ?? 'none',
    text: window.__quqaTest?.text() ?? '',
    tabs: window.__quqaTest?.tabs() ?? 0,
  }));

/** The visible terminal's drawing area. */
function screen(): Locator {
  return page.locator('[data-testid="terminal-tab"]:not([hidden]) .xterm-screen').first();
}

/** Ink pixels of `before`, and how many of them (or of `after`'s) differ. */
async function compare(before: Buffer, after: Buffer): Promise<{ ink: number; changed: number }> {
  return page.evaluate(
    async ({ a, b }) => {
      const pixels = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('no 2d context');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const one = await pixels(a);
      const two = await pixels(b);
      const width = Math.min(one.width, two.width);
      const height = Math.min(one.height, two.height);
      // The background is the top-right pixel (no text there in this test).
      const at = (image: ImageData, x: number, y: number) => (y * image.width + x) * 4;
      const bg = one.data.slice(at(one, width - 2, 1), at(one, width - 2, 1) + 3);
      const far = (d: Uint8ClampedArray, i: number, r: number, g: number, bl: number) =>
        Math.abs((d[i] ?? 0) - r) + Math.abs((d[i + 1] ?? 0) - g) + Math.abs((d[i + 2] ?? 0) - bl) >
        60;
      let ink = 0;
      let changed = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = at(one, x, y);
          const j = at(two, x, y);
          const inkOne = far(one.data, i, bg[0] ?? 0, bg[1] ?? 0, bg[2] ?? 0);
          const inkTwo = far(two.data, j, bg[0] ?? 0, bg[1] ?? 0, bg[2] ?? 0);
          if (inkOne) ink++;
          if (
            (inkOne || inkTwo) &&
            far(two.data, j, one.data[i] ?? 0, one.data[i + 1] ?? 0, one.data[i + 2] ?? 0)
          ) {
            changed++;
          }
        }
      }
      return { ink, changed };
    },
    { a: before.toString('base64'), b: after.toString('base64') },
  );
}

/** A screenshot of the visible terminal's text rows, without the cursor row. */
async function shotOf(rows: number, file: string): Promise<Buffer> {
  const box = await screen().boundingBox();
  if (!box) throw new Error('no terminal on screen');
  const cell = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(
      '[data-testid="terminal-tab"]:not([hidden]) .xterm-rows > div, [data-testid="terminal-tab"]:not([hidden]) .xterm-accessibility-tree > div',
    );
    return row?.getBoundingClientRect().height ?? 0;
  });
  const height = Math.min(box.height, cell > 0 ? cell * rows : box.height / 3);
  mkdirSync('ui-screenshots', { recursive: true });
  return page.screenshot({
    path: join('ui-screenshots', file),
    clip: { x: box.x, y: box.y, width: box.width, height },
  });
}

async function openLocal(): Promise<void> {
  const before = (await hooks()).tabs;
  await page.getByRole('button', { name: 'New local terminal' }).click();
  await expect.poll(async () => (await hooks()).tabs, { timeout: 15_000 }).toBe(before + 1);
  await expect.poll(async () => (await hooks()).state, { timeout: 30_000 }).toBe('connected');
  if (windows) {
    await expect.poll(async () => (await hooks()).text, { timeout: 30_000 }).toMatch(/PS .*>/);
  }
}

/** Clears the screen and prints `lines` known lines, then parks the cursor below them. */
async function printLines(tag: string, lines: number): Promise<void> {
  const clear = windows ? 'Clear-Host' : 'clear';
  const loop = windows
    ? `1..${lines} | ForEach-Object { Write-Output ('${tag} line ' + $_ + ' the quick brown fox ჯადოსნური') }`
    : `for i in $(seq 1 ${lines}); do printf '%s line %s the quick brown fox ჯადოსნური\\n' ${tag} $i; done`;
  await page.keyboard.type(`${clear}; ${loop}`);
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await hooks()).text, { timeout: 15_000 })
    .toContain(`${tag} line ${lines} the quick`);
  // Let the shell print its prompt and the renderer settle.
  await page.waitForTimeout(800);
}

test('a second and third local terminal leave the first one drawn intact', async () => {
  const form = page.getByRole('form', { name: 'Create vault' });
  await form.getByLabel('Master password', { exact: true }).fill(VAULT_PASSWORD);
  await form.getByLabel('Repeat the password').fill(VAULT_PASSWORD);
  await form.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByRole('region', { name: 'Hosts' })).toBeVisible();

  await openLocal();
  const renderer = (await hooks()).renderer;
  test.info().annotations.push({ type: 'renderer', description: renderer });
  // Linux CI draws with SwiftShader WebGL; a Windows runner may have no WebGL at all.
  if (!windows) expect(renderer).toBe('webgl');
  await printLines('AAAA', 6);
  const first = await shotOf(6, 'terminals-01-first.png');

  await openLocal();
  await printLines('BBBB', 4);
  await openLocal();
  await printLines('CCCC', 3);

  // Back to the first tab.
  await page.getByTestId('app-tab').first().click();
  await expect.poll(async () => (await hooks()).text).toContain('AAAA line 6');
  await page.waitForTimeout(800);
  const again = await shotOf(6, 'terminals-02-first-again.png');
  const { ink, changed } = await compare(first, again);
  expect(ink).toBeGreaterThan(500);
  expect(changed / ink).toBeLessThan(0.05);
});

test('a lost WebGL context falls back to the DOM renderer and still draws', async () => {
  test.skip((await hooks()).renderer !== 'webgl', 'no WebGL on this machine');
  await printLines('DDDD', 5);
  const before = await shotOf(5, 'terminals-03-before-loss.png');
  const lost = await page.evaluate(() => {
    const canvases = document.querySelectorAll<HTMLCanvasElement>(
      '[data-testid="terminal-tab"]:not([hidden]) canvas',
    );
    for (const canvas of canvases) {
      const gl = canvas.getContext('webgl2');
      const lose = gl?.getExtension('WEBGL_lose_context');
      if (lose) {
        lose.loseContext();
        return true;
      }
    }
    return false;
  });
  expect(lost).toBe(true);
  await expect.poll(async () => (await hooks()).renderer, { timeout: 10_000 }).toBe('dom');
  await page.waitForTimeout(500);
  await expect(
    page.locator('[data-testid="terminal-tab"]:not([hidden]) .xterm-rows'),
  ).toContainText('DDDD line 5');
  const after = await shotOf(5, 'terminals-04-after-loss.png');
  // The DOM renderer places glyphs a little differently, so only the amount of ink is compared.
  const inkBefore = (await compare(before, before)).ink;
  const inkAfter = (await compare(after, after)).ink;
  expect(inkBefore).toBeGreaterThan(500);
  expect(inkAfter / inkBefore).toBeGreaterThan(0.7);
  expect(inkAfter / inkBefore).toBeLessThan(1.4);

  // The other terminals keep drawing.
  await page.getByTestId('app-tab').nth(1).click();
  await expect.poll(async () => (await hooks()).text).toContain('BBBB line 4');
  await printLines('EEEE', 2);
  await expect.poll(async () => (await hooks()).renderer).toMatch(/webgl|dom/);
});
