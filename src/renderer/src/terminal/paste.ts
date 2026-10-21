/**
 * Paste warnings (ADR 0001 §7): a paste is shown to the user before it is
 * sent when it would run commands at once (more than one line, or a line
 * ending, outside bracketed paste), when it holds control characters (ESC
 * can end bracketed paste early or drive the terminal; ^C, ^D and friends act
 * at once), or when it is very large.
 */
export type PasteRisk = 'multiline' | 'control' | 'large';

/** Above this many characters a paste asks first. */
export const LARGE_PASTE = 64 * 1024;

/** C0 controls except tab, line feed and carriage return; DEL; C1 controls; bidi overrides. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export function pasteRisks(text: string, bracketedPaste: boolean): PasteRisk[] {
  const risks: PasteRisk[] = [];
  if (!bracketedPaste && /[\r\n]/.test(text)) risks.push('multiline');
  if (CONTROL.test(text)) risks.push('control');
  if (text.length > LARGE_PASTE) risks.push('large');
  return risks;
}

const NAMES: Record<number, string> = {
  0x00: 'NUL',
  0x03: '^C',
  0x04: '^D',
  0x07: 'BEL',
  0x08: 'BS',
  0x1a: '^Z',
  0x1b: 'ESC',
  0x7f: 'DEL',
};

/** The paste with control characters made visible, for the warning's preview. */
export function visiblePaste(text: string, max = 2000): string {
  const shown = text.length > max ? text.slice(0, max) : text;
  let out = '';
  for (const char of shown) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\n' || char === '\t') out += char;
    else if (char === '\r') out += shown.includes('\n') ? '' : '\n';
    else if (CONTROL.test(char)) {
      out += `⟨${NAMES[code] ?? `U+${code.toString(16).toUpperCase().padStart(4, '0')}`}⟩`;
    } else out += char;
  }
  return text.length > max ? `${out}…` : out;
}

export function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}
