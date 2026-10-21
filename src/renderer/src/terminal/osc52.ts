/**
 * OSC 52 (a program sets the clipboard). Write-only: read requests are
 * denied, so a remote program can never see what the user copied.
 */
export const MAX_OSC52_TEXT = 1024 * 1024;

export type Osc52Request = { kind: 'write'; text: string } | { kind: 'read' } | { kind: 'invalid' };

/** Parses the OSC 52 payload `Pc;Pd` (selection targets; base64 data or `?`). */
export function parseOsc52(data: string): Osc52Request {
  const separator = data.indexOf(';');
  if (separator < 0) return { kind: 'invalid' };
  const targets = data.slice(0, separator);
  const payload = data.slice(separator + 1);
  if (!/^[cpqs0-7]*$/.test(targets)) return { kind: 'invalid' };
  if (payload === '?') return { kind: 'read' };
  // An empty payload clears the clipboard in some terminals; we ignore it.
  if (!payload || payload.length > (MAX_OSC52_TEXT * 4) / 3 + 4) return { kind: 'invalid' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return { kind: 'invalid' };
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text ? { kind: 'write', text } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}
