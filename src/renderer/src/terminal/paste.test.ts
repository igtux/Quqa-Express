import { describe, expect, it } from 'vitest';
import { LARGE_PASTE, lineCount, pasteRisks, visiblePaste } from './paste.js';

describe('pasteRisks', () => {
  it('lets a plain single line through', () => {
    expect(pasteRisks('ls -la /tmp', false)).toEqual([]);
    expect(pasteRisks('tab\tseparated', false)).toEqual([]);
    expect(pasteRisks('ünïcødé ქართული', false)).toEqual([]);
  });

  it('warns about line endings outside bracketed paste only', () => {
    expect(pasteRisks('ls\nrm -rf ~', false)).toEqual(['multiline']);
    expect(pasteRisks('whoami\r', false)).toEqual(['multiline']);
    expect(pasteRisks('ls\nrm -rf ~', true)).toEqual([]);
  });

  it('always warns about control characters, even in bracketed paste', () => {
    // ESC [ 201 ~ would end bracketed paste early and run the rest.
    expect(pasteRisks('echo hi\x1b[201~\nrm -rf ~\n', true)).toEqual(['control']);
    expect(pasteRisks('a\x03b', false)).toEqual(['control']);
    expect(pasteRisks('a\x00b', false)).toEqual(['control']);
    expect(pasteRisks('a\x7fb', false)).toEqual(['control']);
    expect(pasteRisks('a\u009bb', false)).toEqual(['control']);
    expect(pasteRisks('evil‮txt.exe', false)).toEqual(['control']);
  });

  it('warns about very large pastes', () => {
    expect(pasteRisks('x'.repeat(LARGE_PASTE + 1), true)).toEqual(['large']);
    expect(pasteRisks(`${'x'.repeat(LARGE_PASTE)}\n\x1b`, false)).toEqual([
      'multiline',
      'control',
      'large',
    ]);
  });
});

describe('visiblePaste', () => {
  it('makes control characters visible', () => {
    expect(visiblePaste('a\x1b[201~b\x03‮')).toBe('a⟨ESC⟩[201~b⟨^C⟩⟨U+202E⟩');
    expect(visiblePaste('one\r\ntwo')).toBe('one\ntwo');
    expect(visiblePaste('one\rtwo')).toBe('one\ntwo');
    expect(visiblePaste('x'.repeat(10), 4)).toBe('xxxx…');
  });

  it('counts lines', () => {
    expect(lineCount('a')).toBe(1);
    expect(lineCount('a\r\nb\nc\rd')).toBe(4);
  });
});
