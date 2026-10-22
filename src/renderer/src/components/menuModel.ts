/**
 * What a menu holds, and the keyboard rules shared by every menu in the app
 * (the main menu, the local shells menu, the tab, host and session menus).
 */
import type { MenuIconName } from './menuIcons.js';

/** Icon chip colours: one per kind of action, so a menu reads at a glance. */
export type MenuTone = 'blue' | 'violet' | 'green' | 'amber' | 'pink' | 'teal' | 'slate' | 'red';

export interface MenuItem {
  kind?: 'item';
  /** Accessible name and the text shown. */
  label: string;
  icon: MenuIconName;
  tone?: MenuTone;
  /** A keyboard shortcut, shown at the right (e.g. "Ctrl+Shift+D"). */
  shortcut?: string;
  /** A short second line in plain words. */
  hint?: string;
  /** A small badge after the label ("default", "new"). */
  badge?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect(): void;
}

export interface MenuHeading {
  kind: 'heading';
  label: string;
}

export interface MenuSeparator {
  kind: 'separator';
}

export type MenuEntry = MenuItem | MenuHeading | MenuSeparator;

export function isItem(entry: MenuEntry): entry is MenuItem {
  return entry.kind === undefined || entry.kind === 'item';
}

/**
 * Drops `false`/`null` entries (conditional items), separators at either end
 * and doubled separators, and headings with no item under them.
 */
export function tidy(entries: readonly (MenuEntry | false | null | undefined)[]): MenuEntry[] {
  const list = entries.filter((e): e is MenuEntry => Boolean(e));
  const out: MenuEntry[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as MenuEntry;
    if (entry.kind === 'separator') {
      const last = out[out.length - 1];
      if (!last || last.kind === 'separator' || last.kind === 'heading') continue;
    }
    if (entry.kind === 'heading') {
      const next = list[i + 1];
      if (!next || !isItem(next)) continue;
    }
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1]?.kind === 'separator') out.pop();
  return out;
}

/**
 * The item focus moves to for a key, among `enabled` (one flag per item), or
 * null when the key is not a menu key. Wraps around; skips disabled items.
 */
export function moveFocus(
  key: string,
  current: number,
  enabled: readonly boolean[],
): number | null {
  const count = enabled.length;
  if (count === 0 || !enabled.some(Boolean)) return null;
  const first = enabled.indexOf(true);
  const last = enabled.lastIndexOf(true);
  const step = (from: number, by: 1 | -1) => {
    let i = from;
    for (let n = 0; n < count; n++) {
      i = (i + by + count) % count;
      if (enabled[i]) return i;
    }
    return from;
  };
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? first : step(current, 1);
    case 'ArrowUp':
      return current < 0 ? last : step(current, -1);
    case 'Home':
    case 'PageUp':
      return first;
    case 'End':
    case 'PageDown':
      return last;
    default:
      return null;
  }
}

/** Keeps a menu of `size` inside the window, 8px from its edges. */
export function placeMenu(
  at: { x: number; y: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const margin = 8;
  const left = Math.max(margin, Math.min(at.x, view.width - size.width - margin));
  // Not enough room below: open above the point instead.
  const below = at.y + size.height + margin <= view.height;
  const top = below ? at.y : Math.max(margin, Math.min(at.y, view.height) - size.height);
  return { left, top: Math.max(margin, Math.min(top, view.height - size.height - margin)) };
}
