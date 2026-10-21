/**
 * Terminal look: the fixed ANSI palette, the 20 colour schemes, the 12 font
 * stacks (each led by BPG Courier so Georgian fills one cell when that font
 * is installed), the font-size ladder and zoom.
 *
 * Ported from Jarvis NG (apps/web/src/terminal/themes.ts), same owner. Jarvis
 * bundles the web fonts; quqa-express is offline and does not fetch fonts, so
 * a stack falls back to the next installed font. The choices are saved in the
 * vault with the rest of the UI state, not in renderer storage.
 */
import type { ITheme } from '@xterm/xterm';

export interface Scheme {
  id: string;
  name: string;
  bg: string;
  fg: string;
  cursor: string;
}

export const SCHEMES: Scheme[] = [
  { id: 'default', name: 'Default Dark', bg: '#0d0d0d', fg: '#e0e0e0', cursor: '#22c55e' },
  { id: 'dracula', name: 'Dracula', bg: '#282a36', fg: '#f8f8f2', cursor: '#ff79c6' },
  { id: 'nord', name: 'Nord', bg: '#2e3440', fg: '#d8dee9', cursor: '#88c0d0' },
  { id: 'monokai', name: 'Monokai', bg: '#272822', fg: '#f8f8f2', cursor: '#f92672' },
  { id: 'gruvbox', name: 'Gruvbox Dark', bg: '#282828', fg: '#ebdbb2', cursor: '#fe8019' },
  { id: 'one-dark', name: 'One Dark', bg: '#282c34', fg: '#abb2bf', cursor: '#528bff' },
  { id: 'tokyo-night', name: 'Tokyo Night', bg: '#1a1b26', fg: '#a9b1d6', cursor: '#7aa2f7' },
  { id: 'catppuccin', name: 'Catppuccin Mocha', bg: '#1e1e2e', fg: '#cdd6f4', cursor: '#f5c2e7' },
  { id: 'ayu-dark', name: 'Ayu Dark', bg: '#0a0e14', fg: '#b3b1ad', cursor: '#ffb454' },
  { id: 'night-owl', name: 'Night Owl', bg: '#011627', fg: '#d6deeb', cursor: '#80a4c2' },
  { id: 'material', name: 'Material Dark', bg: '#212121', fg: '#eeffff', cursor: '#ffcc00' },
  { id: 'synthwave', name: 'Synthwave 84', bg: '#2b213a', fg: '#f4eee4', cursor: '#ff7edb' },
  { id: 'cobalt2', name: 'Cobalt2', bg: '#193549', fg: '#ffffff', cursor: '#ffc600' },
  { id: 'horizon', name: 'Horizon', bg: '#1c1e26', fg: '#e0e0e0', cursor: '#e95678' },
  { id: 'palenight', name: 'Palenight', bg: '#292d3e', fg: '#a6accd', cursor: '#ffcb6b' },
  { id: 'everforest', name: 'Everforest', bg: '#2d353b', fg: '#d3c6aa', cursor: '#a7c080' },
  { id: 'kanagawa', name: 'Kanagawa', bg: '#1f1f28', fg: '#dcd7ba', cursor: '#c8c093' },
  { id: 'rose-pine', name: 'Rosé Pine', bg: '#191724', fg: '#e0def4', cursor: '#eb6f92' },
  { id: 'solarized-dark', name: 'Solarized Dark', bg: '#002b36', fg: '#839496', cursor: '#93a1a1' },
  { id: 'github-dark', name: 'GitHub Dark', bg: '#0d1117', fg: '#c9d1d9', cursor: '#58a6ff' },
];

export interface FontChoice {
  id: string;
  name: string;
  /** The stack after "BPG Courier". */
  stack: string;
}

export const FONTS: FontChoice[] = [
  {
    id: 'system',
    name: 'System Default',
    stack:
      '"Cascadia Mono", Consolas, ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace',
  },
  { id: 'menlo', name: 'Menlo / Monaco', stack: 'Menlo, Monaco, "Courier New", monospace' },
  { id: 'consolas', name: 'Consolas', stack: 'Consolas, "Courier New", monospace' },
  { id: 'jetbrains', name: 'JetBrains Mono', stack: '"JetBrains Mono", Consolas, monospace' },
  { id: 'fira', name: 'Fira Code', stack: '"Fira Code", Consolas, monospace' },
  { id: 'source-code', name: 'Source Code Pro', stack: '"Source Code Pro", Consolas, monospace' },
  { id: 'roboto', name: 'Roboto Mono', stack: '"Roboto Mono", Consolas, monospace' },
  { id: 'ubuntu', name: 'Ubuntu Mono', stack: '"Ubuntu Mono", Consolas, monospace' },
  { id: 'ibm-plex', name: 'IBM Plex Mono', stack: '"IBM Plex Mono", Consolas, monospace' },
  { id: 'hack', name: 'Hack', stack: 'Hack, Consolas, monospace' },
  { id: 'inconsolata', name: 'Inconsolata', stack: 'Inconsolata, Consolas, monospace' },
  { id: 'cascadia', name: 'Cascadia Code', stack: '"Cascadia Code", Consolas, monospace' },
];

export const DEFAULT_SCHEME = SCHEMES[0] as Scheme;
const DEFAULT_FONT = FONTS[0] as FontChoice;

export function schemeById(id: string): Scheme {
  return SCHEMES.find((s) => s.id === id) ?? DEFAULT_SCHEME;
}

export function fontById(id: string): FontChoice {
  return FONTS.find((f) => f.id === id) ?? DEFAULT_FONT;
}

export function fontFamily(font: FontChoice): string {
  return `"BPG Courier", ${font.stack}`;
}

/** The fixed 16-colour palette; schemes only change bg/fg/cursor. */
const ANSI = {
  black: '#1a1a1a',
  red: '#ef4444',
  green: '#3DF5A5',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e0e0e0',
  brightBlack: '#8a9d94',
  brightRed: '#f87171',
  brightGreen: '#6df7bd',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
};

export function xtermTheme(scheme: Scheme = DEFAULT_SCHEME): ITheme {
  return {
    background: scheme.bg,
    foreground: scheme.fg,
    cursor: scheme.cursor,
    cursorAccent: scheme.bg,
    selectionBackground: 'rgba(99, 102, 241, 0.3)',
    scrollbarSliderBackground: '#3a3a3a',
    scrollbarSliderHoverBackground: '#4a4a4a',
    scrollbarSliderActiveBackground: '#4a4a4a',
    ...ANSI,
  };
}

export const ZOOM_MIN = -6;
export const ZOOM_MAX = 10;
export const ZOOM_STEP = 1;

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom)));
}

/** Base size by window width, then zoom, clamped to 6–24 px. */
export function computeFontSize(zoom: number, width: number): number {
  const base = width <= 320 ? 10 : width <= 375 ? 11 : width <= 430 ? 12 : width <= 768 ? 13 : 14;
  return Math.min(24, Math.max(6, base + zoom));
}

export function lineHeight(width: number): number {
  return width <= 768 ? 1.1 : 1.2;
}
