/**
 * Window size, position and maximized state, kept in `window-state.json` in
 * the profile folder. A saved position is used only if most of the window
 * would still be on one of the current displays (a monitor may be gone).
 * Kept free of Electron imports so tests can load it.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: Bounds;
  maximized: boolean;
}

export const DEFAULT_SIZE = { width: 1100, height: 720 };
export const MIN_SIZE = { width: 480, height: 320 };
const MAX_SIDE = 100_000;

const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** The saved state if the file holds a sane one, else null. */
export function parseWindowState(text: string): WindowState | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { bounds, maximized } = value as { bounds?: Partial<Bounds>; maximized?: unknown };
  if (typeof bounds !== 'object' || bounds === null || typeof maximized !== 'boolean') return null;
  const { x, y, width, height } = bounds;
  if (
    !isInt(x, -MAX_SIDE, MAX_SIDE) ||
    !isInt(y, -MAX_SIDE, MAX_SIDE) ||
    !isInt(width, MIN_SIZE.width, MAX_SIDE) ||
    !isInt(height, MIN_SIZE.height, MAX_SIDE)
  ) {
    return null;
  }
  return { bounds: { x, y, width, height }, maximized };
}

function overlap(a: Bounds, b: Bounds): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where to open the window: the saved bounds when at least half of the
 * window is on one display's work area (shrunk to fit it), else only the
 * saved size, centred by Electron.
 */
export function placeWindow(
  saved: WindowState | null,
  workAreas: Bounds[],
): { bounds: Partial<Bounds> & { width: number; height: number }; maximized: boolean } {
  if (!saved) return { bounds: { ...DEFAULT_SIZE }, maximized: false };
  const { bounds } = saved;
  const area = workAreas.find((a) => overlap(bounds, a) >= (bounds.width * bounds.height) / 2);
  if (!area) {
    const largest = workAreas[0];
    return {
      bounds: {
        width: largest ? Math.min(bounds.width, largest.width) : bounds.width,
        height: largest ? Math.min(bounds.height, largest.height) : bounds.height,
      },
      maximized: saved.maximized,
    };
  }
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { bounds: { x, y, width, height }, maximized: saved.maximized };
}

export function readWindowState(path: string): WindowState | null {
  try {
    return parseWindowState(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeWindowState(path: string, state: WindowState): void {
  try {
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // Not worth bothering the user about.
  }
}
