/**
 * First connection to a host: show its key fingerprint and require Accept.
 * Modelled on Jarvis NG's terminal decision dialog (apps/web/src/terminal/HostKeyDialog.tsx).
 */
import type { HostKeyPrompt } from '../terminal/connection.js';
import { Icon } from './icons.js';
import { useModalDialog } from './useModalDialog.js';

export function HostKeyDialog({
  prompt,
  onAnswer,
}: {
  prompt: HostKeyPrompt;
  onAnswer(accept: boolean): void;
}) {
  const ref = useModalDialog(() => onAnswer(false));
  const where = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;
  return (
    <dialog ref={ref} className="terminal-decision warning" aria-labelledby="hostkey-title">
      <div className="terminal-decision-body">
        <div className="terminal-decision-heading">
          <span className="terminal-decision-icon">
            <Icon name="shield" />
          </span>
          <h3 id="hostkey-title">Unknown host key</h3>
        </div>
        <div className="terminal-decision-host">{where}</div>
        <p className="terminal-decision-note">
          This is the first connection to this host. Compare the fingerprint with the one the
          server&apos;s administrator gave you (<code>ssh-keygen -lf</code> on the server) before
          accepting.
        </p>
        <div className="terminal-decision-fingerprint" data-testid="host-key-fingerprint">
          <span className="algorithm">{prompt.algorithm}</span>
          {prompt.fingerprint}
        </div>
      </div>
      <div className="terminal-decision-actions">
        <button type="button" className="terminal-decision-btn" onClick={() => onAnswer(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="terminal-decision-btn primary"
          onClick={() => onAnswer(true)}
        >
          Accept and connect
        </button>
      </div>
    </dialog>
  );
}
