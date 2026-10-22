import { describe, expect, it } from 'vitest';
import { GlyphAtlas, type GlyphUser } from './glyphs.js';

function user(log: string[], name: string): GlyphUser {
  return { redrawGlyphs: () => log.push(name) };
}

describe('GlyphAtlas', () => {
  it('redraws every terminal, not only the one whose font loaded', () => {
    const queue: (() => void)[] = [];
    const atlas = new GlyphAtlas((run) => queue.push(run));
    const log: string[] = [];
    const first = user(log, 'first');
    atlas.add(first);
    atlas.add(user(log, 'second'));
    atlas.add(user(log, 'third'));
    atlas.invalidate();
    expect(log).toEqual([]);
    queue.shift()?.();
    expect(log).toEqual(['first', 'second', 'third']);
  });

  it('coalesces several clears in one task into one redraw each', () => {
    const queue: (() => void)[] = [];
    const atlas = new GlyphAtlas((run) => queue.push(run));
    const log: string[] = [];
    atlas.add(user(log, 'a'));
    atlas.invalidate();
    atlas.invalidate();
    atlas.invalidate();
    expect(queue).toHaveLength(1);
    queue.shift()?.();
    expect(log).toEqual(['a']);
    atlas.invalidate();
    expect(queue).toHaveLength(1);
  });

  it('forgets closed terminals', () => {
    const queue: (() => void)[] = [];
    const atlas = new GlyphAtlas((run) => queue.push(run));
    const log: string[] = [];
    const closed = user(log, 'closed');
    atlas.add(closed);
    atlas.add(user(log, 'open'));
    atlas.delete(closed);
    atlas.invalidate();
    queue.shift()?.();
    expect(log).toEqual(['open']);
    expect(atlas.size).toBe(1);
  });
});
