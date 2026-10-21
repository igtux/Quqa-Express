import { describe, expect, it } from 'vitest';
import { splitDestination } from '../hosts/hostModel.js';
import { reconnectDelayMs, sliceInput } from './input.js';
import { parseOsc52 } from './osc52.js';

const b64bytes = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const b64 = (text: string) => b64bytes(new TextEncoder().encode(text));

describe('parseOsc52', () => {
  it('decodes clipboard writes', () => {
    expect(parseOsc52(`c;${b64('hello')}`)).toEqual({ kind: 'write', text: 'hello' });
    expect(parseOsc52(`;${b64('ქართული')}`)).toEqual({ kind: 'write', text: 'ქართული' });
  });

  it('recognises (and so can deny) clipboard reads', () => {
    expect(parseOsc52('c;?')).toEqual({ kind: 'read' });
  });

  it('ignores malformed requests', () => {
    expect(parseOsc52('c')).toEqual({ kind: 'invalid' });
    expect(parseOsc52('c;')).toEqual({ kind: 'invalid' });
    expect(parseOsc52('c;not base64!')).toEqual({ kind: 'invalid' });
    expect(parseOsc52('x;aGk=')).toEqual({ kind: 'invalid' });
    expect(parseOsc52(`c;${b64bytes(new Uint8Array([0xff, 0xfe]))}`)).toEqual({
      kind: 'invalid',
    });
  });
});

describe('sliceInput', () => {
  it('slices long text and keeps it intact', () => {
    const text = 'x'.repeat(10_000);
    const slices = sliceInput(text, 4096);
    expect(slices.map((s) => s.length)).toEqual([4096, 4096, 1808]);
    expect(slices.join('')).toBe(text);
  });

  it('never splits a surrogate pair', () => {
    const text = 'a'.repeat(4095) + '😀' + 'b';
    const slices = sliceInput(text, 4096);
    expect(slices[0]).toBe('a'.repeat(4095));
    expect(slices[1]).toBe('😀b');
  });
});

describe('reconnectDelayMs', () => {
  it('backs off 1, 2, 4, 8, 16, 30 s with jitter, then stops', () => {
    expect(reconnectDelayMs(0, () => 0.5)).toBe(1000);
    expect(reconnectDelayMs(5, () => 0.5)).toBe(30_000);
    expect(reconnectDelayMs(1, () => 0)).toBe(1600);
    expect(reconnectDelayMs(1, () => 1)).toBe(2400);
    expect(reconnectDelayMs(6)).toBeNull();
  });
});

describe('splitDestination', () => {
  it('reads user@host:port', () => {
    expect(splitDestination('root@10.0.0.5:2222')).toEqual({
      host: '10.0.0.5',
      username: 'root',
      port: 2222,
    });
    expect(splitDestination(' example.com ')).toEqual({ host: 'example.com' });
    expect(splitDestination('me@[::1]:22')).toEqual({ host: '::1', username: 'me', port: 22 });
    expect(splitDestination('two words')).toEqual({});
  });
});
