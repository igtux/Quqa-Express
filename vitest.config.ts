import { defineConfig } from 'vitest/config';

// On GitHub Actions also write a JSON report (scripts/ci-failures.mjs lists every failure).
const ci = process.env['GITHUB_ACTIONS'] === 'true';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // The end-to-end SSH tests talk to a real server.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    ...(ci && {
      reporters: ['default', 'github-actions', 'json'],
      outputFile: { json: 'test-results/vitest.json' },
    }),
  },
});
