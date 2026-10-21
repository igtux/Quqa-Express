/** Trusted host keys (pins): list, forget, import from known_hosts. */
import { useState } from 'react';
import type { PinInfo } from '../../../shared/ipc.js';
import { call, messageOf } from '../api.js';
import { ConfirmDialog } from './KeysPanel.js';

export function HostKeysPanel({
  pins,
  hashed,
  onChange,
}: {
  pins: PinInfo[];
  hashed: number;
  onChange(): void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<PinInfo | null>(null);

  const importKnownHosts = async (chooseFile: boolean) => {
    setProblem(null);
    setNotice(null);
    try {
      const summary = await call('hostKeys.importKnownHosts', { chooseFile });
      if (!summary.found) {
        setNotice(chooseFile ? null : 'No known_hosts file found in your .ssh folder');
      } else {
        setNotice(
          `Imported ${summary.imported} host keys and ${summary.hashed} hashed entries; ` +
            `${summary.skipped} skipped (already trusted, wildcards, markers or unreadable)`,
        );
      }
      onChange();
    } catch (error) {
      setProblem(messageOf(error));
    }
  };

  const where = (pin: PinInfo) => (pin.port === 22 ? pin.host : `[${pin.host}]:${pin.port}`);

  return (
    <section className="panel" aria-label="Host keys">
      <div className="panel-row">
        <button
          type="button"
          className="system-btn inline"
          onClick={() => void importKnownHosts(false)}
        >
          Import ~/.ssh/known_hosts
        </button>
        <button
          type="button"
          className="system-btn inline"
          onClick={() => void importKnownHosts(true)}
        >
          Import from file…
        </button>
      </div>
      {problem && (
        <p className="system-error" role="alert">
          {problem}
        </p>
      )}
      {notice && (
        <p className="system-hint" role="status">
          {notice}
        </p>
      )}
      {pins.length === 0 && hashed === 0 ? (
        <p className="panel-empty">
          No trusted hosts yet. A host is added when you accept its key on first connection.
        </p>
      ) : (
        <ul className="item-list" aria-label="Trusted hosts">
          {pins.map((pin) => (
            <li key={`${pin.host}:${pin.port}:${pin.fingerprint}`} className="item">
              <div className="item-main">
                <div className="item-title">
                  {where(pin)}
                  <span className="item-badge">{pin.algorithm}</span>
                  {pin.source === 'known_hosts' && <span className="item-badge">known_hosts</span>}
                </div>
                <div className="item-mono">{pin.fingerprint}</div>
              </div>
              <div className="item-actions">
                <button
                  type="button"
                  className="link-btn danger"
                  onClick={() => setForgetting(pin)}
                >
                  Forget
                </button>
              </div>
            </li>
          ))}
          {hashed > 0 && (
            <li className="item">
              <div className="item-main">
                <div className="item-title">{hashed} hashed known_hosts entries</div>
                <div className="item-meta">
                  Host names are hashed, so they are matched when you connect.
                </div>
              </div>
            </li>
          )}
        </ul>
      )}
      {forgetting && (
        <ConfirmDialog
          title={`Forget ${where(forgetting)}?`}
          note="Every trusted key for this host is removed; the next connection asks again."
          confirm="Forget host"
          onAnswer={(yes) => {
            const pin = forgetting;
            setForgetting(null);
            if (!yes) return;
            void call('hostKeys.forget', { host: pin.host, port: pin.port })
              .then(onChange)
              .catch((error: unknown) => setProblem(messageOf(error)));
          }}
        />
      )}
    </section>
  );
}
