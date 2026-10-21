/** About quqa-express: version, updates, licence, source and where it comes from. */
import { updates, useUpdates } from '../updates.js';
import { Dialog } from './Dialog.js';
import { AppLogo } from './icons.js';
import { UpdatePanel } from './UpdatePanel.js';
import { useState } from 'react';

export const REPOSITORY_URL = 'https://github.com/igtux/Quqa-Express';

function UpdateSettings() {
  const state = useUpdates();
  const [panel, setPanel] = useState(false);
  if (!state) return null;
  const status = state.checking
    ? 'Checking…'
    : state.error
      ? state.error
      : state.available
        ? `Version ${state.available.version} is available.`
        : state.checkedAt
          ? 'You have the latest version.'
          : '';
  return (
    <div className="about-updates">
      <label className="system-check">
        <input
          type="checkbox"
          checked={state.autoUpdate}
          onChange={(e) => void updates.setAuto(e.target.checked).catch(() => undefined)}
        />
        <span>
          Check for updates automatically
          <span className="system-hint block">
            At start and every 6 hours, from GitHub Releases. The only connection besides SSH.
          </span>
        </span>
      </label>
      <div className="about-update-row">
        <button
          type="button"
          className="system-btn ghost inline small"
          disabled={state.checking}
          onClick={() => void updates.check().catch(() => undefined)}
        >
          Check now
        </button>
        {state.available && (
          <button
            type="button"
            className="system-btn primary inline small"
            onClick={() => setPanel(true)}
          >
            See what&apos;s new
          </button>
        )}
        <span className="system-hint" role="status" data-testid="update-status">
          {status}
        </span>
      </div>
      {panel && <UpdatePanel onClose={() => setPanel(false)} />}
    </div>
  );
}

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
      <UpdateSettings />
      <p className="system-hint">
        A fast, private SSH terminal for the desktop. No accounts, no telemetry: besides the update
        check above, the only network connections are the SSH sessions and tunnels you open.
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
