/**
 * The renderer's Content-Security-Policy. A build gets the strict policy: only
 * the app's own files, no remote content, no eval, no inline scripts. The dev
 * server additionally needs React Refresh's inline preamble and Vite's HMR
 * socket on localhost. Used by the Vite build (meta tag) and by main's
 * `app://` handler (response header).
 */
export function contentSecurityPolicy(dev: boolean): string {
  return [
    "default-src 'none'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    // xterm.js writes <style> elements for its renderer.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    dev ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ');
}
