import { describe, expect, it } from 'vitest';
import type { ConnSnapshot } from './connection.js';
import {
  buildRows,
  filterRows,
  formatIdle,
  fuzzyScore,
  groupRows,
  rowNameInGroup,
  sortRows,
  summarize,
  type OpenTerminal,
} from './dockModel.js';

const NAME_A = `quqa-${'a'.repeat(32)}`;
const NAME_B = `quqa-${'b'.repeat(32)}`;
const NAME_C = `quqa-${'c'.repeat(32)}`;

const snapshot = (change: Partial<ConnSnapshot> = {}): ConnSnapshot => ({
  state: 'connected',
  statusText: 'Connected',
  reason: '',
  errorCode: null,
  attempt: 0,
  hostKey: null,
  prompt: null,
  hostKeyChanged: null,
  pasteRequest: null,
  clipboardRequest: null,
  pendingInput: 0,
  renderer: 'dom',
  tmux: null,
  unread: false,
  attention: false,
  busy: false,
  scrolledBack: false,
  historyUnread: false,
  history: false,
  historyMode: false,
  notice: null,
  ...change,
});

const open = (tag: string, change: Partial<OpenTerminal> = {}): OpenTerminal => ({
  tag,
  hostId: 'h_web',
  hostName: 'web',
  session: null,
  snapshot: snapshot(),
  shown: false,
  createdAt: '2026-10-21T00:00:00.000Z',
  ...change,
});

const session = (name: string, change: Record<string, unknown> = {}) => ({
  name,
  attached: 0,
  createdAt: '2026-10-20T00:00:00.000Z',
  idleSeconds: 120,
  path: '/srv/app',
  command: 'bash',
  ...change,
});

describe('buildRows', () => {
  it('merges open terminals with the tmux sessions found on hosts', () => {
    const rows = buildRows({
      open: [open('t1', { session: NAME_A, snapshot: snapshot({ tmux: NAME_A }) }), open('t2')],
      hosts: [
        {
          hostId: 'h_web',
          hostName: 'web',
          sessions: [session(NAME_A, { path: '/home/u/proj' }), session(NAME_B), session(NAME_C)],
        },
      ],
      aliases: new Map([[NAME_B, 'build']]),
      pinned: new Set([NAME_C]),
      forgotten: new Set([NAME_C]),
    });
    expect(rows.map((r) => [r.key, r.state])).toEqual([
      ['t1', 'live'],
      ['t2', 'live'],
      [`h_web/${NAME_B}`, 'detached'],
    ]);
    // The open tmux terminal shows the folder tmux reports.
    expect(rows[0]?.folder).toBe('proj');
    expect(rows[2]).toMatchObject({ label: 'build', aliased: true, tag: null, session: NAME_B });
    expect(rows[2]?.statusText).toBe('Detached · idle 2m · bash');
  });

  it('maps connection states to row states and texts', () => {
    const rows = buildRows({
      open: [
        open('a', {
          snapshot: snapshot({ state: 'reconnecting', statusText: 'Reconnecting (2/6)…' }),
        }),
        open('b', { snapshot: snapshot({ state: 'disconnected' }) }),
        open('c', { snapshot: snapshot({ state: 'ended' }) }),
        open('d', { snapshot: snapshot({ busy: true, attention: true }) }),
        open('e', { snapshot: snapshot({ state: 'host-key', hostKey: {} as never }) }),
      ],
      hosts: [],
      aliases: new Map(),
      pinned: new Set(['b']),
      forgotten: new Set(),
    });
    expect(rows.map((r) => [r.state, r.statusText])).toEqual([
      ['connecting', 'Reconnecting (2/6)…'],
      ['down', 'Offline — click to retry'],
      ['ended', 'Ended — session gone'],
      ['live', 'Live · working'],
      ['connecting', 'Waiting for you'],
    ]);
    expect(rows[1]?.pinned).toBe(true);
  });

  it('marks sessions attached by another client as elsewhere', () => {
    const [row] = buildRows({
      open: [],
      hosts: [{ hostId: 'h1', hostName: 'db', sessions: [session(NAME_A, { attached: 1 })] }],
      aliases: new Map(),
      pinned: new Set(),
      forgotten: new Set(),
    });
    expect(row?.state).toBe('elsewhere');
    expect(row?.statusText).toMatch(/^Open elsewhere/);
  });
});

describe('sortRows', () => {
  it('orders pinned (pin order) → attention → running → detached → down → ended', () => {
    const rows = buildRows({
      open: [
        open('ended', { snapshot: snapshot({ state: 'ended' }) }),
        open('down', { snapshot: snapshot({ state: 'denied', statusText: 'Access denied' }) }),
        open('live'),
        open('attn', { snapshot: snapshot({ attention: true }) }),
        open('pin2'),
        open('pin1'),
      ],
      hosts: [{ hostId: 'h_web', hostName: 'web', sessions: [session(NAME_A)] }],
      aliases: new Map(),
      pinned: new Set(['pin1', 'pin2']),
      forgotten: new Set(),
    });
    expect(sortRows(rows, ['pin1', 'pin2']).map((r) => r.key)).toEqual([
      'pin1',
      'pin2',
      'attn',
      'live',
      `h_web/${NAME_A}`,
      'down',
      'ended',
    ]);
  });
});

describe('fuzzy search (dock filter and switcher)', () => {
  it('prefers direct substrings, then subsequences with fewer gaps', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('web', 'prod web server')).toBe(5);
    expect(fuzzyScore('pws', 'prod web server')).toBeGreaterThan(1000);
    expect(fuzzyScore('pws', 'prod web server')).toBeLessThan(fuzzyScore('pws', 'p......w......s'));
    expect(fuzzyScore('xyz', 'prod web server')).toBe(-1);
  });

  it('filters and ranks rows; an empty query keeps the order', () => {
    const rows = [{ search: 'db replica' }, { search: 'web server' }, { search: 'web' }];
    expect(filterRows(rows, '')).toBe(rows);
    expect(filterRows(rows, 'web').map((r) => r.search)).toEqual(['web server', 'web']);
    expect(filterRows(rows, 'wbsrv').map((r) => r.search)).toEqual(['web server']);
    expect(filterRows(rows, 'zzz')).toEqual([]);
  });
});

describe('grouping and texts', () => {
  it('groups by host in order of first appearance', () => {
    const rows = buildRows({
      open: [open('t1'), open('t2', { hostId: 'h_db', hostName: 'db' }), open('t3')],
      hosts: [],
      aliases: new Map(),
      pinned: new Set(),
      forgotten: new Set(),
    });
    expect(groupRows(rows).map((g) => [g.name, g.rows.length])).toEqual([
      ['web', 2],
      ['db', 1],
    ]);
  });

  it('summarises and formats idle time', () => {
    expect(formatIdle(30)).toBe('active now');
    expect(formatIdle(600)).toBe('idle 10m');
    expect(formatIdle(7200)).toBe('idle 2h');
    expect(formatIdle(200_000)).toBe('idle 2d');
    const rows = buildRows({
      open: [open('t1'), open('t2', { snapshot: snapshot({ state: 'ended' }) })],
      hosts: [{ hostId: 'h_web', hostName: 'web', sessions: [session(NAME_A)] }],
      aliases: new Map(),
      pinned: new Set(),
      forgotten: new Set(),
    });
    expect(summarize(rows).text).toBe('1 live · 1 detached · 1 ended');
    expect(summarize([]).text).toBe('No sessions');
    const detached = rows[2];
    expect(detached && rowNameInGroup(detached)).toBe('app');
  });
});
