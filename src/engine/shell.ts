/**
 * Safe construction of POSIX shell commands for SSH exec.
 *
 *   sh`tmux kill-session -t ${target}`
 *
 * Every interpolated value is single-quoted, so it is always one literal word
 * whatever it contains; arrays become several quoted words. Constant text
 * between the placeholders is the developer's. This is the one helper the
 * engine uses for remote commands (AGENTS.md rule 7).
 *
 * Ported from Jarvis NG (packages/shell/src/index.ts), same owner.
 */

/** A piece of shell script whose text is safe to execute as written. */
export class ShellScript {
  constructor(readonly text: string) {}

  toString(): string {
    return this.text;
  }
}

export type ShellValue = string | number | ShellScript | readonly ShellValue[];

export function sh(strings: TemplateStringsArray, ...values: ShellValue[]): ShellScript {
  let text = strings[0] ?? '';
  values.forEach((value, index) => {
    text += render(value) + (strings[index + 1] ?? '');
  });
  return new ShellScript(text);
}

/** One shell word for any string: `it's` → `'it'"'"'s'`. */
export function quote(value: string): string {
  if (value.includes('\0')) throw new Error('Shell values cannot contain NUL bytes');
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function render(value: ShellValue): string {
  if (value instanceof ShellScript) return value.text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Shell numbers must be finite');
    return String(value);
  }
  if (typeof value === 'string') return quote(value);
  return value.map(render).join(' ');
}
