/**
 * Quick connect: host, port, user and how to log in — a key from the vault
 * (by id) or a password, which the engine asks for when it needs it (or takes
 * from the vault if it was saved). The form never holds a secret.
 */
import { useState, type FormEvent } from 'react';
import type { Auth, KeyInfo } from '../../../shared/ipc.js';
import type { Target } from '../terminal/connection.js';

export interface QuickConnectProps {
  initial: Partial<Target>;
  keys: KeyInfo[];
  onConnect(target: Target): void;
  onManageKeys(): void;
}

/** `user@host:port` in the host field fills the other fields too. */
export function splitDestination(value: string): Partial<Target> {
  const match = /^(?:([^@\s]+)@)?(\[[0-9A-Fa-f:.]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(value.trim());
  if (!match) return { host: value.trim() };
  const [, username, host, port] = match;
  return {
    host: host ?? '',
    ...(username !== undefined && { username }),
    ...(port !== undefined && { port: Number(port) }),
  };
}

export function QuickConnect({ initial, keys, onConnect, onManageKeys }: QuickConnectProps) {
  const [host, setHost] = useState(initial.host ?? '');
  const [port, setPort] = useState(String(initial.port ?? 22));
  const [username, setUsername] = useState(initial.username ?? '');
  const [method, setMethod] = useState<Auth['kind']>(initial.auth?.kind ?? 'password');
  const initialKey = initial.auth?.kind === 'key' ? initial.auth.keyId : '';
  const [keyId, setKeyId] = useState(initialKey);
  const [problem, setProblem] = useState<string | null>(null);
  const chosenKey = keys.find((k) => k.id === keyId) ?? keys[0];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const destination = splitDestination(host);
    const target = {
      host: destination.host ?? '',
      port: destination.port ?? Number(port),
      username: (destination.username ?? username).trim(),
    };
    if (!target.host) return setProblem('Enter a host name or address');
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      return setProblem('The port must be between 1 and 65535');
    }
    if (!target.username) return setProblem('Enter a user name');
    let auth: Auth;
    if (method === 'key') {
      if (!chosenKey) return setProblem('Generate or import a key first');
      auth = { kind: 'key', keyId: chosenKey.id };
    } else {
      auth = { kind: 'password' };
    }
    setProblem(null);
    onConnect({ ...target, auth });
  };

  return (
    <form className="connect-card" onSubmit={submit} aria-label="Quick connect" noValidate>
      <div className="connect-card-body">
        <div className="system-form-row">
          <div className="system-form-group">
            <label htmlFor="qc-host">Host</label>
            <input
              id="qc-host"
              className="system-input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="server.example.com or user@host:port"
              autoFocus
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

        {method === 'password' ? (
          <p className="system-hint">
            You are asked for the password after the host key is checked (or the saved one is used).
          </p>
        ) : keys.length === 0 ? (
          <p className="system-hint">
            The vault has no keys yet.{' '}
            <button type="button" className="link-btn" onClick={onManageKeys}>
              Generate or import one
            </button>
          </p>
        ) : (
          <div className="system-form-group">
            <label htmlFor="qc-key">Key</label>
            <select
              id="qc-key"
              className="system-input"
              value={chosenKey?.id ?? ''}
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

        {problem && (
          <p className="system-error" role="alert">
            {problem}
          </p>
        )}
        <div style={{ marginTop: 16 }}>
          <button type="submit" className="system-btn primary">
            Connect
          </button>
        </div>
      </div>
    </form>
  );
}
