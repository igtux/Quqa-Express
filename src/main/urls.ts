/** URL rules for the renderer (kept free of Electron imports so tests can load it). */

/** Where the renderer's own files come from: file:// in a build, the dev server in `pnpm dev`. */
export function isAppUrl(url: string, devServerUrl: string | undefined): boolean {
  if (devServerUrl) {
    try {
      const dev = new URL(devServerUrl);
      const target = new URL(url);
      if ((target.protocol === 'http:' || target.protocol === 'ws:') && target.host === dev.host) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return url.startsWith('file://') || url.startsWith('devtools://') || url.startsWith('data:');
}
