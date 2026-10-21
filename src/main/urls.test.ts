import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../electron.vite.config.js';
import { isAppUrl } from './urls.js';

describe('isAppUrl', () => {
  it('allows only bundled files in a build', () => {
    expect(isAppUrl('file:///C:/app/resources/app.asar/out/renderer/index.html', undefined)).toBe(
      true,
    );
    expect(isAppUrl('https://example.com/', undefined)).toBe(false);
    expect(isAppUrl('http://localhost:5173/', undefined)).toBe(false);
    expect(isAppUrl('ws://localhost:5173/', undefined)).toBe(false);
  });

  it('allows the dev server, and only it, while developing', () => {
    const dev = 'http://localhost:5173';
    expect(isAppUrl('http://localhost:5173/src/main.tsx', dev)).toBe(true);
    expect(isAppUrl('ws://localhost:5173/', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('https://evil.example/', dev)).toBe(false);
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
