import { describe, expect, it } from 'vitest';
import { clipboardAction, digitKey, isLetterKey, zoomKey } from './keys.js';

const key = (key: string, code: string) => ({ key, code }) as KeyboardEvent;

describe('layout-independent shortcuts', () => {
  it('finds a letter by its physical key on Georgian and Russian layouts', () => {
    expect(isLetterKey(key('ვ', 'KeyV'), 'v')).toBe(true);
    expect(isLetterKey(key('м', 'KeyV'), 'v')).toBe(true);
    expect(isLetterKey(key('კ', 'KeyK'), 'K')).toBe(true);
    expect(isLetterKey(key('ც', 'KeyC'), 'v')).toBe(false);
  });

  it('still accepts a letter a layout moved (Dvorak)', () => {
    expect(isLetterKey(key('v', 'Period'), 'v')).toBe(true);
  });

  it('reads digits and zoom keys by physical key', () => {
    expect(digitKey(key('!', 'Digit1'))).toBe(1);
    expect(digitKey(key('0', 'Digit0'))).toBeNull();
    expect(zoomKey(key('=', 'Equal'))).toBe(1);
    expect(zoomKey(key('ž', 'Equal'))).toBe(1);
    expect(zoomKey(key('-', 'NumpadSubtract'))).toBe(-1);
    expect(zoomKey(key('à', 'Digit0'))).toBe('reset');
    expect(zoomKey(key('ა', 'KeyA'))).toBeNull();
  });
});

type Mods = { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
const press = (key: string, code: string, mods: Mods = {}) =>
  ({
    key,
    code,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
  }) as KeyboardEvent;

describe('clipboard keys in the terminal', () => {
  // The V and C keys as each layout reports them (unshifted, shifted).
  const layouts = {
    latin: { v: ['v', 'V'], c: ['c', 'C'] },
    georgian: { v: ['ვ', 'ვ'], c: ['ც', 'ჩ'] },
    russian: { v: ['м', 'М'], c: ['с', 'С'] },
  } as const;

  for (const [name, { v, c }] of Object.entries(layouts)) {
    it(`pastes and copies with the ${name} layout`, () => {
      expect(clipboardAction(press(v[0], 'KeyV', { ctrl: true }), false)).toBe('paste');
      expect(clipboardAction(press(v[1], 'KeyV', { ctrl: true, shift: true }), false)).toBe(
        'paste',
      );
      expect(clipboardAction(press(c[1], 'KeyC', { ctrl: true, shift: true }), false)).toBe('copy');
      expect(clipboardAction(press(c[0], 'KeyC', { ctrl: true }), true)).toBe('copy');
      // Nothing selected: Ctrl+C stays ^C (SIGINT).
      expect(clipboardAction(press(c[0], 'KeyC', { ctrl: true }), false)).toBeNull();
      // Typing the letter itself is not a shortcut.
      expect(clipboardAction(press(v[0], 'KeyV'), false)).toBeNull();
      expect(clipboardAction(press(v[1], 'KeyV', { shift: true }), false)).toBeNull();
    });
  }

  it('pastes with Shift+Insert and copies with Ctrl+Insert', () => {
    expect(clipboardAction(press('Insert', 'Insert', { shift: true }), false)).toBe('paste');
    expect(clipboardAction(press('Insert', 'Insert', { ctrl: true }), true)).toBe('copy');
    expect(clipboardAction(press('Insert', 'Insert'), false)).toBeNull();
    expect(
      clipboardAction(press('Insert', 'Insert', { ctrl: true, shift: true }), false),
    ).toBeNull();
  });

  it('leaves AltGr (Ctrl+Alt) and other Ctrl keys to the terminal', () => {
    expect(clipboardAction(press('v', 'KeyV', { ctrl: true, alt: true }), false)).toBeNull();
    expect(clipboardAction(press('ც', 'KeyC', { ctrl: true, alt: true }), true)).toBeNull();
    expect(clipboardAction(press('a', 'KeyA', { ctrl: true }), true)).toBeNull();
    expect(clipboardAction(press('ზ', 'KeyZ', { ctrl: true }), false)).toBeNull();
  });

  it('takes Cmd for Ctrl on macOS', () => {
    expect(clipboardAction(press('v', 'KeyV', { meta: true }), false)).toBe('paste');
  });
});
