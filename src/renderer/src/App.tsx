import { useCallback, useEffect, useState } from 'react';
import type { KeyInfo, PinInfo, VaultStatus } from '../../shared/ipc.js';
import { call, messageOf } from './api.js';
import { HostKeysPanel } from './components/HostKeysPanel.js';
import { Icon } from './components/icons.js';
import { KeysPanel } from './components/KeysPanel.js';
import { QuickConnect } from './components/QuickConnect.js';
import { SecurityPanel } from './components/SecurityPanel.js';
import { TerminalScreen } from './components/TerminalScreen.js';
import { SetupScreen, UnlockScreen } from './components/VaultScreens.js';
import { SessionEvents, TerminalSession, type Target } from './terminal/connection.js';

const api = window.quqa;
const events = new SessionEvents(api);

type Tab = 'connect' | 'keys' | 'hosts' | 'security';
const TABS: { id: Tab; label: string }[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'keys', label: 'Keys' },
  { id: 'hosts', label: 'Host keys' },
  { id: 'security', label: 'Security' },
];

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [lastTarget, setLastTarget] = useState<Partial<Target>>({});
  const [tab, setTab] = useState<Tab>('connect');
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [pins, setPins] = useState<{ pins: PinInfo[]; hashed: number }>({ pins: [], hashed: 0 });

  const refresh = useCallback(() => {
    call('vault.status', {}).then(
      (value) => {
        setStatus(value);
        setFailure(null);
      },
      (error: unknown) => setFailure(messageOf(error)),
    );
  }, []);

  const loadLists = useCallback(() => {
    call('keys.list', {}).then(
      ({ keys }) => setKeys(keys),
      () => setKeys([]),
    );
    call('hostKeys.list', {}).then(setPins, () => setPins({ pins: [], hashed: 0 }));
  }, []);

  useEffect(() => {
    refresh();
    return api.onVaultChange(refresh);
  }, [refresh]);

  const unlocked = status?.state === 'unlocked';
  useEffect(() => {
    if (unlocked) loadLists();
  }, [unlocked, loadLists]);

  useEffect(() => {
    if (!api.testHooks) return;
    window.__quqaTest = {
      text: () => session?.text() ?? '',
      state: () => session?.getSnapshot().state ?? 'none',
      renderer: () => session?.getSnapshot().renderer ?? 'none',
    };
  }, [session]);

  if (!status) {
    return (
      <div className="connect-screen">
        {failure ? (
          <p className="system-error" role="alert">
            {failure}
          </p>
        ) : (
          <p className="system-hint">Opening the vault…</p>
        )}
      </div>
    );
  }

  if (status.state === 'absent') return <SetupScreen status={status} onDone={setStatus} />;

  const lock = () => void call('vault.lock', {}).then(setStatus, refresh);

  if (session) {
    return (
      <>
        <div className="app-content" inert={!unlocked}>
          <TerminalScreen
            session={session}
            onClose={() => {
              session.dispose();
              setSession(null);
              if (unlocked) loadLists();
            }}
          />
        </div>
        {!unlocked && (
          <div className="vault-overlay">
            <UnlockScreen status={status} onDone={setStatus} />
          </div>
        )}
      </>
    );
  }

  if (!unlocked) return <UnlockScreen status={status} onDone={setStatus} />;

  return (
    <div className="connect-screen">
      <div className="connect-card home-card">
        <div className="connect-card-header home-header">
          <Icon name="terminal" className="brand-icon" />
          <nav className="home-tabs" role="tablist" aria-label="Sections">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => {
                  setTab(id);
                  loadLists();
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <button type="button" className="link-btn lock-btn" onClick={lock} title="Lock the vault">
            <Icon name="lock" /> Lock
          </button>
        </div>
        {tab === 'connect' && (
          <QuickConnect
            initial={lastTarget}
            keys={keys}
            onManageKeys={() => setTab('keys')}
            onConnect={(target) => {
              setLastTarget(target);
              setSession(new TerminalSession(api, events, target));
            }}
          />
        )}
        {tab === 'keys' && <KeysPanel keys={keys} onChange={loadLists} />}
        {tab === 'hosts' && (
          <HostKeysPanel pins={pins.pins} hashed={pins.hashed} onChange={loadLists} />
        )}
        {tab === 'security' && <SecurityPanel status={status} onChange={setStatus} />}
      </div>
    </div>
  );
}
