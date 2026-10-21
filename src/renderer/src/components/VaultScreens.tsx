/**
 * First start (create the vault), the lock screen and "Forgot password?
 * Start over". Password fields are uncontrolled: their value is read once on
 * submit, sent with the intent and cleared, so it never sits in React state.
 */
import { useRef, useState, type FormEvent } from 'react';
import type { VaultStatus } from '../../../shared/ipc.js';
import { call, messageOf } from '../api.js';
import { Dialog } from './Dialog.js';
import { Icon } from './icons.js';

const MIN_PASSWORD = 8;

function take(ref: React.RefObject<HTMLInputElement | null>): string {
  const input = ref.current;
  if (!input) return '';
  const value = input.value;
  input.value = '';
  return value;
}

export function SetupScreen({
  status,
  onDone,
  movedTo,
}: {
  status: VaultStatus;
  onDone(status: VaultStatus): void;
  /** After "Start over": where the old vault went. */
  movedTo?: string | null;
}) {
  const mustUsePassword = !status.osAvailable;
  const [usePassword, setUsePassword] = useState(mustUsePassword);
  const [portable, setPortable] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let secret: string | undefined;
    if (usePassword || mustUsePassword) {
      const first = take(password);
      const second = take(confirm);
      if (first.length < MIN_PASSWORD) {
        return setProblem(`Use at least ${MIN_PASSWORD} characters`);
      }
      if (first !== second) return setProblem('The passwords do not match');
      secret = first;
    }
    setProblem(null);
    setBusy(true);
    try {
      onDone(
        await call('vault.create', {
          ...(secret !== undefined && { password: secret }),
          ...(secret !== undefined && portable && { portable: true }),
        }),
      );
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect-screen">
      <form
        className="connect-card"
        onSubmit={(e) => void submit(e)}
        aria-label="Create vault"
        noValidate
      >
        <div className="connect-card-header">
          <Icon name="shield" className="brand-icon" />
          <h1>Set up your vault</h1>
        </div>
        <div className="connect-card-body">
          {movedTo && (
            <p className="vault-moved" role="status">
              Your old vault was moved to <code>{movedTo}</code>. Nothing was deleted.
            </p>
          )}
          <p className="system-hint vault-intro">
            Keys, passphrases, saved passwords and trusted host keys are kept in an encrypted vault
            on this computer.{' '}
            {mustUsePassword
              ? 'This system has no secure key store, so the vault needs a master password.'
              : 'It is protected by your system account; a master password adds a second lock.'}
          </p>
          {!mustUsePassword && (
            <label className="system-check">
              <input
                type="checkbox"
                checked={usePassword}
                onChange={(e) => setUsePassword(e.target.checked)}
              />
              Also require a master password
            </label>
          )}
          {(usePassword || mustUsePassword) && (
            <>
              <div className="system-form-group">
                <label htmlFor="vault-password">Master password</label>
                <input
                  id="vault-password"
                  ref={password}
                  className="system-input"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                />
              </div>
              <div className="system-form-group">
                <label htmlFor="vault-confirm">Repeat the password</label>
                <input
                  id="vault-confirm"
                  ref={confirm}
                  className="system-input"
                  type="password"
                  autoComplete="new-password"
                />
              </div>
              {status.osAvailable && (
                <label className="system-check">
                  <input
                    type="checkbox"
                    checked={portable}
                    onChange={(e) => setPortable(e.target.checked)}
                  />
                  Portable: the password alone opens the vault (on any computer)
                </label>
              )}
              <span className="system-hint">
                There is no way to recover a forgotten master password.
              </span>
            </>
          )}
          {problem && (
            <p className="system-error" role="alert">
              {problem}
            </p>
          )}
          <div style={{ marginTop: 16 }}>
            <button type="submit" className="system-btn primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create vault'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

export function UnlockScreen({
  status,
  onDone,
  onReset,
}: {
  status: VaultStatus;
  onDone(status: VaultStatus): void;
  /** The vault was moved aside: show "Create vault". */
  onReset(status: VaultStatus, backup: string | null): void;
}) {
  const needsPassword = status.mode !== 'os';
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const password = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const secret = needsPassword ? take(password) : undefined;
    if (needsPassword && !secret) return setProblem('Enter the master password');
    setProblem(null);
    setBusy(true);
    try {
      onDone(await call('vault.unlock', secret ? { password: secret } : {}));
    } catch (error) {
      setProblem(messageOf(error));
      password.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect-screen vault-lock-screen">
      <form
        className="connect-card"
        onSubmit={(e) => void submit(e)}
        aria-label="Unlock vault"
        noValidate
      >
        <div className="connect-card-header">
          <Icon name="lock" className="brand-icon" />
          <h1>Vault locked</h1>
        </div>
        <div className="connect-card-body">
          {needsPassword ? (
            <div className="system-form-group">
              <label htmlFor="unlock-password">Master password</label>
              <input
                id="unlock-password"
                ref={password}
                className="system-input"
                type="password"
                autoComplete="current-password"
                autoFocus
              />
            </div>
          ) : (
            <p className="system-hint vault-intro">
              The vault is protected by your system account. Open sessions keep running.
            </p>
          )}
          {problem && (
            <p className="system-error" role="alert">
              {problem}
            </p>
          )}
          <div style={{ marginTop: 16 }}>
            <button
              type="submit"
              className="system-btn primary"
              disabled={busy}
              autoFocus={!needsPassword}
            >
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          </div>
          <button
            type="button"
            className="link-btn vault-forgot"
            onClick={() => setResetting(true)}
          >
            {needsPassword ? 'Forgot password? Start over' : 'Cannot unlock? Start over'}
          </button>
        </div>
      </form>
      {resetting && <ResetVaultDialog onClose={() => setResetting(false)} onReset={onReset} />}
    </div>
  );
}

/**
 * Starting over: the vault file and its backup are moved (not deleted) to
 * vault-backups/<time>/ in the app data folder. Needs DELETE typed out.
 */
export function ResetVaultDialog({
  onClose,
  onReset,
}: {
  onClose(): void;
  onReset(status: VaultStatus, backup: string | null): void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const confirmed = typed.trim() === 'DELETE';
  const submit = async () => {
    if (!confirmed) return;
    setBusy(true);
    setProblem(null);
    try {
      const { status, backup } = await call('vault.reset', { confirm: 'DELETE' });
      onReset(status, backup);
    } catch (error) {
      setProblem(messageOf(error));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Start over with a new vault?"
      onClose={onClose}
      danger
      busy={busy}
      submitDisabled={!confirmed}
      submitLabel={busy ? 'Starting over…' : 'Start over'}
      onSubmit={() => void submit()}
    >
      <p className="system-hint">
        Without the master password the vault cannot be opened, and there is no way to recover it.
        Starting over removes from quqa-express:
      </p>
      <ul className="reset-list">
        <li>your saved hosts, favorites, tunnels and open tabs</li>
        <li>private keys that are stored only in the vault</li>
        <li>saved passwords and key passphrases</li>
        <li>trusted host keys (pinned fingerprints)</li>
        <li>settings kept in the vault (auto-lock, terminal look)</li>
      </ul>
      <p className="system-hint">
        Your <code>.ssh</code> folder (keys, config, known_hosts) is not touched. The old vault is
        not deleted either: it is moved to a <code>vault-backups</code> folder in the app&apos;s
        data folder, so it can be put back if you remember the password.
      </p>
      <div className="system-form-group">
        <label htmlFor="reset-confirm">
          Type <strong>DELETE</strong> to confirm
        </label>
        <input
          id="reset-confirm"
          className="system-input"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
        />
      </div>
      {problem && (
        <p className="system-error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
