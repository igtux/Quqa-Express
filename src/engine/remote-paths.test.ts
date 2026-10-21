import { describe, expect, it } from 'vitest';
import {
  assertValidName,
  assertWithinRoots,
  effectiveRoots,
  isWithinRoots,
  normaliseAbsolutePath,
} from './remote-paths.js';

describe('remote paths', () => {
  it('normalises absolute paths and refuses relative ones and NUL', () => {
    expect(normaliseAbsolutePath('/srv//app/../data/')).toBe('/srv/data');
    expect(normaliseAbsolutePath('/')).toBe('/');
    expect(normaliseAbsolutePath('/../../etc')).toBe('/etc');
    expect(() => normaliseAbsolutePath('srv/app')).toThrow();
    expect(() => normaliseAbsolutePath('~/x')).toThrow();
    expect(() => normaliseAbsolutePath('/a\0b')).toThrow();
    expect(() => normaliseAbsolutePath(`/${'a'.repeat(5000)}`)).toThrow();
  });

  it('keeps paths under the roots (prefixes are not enough)', () => {
    const roots = ['/srv/app', '/var/log/'];
    expect(isWithinRoots('/srv/app', roots)).toBe(true);
    expect(isWithinRoots('/srv/app/data/x', roots)).toBe(true);
    expect(isWithinRoots('/var/log/syslog', roots)).toBe(true);
    expect(isWithinRoots('/srv/application', roots)).toBe(false);
    expect(isWithinRoots('/srv', roots)).toBe(false);
    expect(isWithinRoots('/etc/passwd', roots)).toBe(false);
    expect(isWithinRoots('/etc/passwd', [])).toBe(true);
    expect(effectiveRoots([])).toEqual(['/']);
    expect(() => assertWithinRoots('/srv/app/../../etc', roots)).toThrow(/outside/);
  });

  it('accepts single names only', () => {
    expect(() => assertValidName('report.pdf')).not.toThrow();
    for (const bad of ['', '.', '..', 'a/b', 'a\0b', 'x'.repeat(256)]) {
      expect(() => assertValidName(bad)).toThrow();
    }
  });
});
