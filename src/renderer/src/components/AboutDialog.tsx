/** About quqa-express: version, licence, source and where it comes from. */
import { Dialog } from './Dialog.js';
import { AppLogo } from './icons.js';

export const REPOSITORY_URL = 'https://github.com/igtux/Quqa-Express';

export function AboutDialog({ onClose }: { onClose(): void }) {
  return (
    <Dialog title="About quqa-express" onClose={onClose} cancelLabel="Close">
      <div className="about">
        <AppLogo size={56} />
        <div>
          <p className="about-name">quqa-express</p>
          <p className="system-hint" data-testid="app-version">
            Version {__APP_VERSION__}
          </p>
        </div>
      </div>
      <p className="system-hint">
        A fast, private SSH terminal for the desktop. No accounts, no telemetry: the only network
        connections are the SSH sessions and tunnels you open.
      </p>
      <dl className="about-facts">
        <dt>Licence</dt>
        <dd>Apache License 2.0</dd>
        <dt>Source</dt>
        <dd>
          <button
            type="button"
            className="link-btn"
            onClick={() => window.quqa.openExternal(REPOSITORY_URL)}
          >
            github.com/igtux/Quqa-Express
          </button>
        </dd>
        <dt>Origin</dt>
        <dd>Its terminal is ported from Jarvis NG, AURA&apos;s web platform.</dd>
      </dl>
      <p className="system-hint">
        Built with Electron, React, xterm.js and ssh2. This build is not code-signed; check
        downloads against SHA256SUMS.txt from the same release.
      </p>
    </Dialog>
  );
}
