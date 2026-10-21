import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeHref } from './markdownParse.js';

describe('release-notes Markdown', () => {
  it('parses headings, lists, code and paragraphs', () => {
    const blocks = parseMarkdown(
      "## What's new\n\n- **Georgian** text\n- `code` and *more*\n  continued\n\n1. one\n2. two\n\n```\nx < y\n```\n\nPlain\ntext\n\n---",
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'list',
      'list',
      'code',
      'paragraph',
      'rule',
    ]);
    expect(blocks[1]).toEqual({
      kind: 'list',
      ordered: false,
      items: [
        [
          { kind: 'strong', children: [{ kind: 'text', text: 'Georgian' }] },
          { kind: 'text', text: ' text' },
        ],
        [
          { kind: 'code', text: 'code' },
          { kind: 'text', text: ' and ' },
          { kind: 'em', children: [{ kind: 'text', text: 'more' }] },
          { kind: 'text', text: ' continued' },
        ],
      ],
    });
    expect(blocks[3]).toEqual({ kind: 'code', text: 'x < y' });
    expect(blocks[4]).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: 'Plain text' }],
    });
  });

  it('keeps raw HTML as text and links only http(s)', () => {
    const inline = parseInline(
      '<img src=x onerror=alert(1)> [ok](https://github.com/igtux) [bad](javascript:alert(1)) [file](file:///etc/passwd)',
    );
    expect(inline[0]).toEqual({ kind: 'text', text: '<img src=x onerror=alert(1)> ' });
    expect(inline).toContainEqual({
      kind: 'link',
      href: 'https://github.com/igtux',
      children: [{ kind: 'text', text: 'ok' }],
    });
    expect(inline.filter((i) => i.kind === 'link')).toHaveLength(1);
    expect(JSON.stringify(inline)).not.toContain('"href":"javascript');
  });

  it('turns bare addresses into links without trailing punctuation', () => {
    expect(parseInline('See https://example.com/a.')).toEqual([
      { kind: 'text', text: 'See ' },
      {
        kind: 'link',
        href: 'https://example.com/a',
        children: [{ kind: 'text', text: 'https://example.com/a' }],
      },
      { kind: 'text', text: '.' },
    ]);
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('/relative')).toBeNull();
  });

  it('survives deep nesting and long input', () => {
    expect(() => parseMarkdown('**'.repeat(5000) + '[x]('.repeat(2000))).not.toThrow();
  });
});
