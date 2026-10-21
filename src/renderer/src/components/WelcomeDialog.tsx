/**
 * First run, right after the vault was created: offers to bring over what
 * the user already has in ~/.ssh (%USERPROFILE%\.ssh on Windows): hosts
 * from the ssh config (with their key files), trusted host keys from
 * known_hosts, and other keys. Every step is optional; main reads the files.
 */
import { useState } from 'react';
import { call, messageOf } from '../api.js';
import { SshConfigImport } from '../hosts/SshConfigImport.js';
import { Dialog } from './Dialog.js';
import { AppLogo } from './icons.js';

export function WelcomeDialog({
  onClose,
  onImported,
  onShowKeys,
}: {
  onClose(): void;
  onImported(): void;
  onShowKeys(): void;
}) {
  const [config, setConfig] = useState(false);
  const [hostsDone, setHostsDone] = useState(false);
  const [knownHosts, setKnownHosts] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (config) {
    return (
      <SshConfigImport
        withKeys
        onClose={() => setConfig(false)}
        onImported={() => {
          setHostsDone(true);
          onImported();
        }}
      />
    );
  }

  const importKnownHosts = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const summary = await call('hostKeys.importKnownHosts', { chooseFile: false });
      setKnownHosts(
        summary.found
          ? `${summary.imported + summary.hashed} host key${summary.imported + summary.hashed === 1 ? '' : 's'} imported`
          : 'No known_hosts file in your .ssh folder',
      );
      onImported();
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Welcome to quqa-express" onClose={onClose} cancelLabel="Done" wide>
      <div className="about">
        <AppLogo size={44} />
        <p className="system-hint">
          Your vault is ready. Bring over what you already use with OpenSSH, or skip this and add
          hosts yourself. Nothing is changed in your .ssh folder.
        </p>
      </div>
      <ul className="welcome-steps">
        <li>
          <div>
            <strong>Hosts from ~/.ssh/config</strong>
            <span className="system-hint">
              Preview the entries and pick which to add; their key files can come along.
            </span>
          </div>
          <button
            type="button"
            className="system-btn inline"
            disabled={busy}
            onClick={() => setConfig(true)}
          >
            {hostsDone ? 'Import more…' : 'Import hosts…'}
          </button>
        </li>
        <li>
          <div>
            <strong>Trusted host keys from known_hosts</strong>
            <span className="system-hint" role="status">
              {knownHosts ?? 'So servers you already trust are not asked about again.'}
            </span>
          </div>
          <button
            type="button"
            className="system-btn inline"
            disabled={busy || knownHosts !== null}
            onClick={() => void importKnownHosts()}
          >
            Import host keys
          </button>
        </li>
        <li>
          <div>
            <strong>Other private keys</strong>
            <span className="system-hint">
              Import a key file (passphrase-protected keys too) or generate a new Ed25519 key.
            </span>
          </div>
          <button type="button" className="system-btn ghost inline" onClick={onShowKeys}>
            Open Keys
          </button>
        </li>
      </ul>
      {problem && (
        <p className="system-error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
