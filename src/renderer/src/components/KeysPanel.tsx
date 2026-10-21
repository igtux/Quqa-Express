/**
 * SSH keys in the vault: generate, import (pasted text or a file chosen in a
 * main-process dialog), copy or export the public key, delete. Only public
 * data comes back; pasted key text and its passphrase are sent once and the
 * fields are cleared.
 *
 * Modelled on Jarvis NG's keys tab (apps/web/src/machines/SshKeysTab.tsx), same owner.
 */
import { useRef, useState, type FormEvent } from 'react';
import type { KeyInfo } from '../../../shared/ipc.js';
import { call, messageOf } from '../api.js';
import { useModalDialog } from './useModalDialog.js';

export function KeysPanel({ keys, onChange }: { keys: KeyInfo[]; onChange(): void }) {
  const [label, setLabel] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<KeyInfo | null>(null);

  const run = async (action: () => Promise<string | null>) => {
    setProblem(null);
    setNotice(null);
    setBusy(true);
    try {
      setNotice(await action());
      onChange();
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const generate = (event: FormEvent) => {
    event.preventDefault();
    const name = label.trim();
    if (!name) return setProblem('Name the key first');
    void run(async () => {
      const key = await call('keys.generate', { label: name });
      setLabel('');
      return `Generated ${key.label} (${key.fingerprint})`;
    });
  };

  const copy = (key: KeyInfo) =>
    void window.quqa
      .clipboardWrite(key.publicKey)
      .then(() => setNotice(`Public key of ${key.label} copied`))
      .catch(() => setProblem('The clipboard is not available'));

  return (
    <section className="panel" aria-label="SSH keys">
      <form className="panel-row" onSubmit={generate}>
        <input
          className="system-input"
          aria-label="New key name"
          placeholder="Name, e.g. laptop-2026"
          value={label}
          maxLength={64}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button type="submit" className="system-btn primary inline" disabled={busy}>
          Generate Ed25519
        </button>
        <button
          type="button"
          className="system-btn inline"
          onClick={() => setImporting(true)}
          disabled={busy}
        >
          Import…
        </button>
      </form>
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
      {keys.length === 0 ? (
        <p className="panel-empty">No keys yet. Generate one, or import an existing key.</p>
      ) : (
        <ul className="item-list" aria-label="Keys">
          {keys.map((key) => (
            <li key={key.id} className="item" data-testid="key-row">
              <div className="item-main">
                <div className="item-title">
                  {key.label}
                  <span className="item-badge">{key.algorithm}</span>
                  {key.encrypted && (
                    <span className="item-badge">
                      {key.passphraseSaved ? 'passphrase saved' : 'asks passphrase'}
                    </span>
                  )}
                </div>
                <div className="item-mono" data-testid="key-fingerprint">
                  {key.fingerprint}
                </div>
                <div className="item-meta">
                  Added {new Date(key.createdAt).toLocaleString()}
                  {key.usedBy > 0 && ` · used by ${key.usedBy} host${key.usedBy === 1 ? '' : 's'}`}
                </div>
              </div>
              <div className="item-actions">
                <button type="button" className="link-btn" onClick={() => copy(key)}>
                  Copy public key
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() =>
                    void run(async () => {
                      const { saved } = await call('keys.exportPublic', { id: key.id });
                      return saved ? 'Public key saved' : null;
                    })
                  }
                >
                  Export…
                </button>
                <button type="button" className="link-btn danger" onClick={() => setDeleting(key)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {importing && (
        <ImportKeyDialog
          onClose={(message) => {
            setImporting(false);
            if (message) {
              setNotice(message);
              onChange();
            }
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.label}?`}
          note={`${
            deleting.usedBy > 0
              ? `${deleting.usedBy} saved host${deleting.usedBy === 1 ? '' : 's'} log in with this key and will stop working until you choose another login. `
              : ''
          }The private key is removed from the vault for good. Servers that only accept this key will refuse you; keep another way in.`}
          confirm="Delete key"
          onAnswer={(yes) => {
            const key = deleting;
            setDeleting(null);
            if (yes) {
              void run(async () => {
                await call('keys.delete', { id: key.id });
                return `Deleted ${key.label}`;
              });
            }
          }}
        />
      )}
    </section>
  );
}

function ImportKeyDialog({ onClose }: { onClose(message: string | null): void }) {
  const ref = useModalDialog(() => onClose(null));
  const [label, setLabel] = useState('');
  const [savePassphrase, setSavePassphrase] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const text = useRef<HTMLTextAreaElement>(null);
  const passphrase = useRef<HTMLInputElement>(null);

  const submit = async (fromFile: boolean) => {
    const name = label.trim();
    if (!name) return setProblem('Name the key');
    const pasted = text.current?.value ?? '';
    if (!fromFile && !pasted.trim()) return setProblem('Paste a private key, or choose a file');
    const secret = passphrase.current?.value || undefined;
    setProblem(null);
    setBusy(true);
    try {
      const common = {
        label: name,
        savePassphrase,
        ...(secret !== undefined && { passphrase: secret }),
      };
      const key = fromFile
        ? (await call('keys.importFile', common)).imported
        : await call('keys.import', { ...common, privateKey: pasted });
      if (!key) return;
      if (text.current) text.current.value = '';
      if (passphrase.current) passphrase.current.value = '';
      onClose(`Imported ${key.label} (${key.fingerprint})`);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="terminal-decision" aria-labelledby="import-title">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <div className="terminal-decision-body">
          <div className="terminal-decision-heading">
            <h3 id="import-title">Import a private key</h3>
          </div>
          <div className="system-form-group">
            <label htmlFor="import-label">Name</label>
            <input
              id="import-label"
              className="system-input"
              value={label}
              maxLength={64}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
            />
          </div>
          <div className="system-form-group">
            <label htmlFor="import-text">Private key</label>
            <textarea
              id="import-text"
              ref={text}
              className="system-textarea"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              spellCheck={false}
            />
            <span className="system-hint">
              OpenSSH, PEM or PuTTY (.ppk). The text is sealed in the vault and never shown again.
            </span>
          </div>
          <div className="system-form-group">
            <label htmlFor="import-passphrase">Passphrase (if the key has one)</label>
            <input
              id="import-passphrase"
              ref={passphrase}
              className="system-input"
              type="password"
              autoComplete="off"
            />
          </div>
          <label className="system-check">
            <input
              type="checkbox"
              checked={savePassphrase}
              onChange={(e) => setSavePassphrase(e.target.checked)}
            />
            Save the passphrase in the vault (otherwise it is asked once after each unlock)
          </label>
          {problem && (
            <p className="system-error" role="alert">
              {problem}
            </p>
          )}
        </div>
        <div className="terminal-decision-actions">
          <button type="button" className="terminal-decision-btn" onClick={() => onClose(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="terminal-decision-btn"
            disabled={busy}
            onClick={() => void submit(true)}
          >
            From file…
          </button>
          <button type="submit" className="terminal-decision-btn primary" disabled={busy}>
            Import pasted key
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  note,
  confirm,
  onAnswer,
}: {
  title: string;
  note: string;
  confirm: string;
  onAnswer(yes: boolean): void;
}) {
  const ref = useModalDialog(() => onAnswer(false));
  return (
    <dialog ref={ref} className="terminal-decision warning" aria-label={title}>
      <div className="terminal-decision-body">
        <div className="terminal-decision-heading">
          <h3>{title}</h3>
        </div>
        <p className="terminal-decision-note">{note}</p>
      </div>
      <div className="terminal-decision-actions">
        <button type="button" className="terminal-decision-btn" onClick={() => onAnswer(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="terminal-decision-btn primary danger"
          onClick={() => onAnswer(true)}
        >
          {confirm}
        </button>
      </div>
    </dialog>
  );
}
