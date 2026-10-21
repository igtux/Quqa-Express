/**
 * Process-wide hardening: no navigation, no new windows, no webviews, no
 * permissions, and no network access from the renderer except the bundled
 * page itself (and the Vite dev server while developing).
 */
import { app, session, type WebContents } from 'electron';
import { isAppUrl } from './urls.js';

export function hardenSessions(devServerUrl: string | undefined): void {
  const ses = session.defaultSession;
  // A terminal needs no camera, notifications, geolocation, clipboard-read…
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // No remote content: the only network traffic is SSH, from the engine process.
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAppUrl(details.url, devServerUrl) });
  });

  app.on('web-contents-created', (_event, contents) => lockDown(contents));
}

function lockDown(contents: WebContents) {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
