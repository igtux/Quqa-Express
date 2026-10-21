/** Window titles programs set (OSC 0/2), as tab labels. */
// eslint-disable-next-line no-control-regex
const TITLE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** A program's window title as a short label: printable, a program path shortened to its name. */
export function printableTitle(title: string): string {
  const clean = title.replace(TITLE_CONTROL, '').trim();
  // PowerShell and cmd title the window with the program's path.
  const program = /^(?:[A-Za-z]:)?[\\/].*[\\/]([^\\/]+?)(?:\.exe)?$/i.exec(clean);
  const text = program?.[1] ?? clean;
  return text.slice(0, 80);
}
