/** Vault protection (master password, portable mode) and auto-lock settings. */
import { useRef, useState, type FormEvent } from 'react';
import type { VaultStatus } from '../../../shared/ipc.js';
import { call, messageOf } from '../api.js';

const AUTO_LOCK = [0, 5, 15, 30, 60, 240];

const MODE_TEXT: Record<NonNullable<VaultStatus['mode']>, string> = {
  os: 'Protected by your system account (no master password).',
  'os+password': 'Protected by your system account and a master password.',
  password: 'Portable: protected by the master password alone.',
};

export function SecurityPanel({
  status,
  onChange,
}: {
  status: VaultStatus;
  onChange(status: VaultStatus): void;
}) {
  const hasPassword = status.mode !== 'os';
  const [portable, setPortable] = useState(status.mode === 'password');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = useRef<HTMLInputElement>(null);
  const next = useRef<HTMLInputElement>(null);
  const confirm = useRef<HTMLInputElement>(null);

  const read = (ref: React.RefObject<HTMLInputElement | null>) => {
    const value = ref.current?.value ?? '';
    if (ref.current) ref.current.value = '';
    return value;
  };

  const change = async (event: FormEvent, remove: boolean) => {
    event.preventDefault();
    const old = read(current);
    const password = read(next);
    const repeat = read(confirm);
    if (!remove) {
      if (password.length < 8) return setProblem('Use at least 8 characters');
      if (password !== repeat) return setProblem('The passwords do not match');
    }
    setProblem(null);
    try {
      const status = await call('vault.changePassword', {
        ...(old && { current: old }),
        ...(!remove && { password, ...(portable && { portable: true }) }),
      });
      setNotice(remove ? 'Master password removed' : 'Master password saved');
      onChange(status);
    } catch (error) {
      setProblem(messageOf(error));
    }
  };

  const settings = status.settings;
  const update = async (patch: Partial<NonNullable<VaultStatus['settings']>>) => {
    if (!settings) return;
    try {
      onChange(await call('vault.updateSettings', { ...settings, ...patch }));
    } catch (error) {
      setProblem(messageOf(error));
    }
  };

  return (
    <section className="panel" aria-label="Security">
      <p className="system-hint">{status.mode ? MODE_TEXT[status.mode] : ''}</p>
      <form className="panel-form" onSubmit={(e) => void change(e, false)} noValidate>
        {hasPassword && (
          <div className="system-form-group">
            <label htmlFor="sec-current">Current master password</label>
            <input
              id="sec-current"
              ref={current}
              className="system-input"
              type="password"
              autoComplete="current-password"
            />
          </div>
        )}
        <div className="system-form-row">
          <div className="system-form-group">
            <label htmlFor="sec-new">
              {hasPassword ? 'New master password' : 'Master password'}
            </label>
            <input
              id="sec-new"
              ref={next}
              className="system-input"
              type="password"
              autoComplete="new-password"
            />
          </div>
          <div className="system-form-group">
            <label htmlFor="sec-confirm">Repeat</label>
            <input
              id="sec-confirm"
              ref={confirm}
              className="system-input"
              type="password"
              autoComplete="new-password"
            />
          </div>
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
        <div className="panel-row">
          <button type="submit" className="system-btn primary inline">
            {hasPassword ? 'Change password' : 'Set master password'}
          </button>
          {hasPassword && status.osAvailable && (
            <button
              type="button"
              className="system-btn inline"
              onClick={(e) => void change(e, true)}
            >
              Remove master password
            </button>
          )}
        </div>
      </form>

      {settings && (
        <div className="panel-form">
          <div className="system-form-group">
            <label htmlFor="sec-autolock">Lock the vault after</label>
            <select
              id="sec-autolock"
              className="system-input"
              value={settings.autoLockMinutes}
              onChange={(e) => void update({ autoLockMinutes: Number(e.target.value) })}
            >
              {AUTO_LOCK.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes === 0 ? 'Never' : `${minutes} minutes without input`}
                </option>
              ))}
            </select>
          </div>
          <label className="system-check">
            <input
              type="checkbox"
              checked={settings.lockOnSleep}
              onChange={(e) => void update({ lockOnSleep: e.target.checked })}
            />
            Lock when the computer sleeps or the screen locks
          </label>
        </div>
      )}
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
    </section>
  );
}
