/**
 * The update check's pure half: versions, the GitHub releases list, and
 * SHA256SUMS.txt. Everything from the network is untrusted and checked here
 * before main acts on it (docs/adr/0006-update-check-themes-georgian.md).
 */

export const REPOSITORY = 'igtux/Quqa-Express';
export const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;
const PAGE_PREFIX = `https://github.com/${REPOSITORY}/releases/tag/`;
const DOWNLOAD_PREFIX = `https://github.com/${REPOSITORY}/releases/download/`;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
/** Where GitHub's release downloads may redirect to. */
export const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
export const MAX_NOTES_LENGTH = 20_000;

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: (string | number)[];
}

const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text);
  if (!match) return null;
  const pre = (match[4]?.split('.') ?? []).map((part) =>
    /^\d+$/.test(part) ? Number(part) : part,
  );
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre };
}

/** Semantic-versioning order: 0.1.0-beta.2 < 0.1.0-beta.10 < 0.1.0-rc.1 < 0.1.0. */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join('.')}` : ''}`;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface Release {
  /** Without the leading "v". */
  version: string;
  tag: string;
  publishedAt: string;
  prerelease: boolean;
  /** The changelog part of the release body (Markdown, rendered as text). */
  notes: string;
  /** The release page on github.com. */
  page: string;
  setup: ReleaseAsset | null;
  /** The portable exe, which the portable build swaps in for itself. */
  portable: ReleaseAsset | null;
  sums: ReleaseAsset | null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/** The release body up to the download instructions, with control characters removed. */
export function releaseNotes(body: string): string {
  const cut = body.search(/^## Download\b/m);
  const notes = (cut >= 0 ? body.slice(0, cut) : body)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  return notes.length > MAX_NOTES_LENGTH ? `${notes.slice(0, MAX_NOTES_LENGTH)}…` : notes;
}

function asset(raw: unknown, tag: string, name: string): ReleaseAsset | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const url = text(a['browser_download_url'], 512);
  const size = a['size'];
  if (a['name'] !== name || !url || typeof size !== 'number' || size <= 0) return null;
  if (url !== `${DOWNLOAD_PREFIX}${tag}/${name}`) return null;
  return { name, url, size };
}

/** One entry of the GitHub releases list, or null if anything about it is off. */
export function parseRelease(raw: unknown): Release | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['draft'] !== false) return null;
  const tag = text(r['tag_name'], 64);
  const version = tag && SAFE_SEGMENT.test(tag) ? parseVersion(tag) : null;
  if (!tag || !version || !tag.startsWith('v')) return null;
  const page = text(r['html_url'], 512);
  if (page !== `${PAGE_PREFIX}${tag}`) return null;
  const publishedAt = text(r['published_at'], 40);
  if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) return null;
  const name = formatVersion(version);
  const assets = Array.isArray(r['assets']) ? (r['assets'] as unknown[]).slice(0, 50) : [];
  const find = (file: string) =>
    assets.map((a) => asset(a, tag, file)).find((a): a is ReleaseAsset => a !== null) ?? null;
  return {
    version: name,
    tag,
    publishedAt,
    prerelease: r['prerelease'] === true,
    notes: releaseNotes(text(r['body'], 200_000) ?? ''),
    page,
    setup: find(`quqa-express-${name}-setup.exe`),
    portable: find(`quqa-express-${name}-portable.exe`),
    sums: find('SHA256SUMS.txt'),
  };
}

/**
 * The newest release above `current`, unless the user skipped it. Pre-releases
 * count only while the running app is a pre-release itself.
 */
export function pickUpdate(
  releases: unknown,
  current: string,
  skipped: string | null,
): Release | null {
  const mine = parseVersion(current);
  if (!mine || !Array.isArray(releases)) return null;
  const withPre = mine.pre.length > 0;
  let best: { release: Release; version: Version } | null = null;
  for (const raw of releases.slice(0, 100)) {
    const release = parseRelease(raw);
    if (!release || (release.prerelease && !withPre)) continue;
    const version = parseVersion(release.version);
    if (!version || compareVersions(version, mine) <= 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { release, version };
  }
  if (!best) return null;
  return best.release.version === skipped ? null : best.release;
}

/** The SHA-256 of `file` in a sha256sum-format SHA256SUMS.txt, lower case. */
export function expectedHash(sums: string, file: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === file) return (match[1] as string).toLowerCase();
  }
  return null;
}
