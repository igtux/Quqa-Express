/**
 * Quick connect: host, port, user and either a password or a pasted private
 * key. The secret goes to the engine with the connect intent and the form
 * forgets it.
 */
import { useRef, useState, type FormEvent } from 'react';
import type { Auth } from '../../../shared/ipc.js';
import type { Target } from '../terminal/connection.js';
import { Icon } from './icons.js';

export interface QuickConnectProps {
  initial: Partial<Target>;
  error: string | null;
  onConnect(target: Target, auth: Auth): void;
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

export function QuickConnect({ initial, error, onConnect }: QuickConnectProps) {
  const [host, setHost] = useState(initial.host ?? '');
  const [port, setPort] = useState(String(initial.port ?? 22));
  const [username, setUsername] = useState(initial.username ?? '');
  const [method, setMethod] = useState<Auth['kind']>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const destination = splitDestination(host);
    const target: Target = {
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
    if (method === 'password') {
      if (!password) return setProblem('Enter the password');
      auth = { kind: 'password', password };
    } else {
      if (!privateKey.trim()) return setProblem('Paste or load a private key');
      auth = { kind: 'key', privateKey, ...(passphrase && { passphrase }) };
    }
    setProblem(null);
    // Forget the secrets in the form; the engine holds them for the session.
    setPassword('');
    setPrivateKey('');
    setPassphrase('');
    onConnect(target, auth);
  };

  const loadKeyFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 32 * 1024) return setProblem('That file is too large to be a private key');
    setPrivateKey(await file.text());
  };

  const shown = problem ?? error;

  return (
    <div className="connect-screen">
      <form className="connect-card" onSubmit={submit} aria-label="Quick connect" noValidate>
        <div className="connect-card-header">
          <Icon name="terminal" className="brand-icon" />
          <h1>Quick connect</h1>
        </div>
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
              Private key
            </button>
          </div>

          {method === 'password' ? (
            <div className="system-form-group">
              <label htmlFor="qc-password">Password</label>
              <input
                id="qc-password"
                className="system-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            </div>
          ) : (
            <>
              <div className="system-form-group">
                <label htmlFor="qc-key">
                  Private key{' '}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => fileInput.current?.click()}
                  >
                    Load from file…
                  </button>
                </label>
                <textarea
                  id="qc-key"
                  className="system-textarea"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  spellCheck={false}
                />
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  onChange={(e) => void loadKeyFile(e.target.files?.[0])}
                />
                <span className="system-hint">OpenSSH, PEM or PuTTY (.ppk) format.</span>
              </div>
              <div className="system-form-group">
                <label htmlFor="qc-passphrase">Passphrase (if the key has one)</label>
                <input
                  id="qc-passphrase"
                  className="system-input"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </>
          )}

          {shown && (
            <p className="system-error" role="alert">
              {shown}
            </p>
          )}
          <div style={{ marginTop: 16 }}>
            <button type="submit" className="system-btn primary">
              Connect
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
