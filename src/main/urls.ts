/** URL rules for the renderer (kept free of Electron imports so tests can load it). */
import { extname, resolve, sep } from 'node:path';

/** The bundled renderer is served from this origin by main's protocol handler. */
export const APP_SCHEME = 'app';
export const APP_HOST = 'quqa';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY = `${APP_ORIGIN}/index.html`;

/** Where the renderer's own files come from: app://quqa in a build, the dev server in `pnpm dev`. */
export function isAppUrl(url: string, devServerUrl: string | undefined): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (devServerUrl) {
    try {
      const dev = new URL(devServerUrl);
      if ((target.protocol === 'http:' || target.protocol === 'ws:') && target.host === dev.host) {
        return true;
      }
    } catch {
      return false;
    }
  }
  if (target.protocol === `${APP_SCHEME}:`) return target.host === APP_HOST;
  return target.protocol === 'devtools:' || target.protocol === 'data:';
}

/**
 * The file under `root` that an app:// URL names, or null for anything
 * outside it (another host, `..`, encoded separators, odd characters).
 */
export function resolveAppPath(url: string, root: string): string | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== `${APP_SCHEME}:` || target.host !== APP_HOST) return null;
  let path: string;
  try {
    path = decodeURIComponent(target.pathname);
  } catch {
    return null;
  }
  if (path === '/' || path === '') path = '/index.html';
  if (!/^\/[A-Za-z0-9._\-/]+$/.test(path) || path.includes('..') || path.includes('//')) {
    return null;
  }
  const base = resolve(root);
  const file = resolve(base, `.${path}`);
  return file.startsWith(base + sep) ? file : null;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

export function contentTypeOf(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Longest link the app will hand to the system browser. */
export const MAX_EXTERNAL_URL = 2048;

/**
 * The link to open in the system browser, or null: only `http(s)` URLs with
 * a host, no user name or password in them, no control characters or spaces.
 */
export function externalUrl(text: unknown): string | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_EXTERNAL_URL) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.href;
}
