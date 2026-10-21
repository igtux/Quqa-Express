import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // The end-to-end SSH tests talk to a real server.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
