/**
 * A small Markdown subset for release notes: headings, paragraphs, bullet
 * and numbered lists, fenced code, rules, **bold**, *italic*, `code` and
 * [links](https://…). The result is plain data rendered as React elements:
 * raw HTML in the text stays text, and only http(s) links become links.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; children: Inline[] };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

const MAX_DEPTH = 4;

/** Only absolute http(s) addresses; anything else stays text. */
export function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const CODE = /`([^`\n]+)`/y;
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/y;
const STRONG = /\*\*([^\n]+?)\*\*/y;
const EM = /\*([^*\s][^*\n]*?)\*|_([^_\s][^_\n]*?)_/y;
const BARE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/y;
/** Characters that may start markup; everything else is copied in runs. */
const SPECIAL = /[`[*_h]/g;

function at(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ kind: 'text', text: plain });
    plain = '';
  };
  const nest = depth < MAX_DEPTH;
  let i = 0;
  while (i < text.length) {
    let match: RegExpExecArray | null;
    if ((match = at(CODE, text, i))) {
      flush();
      out.push({ kind: 'code', text: match[1] as string });
    } else if (nest && (match = at(LINK, text, i))) {
      flush();
      const href = safeHref(match[2] as string);
      const children = parseInline(match[1] as string, depth + 1);
      if (href) out.push({ kind: 'link', href, children });
      else out.push(...children);
    } else if (nest && (match = at(STRONG, text, i))) {
      flush();
      out.push({ kind: 'strong', children: parseInline(match[1] as string, depth + 1) });
    } else if (nest && (match = at(EM, text, i))) {
      flush();
      out.push({ kind: 'em', children: parseInline((match[1] ?? match[2]) as string, depth + 1) });
    } else if ((match = at(BARE, text, i))) {
      flush();
      const href = safeHref(match[0]);
      if (href) out.push({ kind: 'link', href, children: [{ kind: 'text', text: match[0] }] });
      else plain += match[0];
    } else {
      // Copy up to the next character that could start markup.
      SPECIAL.lastIndex = i + 1;
      const next = SPECIAL.exec(text);
      const stop = next ? next.index : text.length;
      plain += text.slice(i, stop);
      i = stop;
      continue;
    }
    i += match[0].length;
  }
  flush();
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length)
      blocks.push({ kind: 'paragraph', children: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      blocks.push({
        kind: 'list',
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(item)),
      });
    }
    list = null;
  };
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n] as string;
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      n += 1;
      while (n < lines.length && !(lines[n] as string).trim().startsWith('```')) {
        code.push(lines[n] as string);
        n += 1;
      }
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(3, (heading[1] as string).length) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, children: parseInline(heading[2] as string) });
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const item = /^(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/.exec(trimmed);
    if (item) {
      flushParagraph();
      const ordered = item[2] !== undefined;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(item[3] as string);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // A continuation line of the last item.
      list.items[list.items.length - 1] += ` ${trimmed}`;
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return blocks;
}
