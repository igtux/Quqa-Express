import { defineConfig } from '@playwright/test';

/** UI smoke test of the built app (`pnpm test:ui`; needs a display, e.g. xvfb-run). */
export default defineConfig({
  testDir: 'test/ui',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
