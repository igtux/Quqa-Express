/**
 * Import hosts from ~/.ssh/config: main reads the file (or one the user
 * picks), the engine parses it, and this dialog previews the entries with
 * checkboxes. Keys named by IdentityFile are imported into the vault only
 * when the user ticks that box; the renderer never names a file itself.
 */
import { useState } from 'react';
import type { SshConfigImported, SshConfigPreview } from '../../../shared/ipc.js';
import { call, messageOf } from '../api.js';
import { Dialog } from '../components/Dialog.js';

export function SshConfigImport({
  onClose,
  onImported,
  withKeys = false,
}: {
  onClose(): void;
  onImported(): void;
  /** Tick "Import the IdentityFile keys" from the start (first run). */
  withKeys?: boolean;
}) {
  const [preview, setPreview] = useState<SshConfigPreview | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [importKeys, setImportKeys] = useState(withKeys);
  const [tmux, setTmux] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<SshConfigImported | null>(null);

  const read = async (chooseFile: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      const value = await call('sshConfig.preview', { chooseFile });
      setPreview(value);
      setChosen(
        new Set(value.entries.filter((e) => !e.problem && !e.duplicate).map((e) => e.alias)),
      );
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!preview || chosen.size === 0) return;
    setBusy(true);
    setProblem(null);
    try {
      setResult(
        await call('sshConfig.import', {
          token: preview.token,
          aliases: [...chosen],
          importKeys,
          tmux,
        }),
      );
      onImported();
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Dialog title="Imported from ssh config" onClose={onClose} cancelLabel="Close">
        <p className="system-hint" role="status">
          {result.hosts} host{result.hosts === 1 ? '' : 's'} added
          {importKeys && `, ${result.keys} key${result.keys === 1 ? '' : 's'} imported`}.
        </p>
        {result.problems.length > 0 && (
          <ul className="import-notes">
            {result.problems.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </Dialog>
    );
  }

  const importable = preview?.entries.filter((e) => !e.problem) ?? [];
  return (
    <Dialog
      title="Import from ~/.ssh/config"
      onClose={onClose}
      wide
      {...(preview?.found && {
        onSubmit: () => void run(),
        submitLabel: `Import ${chosen.size} host${chosen.size === 1 ? '' : 's'}`,
        submitDisabled: chosen.size === 0,
      })}
      busy={busy}
    >
      {!preview && (
        <p className="system-hint">
          Reads Host, HostName, User, Port, IdentityFile and ProxyJump. Wildcard blocks such as{' '}
          <code>Host *</code> are applied as defaults; Include and Match are not followed.
        </p>
      )}
      <div className="panel-row">
        <button
          type="button"
          className="system-btn inline"
          disabled={busy}
          onClick={() => void read(false)}
        >
          Read ~/.ssh/config
        </button>
        <button
          type="button"
          className="system-btn ghost inline"
          disabled={busy}
          onClick={() => void read(true)}
        >
          Choose a file…
        </button>
      </div>
      {preview && !preview.found && (
        <p className="system-hint">No ssh config file was found there.</p>
      )}
      {preview?.found && (
        <>
          {preview.entries.length === 0 ? (
            <p className="panel-empty">The file has no concrete Host entries.</p>
          ) : (
            <div className="import-table" role="table" aria-label="Hosts in the ssh config">
              <div className="import-row head" role="row">
                <span role="columnheader">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={importable.length > 0 && chosen.size === importable.length}
                    onChange={(e) =>
                      setChosen(new Set(e.target.checked ? importable.map((x) => x.alias) : []))
                    }
                  />
                </span>
                <span role="columnheader">Host</span>
                <span role="columnheader">Connects to</span>
                <span role="columnheader">Key file</span>
              </div>
              {preview.entries.map((entry) => (
                <label
                  key={entry.alias}
                  className={`import-row${entry.problem ? ' disabled' : ''}`}
                  role="row"
                >
                  <span role="cell">
                    <input
                      type="checkbox"
                      disabled={Boolean(entry.problem)}
                      checked={chosen.has(entry.alias)}
                      aria-label={`Import ${entry.alias}`}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(entry.alias);
                        else next.delete(entry.alias);
                        setChosen(next);
                      }}
                    />
                  </span>
                  <span role="cell" className="import-alias">
                    {entry.alias}
                    {entry.duplicate && <span className="item-badge">already saved</span>}
                    {entry.proxyJump && (
                      <span className="item-badge" title="Stored for jump-host support">
                        via {entry.proxyJump}
                      </span>
                    )}
                  </span>
                  <span role="cell" className="item-mono">
                    {entry.problem ||
                      `${entry.user}@${entry.hostName}${entry.port === 22 ? '' : `:${entry.port}`}`}
                  </span>
                  <span role="cell" className="item-mono" title={entry.identityFile}>
                    {entry.identityFile ? entry.identityFile.split(/[\\/]/).pop() : '—'}
                  </span>
                </label>
              ))}
            </div>
          )}
          <label className="system-check">
            <input
              type="checkbox"
              checked={importKeys}
              onChange={(e) => setImportKeys(e.target.checked)}
            />
            <span>
              Import the IdentityFile keys into the vault (each key once; keys protected by a
              passphrase are skipped and can be imported under Keys).
            </span>
          </label>
          <label className="system-check">
            <input type="checkbox" checked={tmux} onChange={(e) => setTmux(e.target.checked)} />
            <span>Turn on resumable sessions (tmux) for these hosts</span>
          </label>
          {preview.notes.length > 0 && (
            <details className="import-notes-box">
              <summary>Not imported ({preview.notes.length})</summary>
              <ul className="import-notes">
                {preview.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {problem && (
        <p className="system-error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
