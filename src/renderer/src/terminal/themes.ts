/**
 * Terminal look: the fixed ANSI palette, colour scheme, font stack and the
 * font-size ladder with zoom.
 *
 * Ported from Jarvis NG (apps/web/src/terminal/themes.ts), same owner. Phase 1
 * ships the default scheme only; the scheme list and font picker come later.
 */
import type { ITheme } from '@xterm/xterm';

export interface Scheme {
  id: string;
  name: string;
  bg: string;
  fg: string;
  cursor: string;
}

export const DEFAULT_SCHEME: Scheme = {
  id: 'default',
  name: 'Default Dark',
  bg: '#0d0d0d',
  fg: '#e0e0e0',
  cursor: '#22c55e',
};

export const FONT_FAMILY =
  '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace';

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

const ZOOM_KEY = 'quqa.terminal.zoom';

export function readZoom(): number {
  try {
    const value = Number(localStorage.getItem(ZOOM_KEY) ?? 0);
    return Number.isFinite(value) ? clampZoom(value) : 0;
  } catch {
    return 0;
  }
}

export function saveZoom(zoom: number): void {
  try {
    localStorage.setItem(ZOOM_KEY, String(zoom));
  } catch {
    // Not remembered.
  }
}
