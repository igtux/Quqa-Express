import { describe, expect, it } from 'vitest';
import { digitKey, isLetterKey, zoomKey } from './keys.js';

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
