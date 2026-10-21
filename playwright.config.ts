import { defineConfig } from '@playwright/test';

/** UI smoke test of the built app (`pnpm test:ui`; needs a display, e.g. xvfb-run). */
export default defineConfig({
  testDir: 'test/ui',
  timeout: 90_000,
  workers: 1,
  // On GitHub Actions failures also become annotations (job logs need a login).
  reporter: process.env['GITHUB_ACTIONS'] === 'true' ? [['list'], ['github']] : [['list']],
  use: { trace: 'retain-on-failure' },
});
