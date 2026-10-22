import { describe, expect, it } from 'vitest';
import { moveFocus, placeMenu, tidy, type MenuEntry } from './menuModel.js';

const item = (label: string): MenuEntry => ({ label, icon: 'pencil', onSelect: () => undefined });

describe('tidy', () => {
  it('drops hidden items, stray separators and empty headings', () => {
    const list = tidy([
      { kind: 'separator' },
      { kind: 'heading', label: 'Empty' },
      { kind: 'separator' },
      item('a'),
      false,
      { kind: 'separator' },
      { kind: 'separator' },
      null,
      { kind: 'heading', label: 'Group' },
      item('b'),
      { kind: 'separator' },
    ]);
    expect(list.map((e) => ('label' in e ? e.label : '—'))).toEqual(['a', '—', 'Group', 'b']);
  });
});

describe('moveFocus', () => {
  const enabled = [true, false, true, true];
  it('moves down and up, skipping disabled items and wrapping', () => {
    expect(moveFocus('ArrowDown', 0, enabled)).toBe(2);
    expect(moveFocus('ArrowDown', 3, enabled)).toBe(0);
    expect(moveFocus('ArrowUp', 0, enabled)).toBe(3);
    expect(moveFocus('ArrowUp', 2, enabled)).toBe(0);
  });
  it('starts from the first or last item when nothing has focus', () => {
    expect(moveFocus('ArrowDown', -1, enabled)).toBe(0);
    expect(moveFocus('ArrowUp', -1, enabled)).toBe(3);
  });
  it('Home and End jump to the ends; other keys are not menu keys', () => {
    expect(moveFocus('Home', 3, [false, true, true])).toBe(1);
    expect(moveFocus('End', 1, enabled)).toBe(3);
    expect(moveFocus('a', 1, enabled)).toBeNull();
    expect(moveFocus('ArrowDown', 0, [false, false])).toBeNull();
  });
});

describe('placeMenu', () => {
  const view = { width: 1000, height: 700 };
  it('opens at the point when it fits', () => {
    expect(placeMenu({ x: 100, y: 50 }, { width: 240, height: 300 }, view)).toEqual({
      left: 100,
      top: 50,
    });
  });
  it('stays inside the right edge and opens upwards near the bottom', () => {
    expect(placeMenu({ x: 950, y: 600 }, { width: 240, height: 300 }, view)).toEqual({
      left: 752,
      top: 300,
    });
  });
  it('never goes above the top of a short window', () => {
    expect(placeMenu({ x: 0, y: 100 }, { width: 240, height: 900 }, view).top).toBe(8);
  });
});
