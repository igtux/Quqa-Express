import { describe, expect, it } from 'vitest';
import { DEFAULT_SIZE, parseWindowState, placeWindow } from './window-state.js';

const screen = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 1280, height: 984 };

describe('window state', () => {
  it('reads only a sane saved state', () => {
    const good = { bounds: { x: 10, y: 20, width: 900, height: 600 }, maximized: true };
    expect(parseWindowState(JSON.stringify(good))).toEqual(good);
    for (const bad of [
      '',
      'null',
      '{"bounds":{"x":1,"y":1,"width":10,"height":600},"maximized":false}',
      '{"bounds":{"x":1.5,"y":1,"width":900,"height":600},"maximized":false}',
      '{"bounds":{"x":1,"y":1,"width":900,"height":600},"maximized":"yes"}',
      '{"bounds":{"x":"1","y":1,"width":900,"height":600},"maximized":false}',
      '{"__proto__":{"maximized":true}}',
    ]) {
      expect(parseWindowState(bad)).toBeNull();
    }
  });

  it('opens at the default size the first time', () => {
    expect(placeWindow(null, [screen])).toEqual({ bounds: DEFAULT_SIZE, maximized: false });
  });

  it('restores a window on a display that is still there, kept inside it', () => {
    const saved = { bounds: { x: 2000, y: 100, width: 1000, height: 700 }, maximized: false };
    expect(placeWindow(saved, [screen, right]).bounds).toEqual(saved.bounds);
    const tooBig = { bounds: { x: 1900, y: -5, width: 1300, height: 1000 }, maximized: true };
    expect(placeWindow(tooBig, [screen, right])).toEqual({
      bounds: { x: 1920, y: 0, width: 1280, height: 984 },
      maximized: true,
    });
  });

  it('keeps only the size when the display is gone', () => {
    const saved = { bounds: { x: 2000, y: 100, width: 1000, height: 700 }, maximized: false };
    expect(placeWindow(saved, [screen])).toEqual({
      bounds: { width: 1000, height: 700 },
      maximized: false,
    });
  });
});
