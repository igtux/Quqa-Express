/**
 * The server's host key differs from the pinned one: a hard block over the
 * terminal. Replacing the pin takes two deliberate steps; the engine pins the
 * key it saw, never key material from here.
 *
 * Wording follows Jarvis NG's "SSH host key changed" dialog
 * (apps/web/src/machines/HostKeyTrust.tsx, legacy-ui 01b §10.4), same owner.
 */
import { useState } from 'react';
import type { HostKeyChange } from '../terminal/connection.js';
import { Icon } from './icons.js';

export function HostKeyChangedScreen({
  change,
  onReplace,
  onClose,
}: {
  change: HostKeyChange;
  /** Resolves with an error message, or null when the pin was replaced. */
  onReplace(): Promise<string | null>;
  onClose(): void;
}) {
  const [step, setStep] = useState<'blocked' | 'confirm'>('blocked');
  const [verified, setVerified] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const where = change.port === 22 ? change.host : `${change.host}:${change.port}`;

  return (
    <div className="host-key-changed" role="alertdialog" aria-labelledby="hkc-title">
      <div className="host-key-changed-card">
        <div className="terminal-decision-heading">
          <span className="terminal-decision-icon danger">
            <Icon name="warning" />
          </span>
          <h3 id="hkc-title">SSH host key changed</h3>
        </div>
        <div className="terminal-decision-host">{where}</div>
        <p className="terminal-decision-note">
          The server presented a different host key than the one you trusted. Someone may be
          intercepting the connection, or the server was reinstalled. The connection was refused and
          nothing was sent.
        </p>
        <div className="hkc-label">Trusted before</div>
        {change.previous.map((key) => (
          <div
            className="terminal-decision-fingerprint old"
            key={key.fingerprint}
            data-testid="previous-fingerprint"
          >
            <span className="algorithm">{key.algorithm}</span>
            {key.fingerprint}
          </div>
        ))}
        <div className="hkc-label">Presented now</div>
        <div className="terminal-decision-fingerprint" data-testid="new-fingerprint">
          <span className="algorithm">{change.algorithm}</span>
          {change.fingerprint}
        </div>
        {step === 'confirm' && (
          <label className="system-check">
            <input
              type="checkbox"
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
            />
            I checked the new fingerprint with the server&apos;s administrator (
            <code>ssh-keygen -lf</code> on the server)
          </label>
        )}
        {problem && (
          <p className="system-error" role="alert">
            {problem}
          </p>
        )}
        <div className="terminal-decision-actions">
          <button type="button" className="terminal-decision-btn primary" onClick={onClose}>
            Close
          </button>
          {step === 'blocked' ? (
            <button
              type="button"
              className="terminal-decision-btn danger"
              onClick={() => setStep('confirm')}
            >
              Replace pin…
            </button>
          ) : (
            <button
              type="button"
              className="terminal-decision-btn danger"
              disabled={!verified}
              onClick={() => void onReplace().then(setProblem)}
            >
              Replace pin and connect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
