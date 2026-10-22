/**
 * The app shell: vault set-up and unlock, the tab bar with the Hosts screen
 * and the terminal tabs, the favorites bar, the sessions dock, the switcher,
 * and the global keyboard shortcuts.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { HostInfo, KeyInfo, PinInfo, VaultStatus } from '../../shared/ipc.js';
import { call, messageOf } from './api.js';
import { AboutDialog } from './components/AboutDialog.js';
import { FileBrowser } from './components/FileBrowser.js';
import { ForwardsPanel } from './components/Forwards.js';
import { HostKeysPanel } from './components/HostKeysPanel.js';
import { Icon } from './components/icons.js';
import { KeysPanel } from './components/KeysPanel.js';
import { NoticeIsland } from './components/NoticeIsland.js';
import { ProbeDialogs } from './components/ProbeDialogs.js';
import { QuickConnect } from './components/QuickConnect.js';
import { SecurityPanel } from './components/SecurityPanel.js';
import { SessionsDock } from './components/SessionsDock.js';
import { SessionSwitcher } from './components/SessionSwitcher.js';
import { ShortcutsDialog } from './components/ShortcutsDialog.js';
import { FavoritesBar, TabStrip } from './components/TabStrip.js';
import { TerminalView } from './components/TerminalView.js';
import { ThemeDialog } from './components/ThemeDialog.js';
import { ResetVaultDialog, SetupScreen, UnlockScreen } from './components/VaultScreens.js';
import { HostsPanel } from './hosts/HostsPanel.js';
import { UpdatePanel } from './components/UpdatePanel.js';
import { updates, useUpdates } from './updates.js';
import { SessionEvents } from './terminal/connection.js';
import { digitKey, isLetterKey, isTextField, zoomKey } from './terminal/keys.js';
import { MAX_FAVORITES_SHOWN, Workspace } from './terminal/workspace.js';

const api = window.quqa;
const events = new SessionEvents(api);
const workspace = new Workspace(api, events);

type Section = 'hosts' | 'tunnels' | 'keys' | 'pins' | 'security';
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'hosts', label: 'Hosts' },
  { id: 'tunnels', label: 'Tunnels' },
  { id: 'keys', label: 'Keys' },
  { id: 'pins', label: 'Host keys' },
  { id: 'security', label: 'Security' },
];

export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('hosts');
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [pins, setPins] = useState<{ pins: PinInfo[]; hashed: number }>({ pins: [], hashed: 0 });
  const [quickConnect, setQuickConnect] = useState(false);
  const [theme, setTheme] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [about, setAbout] = useState(false);
  const [updatePanel, setUpdatePanel] = useState(false);
  const updateState = useUpdates();
  /** After "Start over": where the old vault was moved. */
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  useSyncExternalStore(workspace.subscribe, workspace.getVersion);

  const refresh = useCallback(() => {
    call('vault.status', {}).then(
      (value) => {
        setStatus(value);
        setFailure(null);
      },
      (error: unknown) => setFailure(messageOf(error)),
    );
  }, []);

  const loadHosts = useCallback(() => {
    call('hosts.list', {}).then(
      ({ hosts }) => {
        setHosts(hosts);
        workspace.setHosts(hosts);
      },
      () => undefined,
    );
  }, []);

  const loadLists = useCallback(() => {
    call('keys.list', {}).then(
      ({ keys }) => setKeys(keys),
      () => setKeys([]),
    );
    call('hostKeys.list', {}).then(setPins, () => setPins({ pins: [], hashed: 0 }));
    loadHosts();
  }, [loadHosts]);

  useEffect(() => {
    refresh();
    return api.onVaultChange(refresh);
  }, [refresh]);

  // The update check runs in main; the top bar shows its result.
  useEffect(() => updates.start(), []);

  // Files dropped outside a drop target must not open in the window.
  useEffect(() => {
    const stop = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  const unlocked = status?.state === 'unlocked';
  useEffect(() => {
    if (!unlocked) return;
    loadLists();
    void Promise.all([call('hosts.list', {}), call('ui.get', {})]).then(
      ([{ hosts }, ui]) => {
        setHosts(hosts);
        workspace.load(hosts, ui);
      },
      () => undefined,
    );
  }, [unlocked, loadLists]);

  // The UI smoke test reads terminal text through these (WebGL draws no DOM text).
  useEffect(() => {
    if (!api.testHooks) return;
    window.__quqaTest = {
      text: () => workspace.activeSession()?.text() ?? '',
      state: () => workspace.activeSession()?.getSnapshot().state ?? 'none',
      renderer: () => workspace.activeSession()?.getSnapshot().renderer ?? 'none',
      tmux: () => workspace.activeSession()?.getSnapshot().tmux ?? null,
      tabs: () => workspace.tabs.length,
      local: () => workspace.activeSession()?.isLocal ?? false,
      title: () => workspace.activeSession()?.getSnapshot().title ?? '',
      panes: () => workspace.currentTab()?.panes.length ?? 0,
      useDomRenderer: () => workspace.activeSession()?.useDomRenderer(),
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!unlocked || event.type !== 'keydown') return;
      const mod = event.ctrlKey || event.metaKey;
      const dialog = document.querySelector('dialog[open]') !== null;
      const handled = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      const letter = (key: string) => isLetterKey(event, key);

      if (mod && event.shiftKey && !event.altKey && letter('k')) {
        if (dialog) return;
        handled();
        workspace.setSwitcherOpen(!workspace.switcherOpen);
        return;
      }
      if (dialog || workspace.switcherOpen) return;
      if (mod && !event.shiftKey && !event.altKey && letter('k')) {
        if (isTextField(event.target)) return;
        handled();
        workspace.setSwitcherOpen(true);
        return;
      }
      if (event.key === 'F11') {
        handled();
        api.toggleFullScreen();
        return;
      }
      if (event.key === 'F1') {
        handled();
        setShortcuts(true);
        return;
      }
      if (mod && !event.altKey && event.key === 'Tab') {
        handled();
        workspace.cycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      if (mod && !event.altKey && (event.key === 'PageDown' || event.key === 'PageUp')) {
        if (event.shiftKey) return;
        handled();
        workspace.cycleTab(event.key === 'PageDown' ? 1 : -1);
        return;
      }
      if (event.altKey && event.shiftKey && !mod) {
        const digit = digitKey(event);
        if (digit !== null && digit <= MAX_FAVORITES_SHOWN) {
          const favorite = workspace.favorites()[digit - 1];
          if (favorite) {
            handled();
            workspace.openFavorite(favorite);
          }
          return;
        }
      }
      if (mod && !event.altKey && !event.shiftKey) {
        const zoom = zoomKey(event);
        if (zoom !== null) {
          handled();
          workspace.zoom(zoom);
          return;
        }
      }
      if (!(mod && event.shiftKey && !event.altKey)) return;
      if (letter('o')) {
        handled();
        setQuickConnect(true);
      } else if (letter('s')) {
        handled();
        workspace.setDockOpen(!workspace.dockOpen);
      } else if (letter('h')) {
        handled();
        workspace.showHome();
      } else if (letter('t')) {
        handled();
        workspace.newTerminal();
      } else if (event.code === 'Backquote' || event.key === '~' || event.key === '`') {
        handled();
        workspace.openLocal();
      } else if (letter('d') || letter('e')) {
        handled();
        const split = letter('d') ? 'h' : 'v';
        const tab = workspace.currentTab();
        if (tab && tab.panes.length === 2) workspace.setSplit(tab.id, split);
        else workspace.duplicateActive(split);
      } else if (letter('w')) {
        handled();
        const session = workspace.activeSession();
        if (session) workspace.closeTerm(session.tag);
      } else if (letter('f')) {
        if (!workspace.activeSession()) return;
        handled();
        window.dispatchEvent(new Event('quqa:search'));
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const tab = workspace.currentTab();
        if (!tab || tab.panes.length < 2) return;
        handled();
        workspace.cyclePane();
      }
    };
    // Capture: runs before xterm sees the key.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [unlocked]);

  if (!status) {
    return (
      <div className="connect-screen">
        {failure ? (
          <div className="vault-failure">
            <p className="system-error" role="alert">
              {failure}
            </p>
            <button type="button" className="link-btn" onClick={() => setResetting(true)}>
              Start over with a new vault…
            </button>
            {resetting && (
              <ResetVaultDialog
                onClose={() => setResetting(false)}
                onReset={(next, backup) => {
                  setResetting(false);
                  setFailure(null);
                  setMovedTo(backup);
                  setStatus(next);
                }}
              />
            )}
          </div>
        ) : (
          <p className="system-hint">Opening the vault…</p>
        )}
      </div>
    );
  }

  if (status.state === 'absent') {
    return (
      <SetupScreen
        status={status}
        movedTo={movedTo}
        onDone={(next) => {
          setMovedTo(null);
          setStatus(next);
        }}
      />
    );
  }
  const reset = (next: VaultStatus, backup: string | null) => {
    workspace.closeAll();
    setMovedTo(backup);
    setStatus(next);
  };
  if (!unlocked && workspace.terms.size === 0) {
    return <UnlockScreen status={status} onDone={setStatus} onReset={reset} />;
  }

  const lock = () => {
    workspace.flushSave();
    void call('vault.lock', {}).then(setStatus, refresh);
  };
  const home = workspace.activeTab === null;

  return (
    <>
      <div className="app-shell" inert={!unlocked}>
        <TabStrip
          workspace={workspace}
          onQuickConnect={() => setQuickConnect(true)}
          onTheme={() => setTheme(true)}
          onShortcuts={() => setShortcuts(true)}
          onAbout={() => setAbout(true)}
          onUpdates={() => {
            if (updateState?.available) {
              setUpdatePanel(true);
              return;
            }
            // About shows the result (and the automatic-check setting).
            void updates.check().catch(() => undefined);
            setAbout(true);
          }}
          onLock={lock}
        />
        <FavoritesBar workspace={workspace} />
        <div className="app-main">
          <main className="app-content">
            {home && (
              <div className="home-screen">
                <div className="connect-card home-card">
                  <div className="connect-card-header home-header">
                    <Icon name="terminal" className="brand-icon" />
                    <nav className="home-tabs" role="tablist" aria-label="Sections">
                      {SECTIONS.map(({ id, label }) => (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          aria-selected={section === id}
                          onClick={() => {
                            setSection(id);
                            loadLists();
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </nav>
                  </div>
                  {section === 'hosts' && (
                    <HostsPanel
                      hosts={workspace.hosts}
                      keys={keys}
                      workspace={workspace}
                      onChange={loadLists}
                      onManageKeys={() => setSection('keys')}
                      onQuickConnect={() => setQuickConnect(true)}
                    />
                  )}
                  {section === 'tunnels' && (
                    <ForwardsPanel workspace={workspace} hosts={workspace.hosts} />
                  )}
                  {section === 'keys' && <KeysPanel keys={keys} onChange={loadLists} />}
                  {section === 'pins' && (
                    <HostKeysPanel pins={pins.pins} hashed={pins.hashed} onChange={loadLists} />
                  )}
                  {section === 'security' && <SecurityPanel status={status} onChange={setStatus} />}
                </div>
              </div>
            )}
            {workspace.tabs.map((tab) => (
              <TerminalView
                key={tab.id}
                tab={tab}
                workspace={workspace}
                visible={tab.id === workspace.activeTab}
              />
            ))}
            {!workspace.files && <NoticeIsland notices={workspace.notices} />}
          </main>
          {workspace.dockOpen && <SessionsDock workspace={workspace} />}
        </div>
        {workspace.switcherOpen && <SessionSwitcher workspace={workspace} />}
        {quickConnect && (
          <QuickConnect
            hosts={workspace.hosts}
            keys={keys}
            onClose={() => setQuickConnect(false)}
            onOpenHost={(hostId) => workspace.openHost(hostId)}
            onAdhoc={(target) => workspace.openAdhoc(target)}
            onSavedHost={(host) => {
              const next = [...hosts.filter((h) => h.id !== host.id), host];
              setHosts(next);
              workspace.setHosts(next);
            }}
          />
        )}
        {theme && (
          <ThemeDialog
            ui={workspace.ui}
            onClose={() => setTheme(false)}
            onApply={(change) => workspace.updateUi(change)}
          />
        )}
        {shortcuts && (
          <ShortcutsDialog
            onClose={() => setShortcuts(false)}
            onAbout={() => {
              setShortcuts(false);
              setAbout(true);
            }}
          />
        )}
        {about && <AboutDialog onClose={() => setAbout(false)} />}
        {updatePanel && <UpdatePanel onClose={() => setUpdatePanel(false)} />}
        {workspace.files && <FileBrowser workspace={workspace} view={workspace.files} />}
        {workspace.probes.map((probe, index) => (
          <ProbeDialogs key={index} probe={probe} onClose={() => workspace.closeProbe(probe)} />
        ))}
        {[...workspace.links.entries()].map(([hostId, link]) => (
          <ProbeDialogs key={hostId} probe={link} onClose={() => workspace.releaseLink(hostId)} />
        ))}
      </div>
      {!unlocked && (
        <div className="vault-overlay">
          <UnlockScreen status={status} onDone={setStatus} onReset={reset} />
        </div>
      )}
    </>
  );
}
