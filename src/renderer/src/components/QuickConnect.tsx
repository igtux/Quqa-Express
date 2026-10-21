/**
 * Quick Connect (Ctrl+Shift+O): a picker over every saved host with
 * type-to-filter, plus ad-hoc `user@host:port` connections that may be saved
 * as a host. The form never holds a secret: a password login asks after the
 * host key is checked (or uses the saved password).
 *
 * Modelled on Jarvis NG's Quick Connect (apps/web/src/machines/QuickConnect.tsx), same owner.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Auth, HostInfo, KeyInfo } from '../../../shared/ipc.js';
import { call, messageOf } from '../api.js';
import { EMPTY_HOST, validateHost } from '../hosts/HostForm.js';
import { destination, filterHosts, splitDestination } from '../hosts/hostModel.js';
import { useModalDialog } from './useModalDialog.js';

export interface AdhocTarget {
  host: string;
  port: number;
  username: string;
  auth: Auth;
}

export function QuickConnect({
  hosts,
  keys,
  onOpenHost,
  onAdhoc,
  onSavedHost,
  onClose,
}: {
  hosts: HostInfo[];
  keys: KeyInfo[];
  onOpenHost(hostId: string): void;
  onAdhoc(target: AdhocTarget): void;
  onSavedHost(host: HostInfo): void;
  onClose(): void;
}) {
  const ref = useModalDialog(onClose);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [adhoc, setAdhoc] = useState<{ host: string; username: string; port: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => filterHosts(hosts, query).slice(0, 50), [hosts, query]);
  const parsed = splitDestination(query);
  const offerAdhoc = Boolean(parsed.host) && query.trim().length > 0;
  const count = matches.length + (offerAdhoc ? 1 : 0);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('.qc-item.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const choose = (index: number) => {
    const host = matches[index];
    if (host) {
      onOpenHost(host.id);
      onClose();
    } else if (offerAdhoc && parsed.host) {
      setAdhoc({ host: parsed.host, username: parsed.username ?? '', port: parsed.port ?? 22 });
    }
  };

  return (
    <dialog ref={ref} className="app-dialog quick-connect" aria-label="Quick Connect">
      {adhoc ? (
        <AdhocForm
          initial={adhoc}
          keys={keys}
          onBack={() => setAdhoc(null)}
          onConnect={(target, save) => {
            if (!save) {
              onAdhoc(target);
              onClose();
              return Promise.resolve(null);
            }
            return call('hosts.save', {
              host: {
                ...EMPTY_HOST,
                name: target.host,
                address: target.host,
                port: target.port,
                username: target.username,
                auth: target.auth,
              },
            }).then(
              (host) => {
                onSavedHost(host);
                onOpenHost(host.id);
                onClose();
                return null;
              },
              (error: unknown) => messageOf(error),
            );
          }}
        />
      ) : (
        <div className="qc-picker">
          <input
            autoFocus
            className="qc-input"
            value={query}
            placeholder="Host name, address, tag:… or user@host:port"
            aria-label="Find a host or enter user@host:port"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelected((i) => Math.min(count - 1, i + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelected((i) => Math.max(0, i - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(selected);
              }
            }}
          />
          <div className="qc-list" ref={listRef} role="listbox" aria-label="Hosts">
            {matches.map((host, index) => (
              <div
                key={host.id}
                role="option"
                aria-selected={index === selected}
                className={`qc-item${index === selected ? ' selected' : ''}`}
                onMouseMove={() => setSelected(index)}
                onClick={() => choose(index)}
              >
                <span
                  className="qc-dot"
                  style={host.color ? { background: host.color } : undefined}
                />
                <span className="qc-name">{host.name}</span>
                <span className="qc-sub">{destination(host)}</span>
                {host.group && <span className="item-badge">{host.group}</span>}
              </div>
            ))}
            {offerAdhoc && (
              <div
                role="option"
                aria-selected={selected === matches.length}
                className={`qc-item adhoc${selected === matches.length ? ' selected' : ''}`}
                onMouseMove={() => setSelected(matches.length)}
                onClick={() => choose(matches.length)}
              >
                <span className="qc-name">Connect to {query.trim()}</span>
                <span className="qc-sub">ad hoc; the host key is checked first</span>
              </div>
            )}
            {count === 0 && (
              <div className="qc-empty">
                {hosts.length === 0
                  ? 'No saved hosts yet. Type user@host:port to connect.'
                  : 'No matching host'}
              </div>
            )}
          </div>
          <div className="qc-hint">↑↓ to move · Enter to connect · Esc to close</div>
        </div>
      )}
    </dialog>
  );
}

function AdhocForm({
  initial,
  keys,
  onBack,
  onConnect,
}: {
  initial: { host: string; username: string; port: number };
  keys: KeyInfo[];
  onBack(): void;
  /** Resolves with a problem to show, or null when done. */
  onConnect(target: AdhocTarget, save: boolean): Promise<string | null>;
}) {
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(String(initial.port));
  const [username, setUsername] = useState(initial.username);
  const [method, setMethod] = useState<Auth['kind']>('password');
  const [keyId, setKeyId] = useState(keys[0]?.id ?? '');
  const [save, setSave] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (method === 'key' && !keys.some((k) => k.id === keyId)) {
      return setProblem('Generate or import a key first');
    }
    const auth: Auth = method === 'key' ? { kind: 'key', keyId } : { kind: 'password' };
    const target = { host: host.trim(), port: Number(port), username: username.trim(), auth };
    const invalid = validateHost({
      ...EMPTY_HOST,
      address: target.host,
      port: target.port,
      username: target.username,
    });
    if (invalid) return setProblem(invalid);
    setProblem(null);
    void onConnect(target, save).then(setProblem);
  };

  return (
    <form className="app-dialog-form" onSubmit={submit} aria-label="Quick connect" noValidate>
      <h3 className="app-dialog-title">Connect to a new host</h3>
      <div className="app-dialog-body">
        <div className="system-form-row">
          <div className="system-form-group">
            <label htmlFor="qc-host">Host</label>
            <input
              id="qc-host"
              className="system-input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="system-form-group">
            <label htmlFor="qc-port">Port</label>
            <input
              id="qc-port"
              className="system-input"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="system-form-group">
          <label htmlFor="qc-user">User</label>
          <input
            id="qc-user"
            className="system-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
        </div>
        <div className="segmented" role="group" aria-label="Authentication">
          <button
            type="button"
            aria-pressed={method === 'password'}
            onClick={() => setMethod('password')}
          >
            Password
          </button>
          <button type="button" aria-pressed={method === 'key'} onClick={() => setMethod('key')}>
            Key from the vault
          </button>
        </div>
        {method === 'key' && keys.length > 0 && (
          <div className="system-form-group">
            <label htmlFor="qc-key">Key</label>
            <select
              id="qc-key"
              className="system-input"
              value={keyId}
              onChange={(e) => setKeyId(e.target.value)}
            >
              {keys.map((key) => (
                <option key={key.id} value={key.id}>
                  {key.label} ({key.algorithm}, {key.fingerprint.slice(7, 19)}…)
                </option>
              ))}
            </select>
          </div>
        )}
        {method === 'password' && (
          <p className="system-hint">
            You are asked for the password after the host key is checked (or the saved one is used).
          </p>
        )}
        <label className="system-check">
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          <span>Save as a host</span>
        </label>
        {problem && (
          <p className="system-error" role="alert">
            {problem}
          </p>
        )}
      </div>
      <div className="app-dialog-actions">
        <button type="button" className="system-btn ghost inline" onClick={onBack}>
          Back
        </button>
        <button type="submit" className="system-btn primary inline">
          Connect
        </button>
      </div>
    </form>
  );
}
