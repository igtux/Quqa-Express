/**
 * The app theme ("Liquid glass", the default, or "Classic"), kept by main in
 * settings.json so it applies before the vault opens. CSS keys off
 * `<html data-theme>`; `data-material` says the window shows the OS's own
 * translucent material (Windows 11 acrylic) behind the page.
 */
import type { AppSettings, AppTheme } from '../../shared/ipc.js';
import { call } from './api.js';

export function applyAppTheme(settings: Pick<AppSettings, 'theme' | 'material'>): void {
  const root = document.documentElement;
  root.dataset['theme'] = settings.theme;
  if (settings.material) root.dataset['material'] = 'on';
  else delete root.dataset['material'];
}

export function currentAppTheme(): AppTheme {
  return document.documentElement.dataset['theme'] === 'classic' ? 'classic' : 'glass';
}

export async function loadAppTheme(): Promise<void> {
  try {
    applyAppTheme(await call('app.settings', {}));
  } catch {
    // The default look.
  }
}

export async function setAppTheme(theme: AppTheme): Promise<void> {
  applyAppTheme(await call('app.setSettings', { theme }));
}
