import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  expectedHash,
  parseRelease,
  parseVersion,
  pickUpdate,
  releaseNotes,
  type Version,
} from './updates.js';

const v = (text: string) => parseVersion(text) as Version;
const tagUrl = (tag: string) => `https://github.com/igtux/Quqa-Express/releases/tag/${tag}`;
const asset = (tag: string, name: string) => ({
  name,
  size: 1000,
  browser_download_url: `https://github.com/igtux/Quqa-Express/releases/download/${tag}/${name}`,
});

function release(tag: string, extra: Record<string, unknown> = {}) {
  const version = tag.slice(1);
  return {
    tag_name: tag,
    html_url: tagUrl(tag),
    draft: false,
    prerelease: tag.includes('-'),
    published_at: '2026-10-21T10:00:00Z',
    body: `## What's new\n\n- Things for ${tag}\n\n## Download\n\n- the exe`,
    assets: [asset(tag, `quqa-express-${version}-setup.exe`), asset(tag, 'SHA256SUMS.txt')],
    ...extra,
  };
}

describe('versions', () => {
  it('orders versions and pre-releases like semver', () => {
    const order = [
      '0.1.0-beta.2',
      '0.1.0-beta.3',
      '0.1.0-beta.10',
      '0.1.0-rc.1',
      '0.1.0',
      '0.1.1',
      '0.2.0',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0',
    ];
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(compareVersions(v(order[i] as string), v(order[i + 1] as string))).toBe(-1);
      expect(compareVersions(v(order[i + 1] as string), v(order[i] as string))).toBe(1);
    }
    expect(compareVersions(v('v0.1.0-beta.4'), v('0.1.0-beta.4'))).toBe(0);
  });

  it('rejects anything that is not a version', () => {
    for (const bad of ['', '1.2', '1.2.3.4', 'v1.2.3-', '1.2.3-beta..1', '1.2.3 ', '1.2.3-ä']) {
      expect(parseVersion(bad)).toBeNull();
    }
  });
});

describe('picking an update', () => {
  it('takes the newest release above the running version, pre-releases while on one', () => {
    const list = [release('v0.1.0-beta.3'), release('v0.1.0-beta.5'), release('v0.1.0-beta.4')];
    expect(pickUpdate(list, '0.1.0-beta.4', null)?.version).toBe('0.1.0-beta.5');
    expect(pickUpdate(list, '0.1.0-beta.5', null)).toBeNull();
    // A stable build ignores pre-releases.
    expect(pickUpdate([...list, release('v0.2.0-beta.1')], '0.1.0', null)).toBeNull();
    expect(pickUpdate([release('v0.1.1')], '0.1.0', null)?.version).toBe('0.1.1');
  });

  it('honours "skip this version" until a newer one appears', () => {
    const list = [release('v0.1.0-beta.5')];
    expect(pickUpdate(list, '0.1.0-beta.4', '0.1.0-beta.5')).toBeNull();
    expect(
      pickUpdate([...list, release('v0.1.0-beta.6')], '0.1.0-beta.4', '0.1.0-beta.5')?.version,
    ).toBe('0.1.0-beta.6');
  });

  it('ignores drafts, foreign pages and assets, and malformed entries', () => {
    const current = '0.1.0-beta.4';
    expect(pickUpdate([release('v0.1.0-beta.9', { draft: true })], current, null)).toBeNull();
    expect(
      pickUpdate(
        [release('v0.1.0-beta.9', { html_url: 'https://evil.example/releases/tag/v0.1.0-beta.9' })],
        current,
        null,
      ),
    ).toBeNull();
    expect(pickUpdate([release('v9.9.9/../x')], current, null)).toBeNull();
    expect(pickUpdate([null, 1, 'x', {}], current, null)).toBeNull();
    expect(pickUpdate({ not: 'a list' }, current, null)).toBeNull();

    const foreign = parseRelease(
      release('v0.1.0-beta.9', {
        assets: [
          {
            name: 'quqa-express-0.1.0-beta.9-setup.exe',
            size: 5,
            browser_download_url: 'https://evil.example/quqa-express-0.1.0-beta.9-setup.exe',
          },
        ],
      }),
    );
    expect(foreign?.setup).toBeNull();
    expect(foreign?.sums).toBeNull();
    const good = parseRelease(release('v0.1.0-beta.9'));
    expect(good?.setup?.name).toBe('quqa-express-0.1.0-beta.9-setup.exe');
    expect(good?.sums?.url).toMatch(/\/v0\.1\.0-beta\.9\/SHA256SUMS\.txt$/);
  });
});

describe('release notes and checksums', () => {
  it('keeps the changelog part of the body and strips control characters', () => {
    expect(releaseNotes("## What's new\n\n- A\u001b[31m\u202e\n\n## Download\n\n- exe")).toBe(
      "## What's new\n\n- A[31m",
    );
    expect(releaseNotes('x'.repeat(30_000))).toHaveLength(20_001);
  });

  it('finds a file in SHA256SUMS.txt', () => {
    const hash = 'ab'.repeat(32);
    const sums = `${'cd'.repeat(32)}  quqa-express-1-portable.exe\r\n${hash.toUpperCase()}  quqa-express-1-setup.exe\n`;
    expect(expectedHash(sums, 'quqa-express-1-setup.exe')).toBe(hash);
    expect(expectedHash(sums, 'quqa-express-1.exe')).toBeNull();
    expect(expectedHash('garbage', 'x')).toBeNull();
  });
});
