import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../shared/csp.js';
import { APP_ENTRY, contentTypeOf, isAppUrl, resolveAppPath } from './urls.js';

describe('isAppUrl', () => {
  it('allows only the app:// origin in a build', () => {
    expect(isAppUrl(APP_ENTRY, undefined)).toBe(true);
    expect(isAppUrl('app://quqa/assets/index-abc.js', undefined)).toBe(true);
    expect(isAppUrl('app://other/index.html', undefined)).toBe(false);
    expect(isAppUrl('file:///C:/app/resources/app.asar/out/renderer/index.html', undefined)).toBe(
      false,
    );
    expect(isAppUrl('https://example.com/', undefined)).toBe(false);
    expect(isAppUrl('http://localhost:5173/', undefined)).toBe(false);
    expect(isAppUrl('ws://localhost:5173/', undefined)).toBe(false);
    expect(isAppUrl('not a url', undefined)).toBe(false);
  });

  it('allows the dev server, and only it, while developing', () => {
    const dev = 'http://localhost:5173';
    expect(isAppUrl('http://localhost:5173/src/main.tsx', dev)).toBe(true);
    expect(isAppUrl('ws://localhost:5173/', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('https://evil.example/', dev)).toBe(false);
  });
});

describe('resolveAppPath', () => {
  const root = resolve('/opt/quqa/out/renderer');

  it('maps app:// URLs to files under the renderer folder', () => {
    expect(resolveAppPath('app://quqa/index.html', root)).toBe(join(root, 'index.html'));
    expect(resolveAppPath('app://quqa/', root)).toBe(join(root, 'index.html'));
    expect(resolveAppPath('app://quqa/assets/index-B1.js?x=1#y', root)).toBe(
      join(root, 'assets', 'index-B1.js'),
    );
  });

  it.each([
    'app://quqa/../main/index.js',
    'app://quqa/%2e%2e/main/index.js',
    'app://quqa/assets/../../../main/index.js',
  ])('never leaves the renderer folder for %s', (url) => {
    const file = resolveAppPath(url, root);
    expect(file === null || file.startsWith(root + (root.endsWith('/') ? '' : '/'))).toBe(true);
  });

  it.each([
    'app://quqa/assets/..%2f..%2fmain%2findex.js',
    'app://quqa/assets%5c..%5c..%5cmain.js',
    'app://quqa//etc/passwd',
    'app://quqa/%00.html',
    'app://quqa/a%ZZ',
    'app://evil/index.html',
    'file:///etc/passwd',
    'https://quqa/index.html',
  ])('refuses %s', (url) => {
    expect(resolveAppPath(url, root)).toBeNull();
  });

  it('knows the content types the build uses', () => {
    expect(contentTypeOf('a/index.html')).toMatch(/^text\/html/);
    expect(contentTypeOf('a/x.js')).toMatch(/^text\/javascript/);
    expect(contentTypeOf('a/x.css')).toMatch(/^text\/css/);
    expect(contentTypeOf('a/x.woff2')).toBe('font/woff2');
    expect(contentTypeOf('a/x.unknown')).toBe('application/octet-stream');
  });
});

describe('contentSecurityPolicy', () => {
  it('is strict in a build', () => {
    const policy = contentSecurityPolicy(false);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toMatch(/script-src[^;]*unsafe/);
    expect(policy).not.toContain('http:');
    expect(policy).not.toContain('ws:');
    expect(policy).toContain("object-src 'none'");
  });
});
