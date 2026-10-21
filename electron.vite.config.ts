import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { contentSecurityPolicy } from './src/shared/csp.js';

function csp(): Plugin {
  let dev = false;
  return {
    name: 'quqa-csp',
    configResolved(config) {
      dev = config.command === 'serve';
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy(dev) },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  main: {
    // The update check compares against it (app.getVersion() is Electron's
    // own version when the app runs unpackaged from out/).
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          engine: resolve('src/engine/index.ts'),
          // Local terminals (node-pty), a utilityProcess of their own (ADR 0007).
          pty: resolve('src/pty/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // A sandboxed preload must be a single CommonJS file.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
    plugins: [react(), csp()],
    // Shown in the About dialog.
    define: { __APP_VERSION__: JSON.stringify(version) },
  },
});
