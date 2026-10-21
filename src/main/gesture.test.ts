import { describe, expect, it } from 'vitest';
import { GESTURE_WINDOW_MS, UserGesture } from './gesture.js';

describe('UserGesture', () => {
  it('allows a clipboard read only shortly after a key press or click', () => {
    let now = 1_000_000;
    const gesture = new UserGesture(() => now);
    expect(gesture.recent()).toBe(false);
    gesture.note('rawKeyDown');
    expect(gesture.recent()).toBe(true);
    now += GESTURE_WINDOW_MS;
    expect(gesture.recent()).toBe(true);
    now += 1;
    expect(gesture.recent()).toBe(false);
    gesture.note('mouseDown');
    expect(gesture.recent()).toBe(true);
  });

  it('does not count movement, key releases or wheel as a gesture', () => {
    let now = 5_000;
    const gesture = new UserGesture(() => now);
    for (const type of ['mouseMove', 'keyUp', 'mouseWheel', 'mouseEnter', 'char', 'undefined']) {
      gesture.note(type);
    }
    expect(gesture.recent()).toBe(false);
    gesture.note('contextMenu');
    now += 10;
    expect(gesture.recent()).toBe(true);
  });
});
