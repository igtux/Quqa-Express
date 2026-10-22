/**
 * The top bar: the Hosts tab, one tab per terminal tab (drag to reorder,
 * double-click to rename, middle-click or × to close, right-click for its
 * menu), + for Quick Connect, >_ for a local terminal (its arrow lists the
 * shells), and the app buttons (update badge, sessions dock, switcher and the
 * main menu: look, shortcuts, updates, About, lock). Below
 * it, the favorites bar: pinned sessions and favorite hosts, up to eight,
 * Alt+Shift+1…8.
 *
 * The favorites bar follows Jarvis NG's (apps/web/src/terminal/SessionsDock.tsx,
 * `tsd-favs`), same owner; desktop tabs are new.
 */
import { useState, useSyncExternalStore, type DragEvent } from 'react';
import type { ShellId } from '../../../shared/ipc.js';
import type { Tab, Workspace } from '../terminal/workspace.js';
import { MAX_FAVORITES_SHOWN } from '../terminal/workspace.js';
import { summarize } from '../terminal/dockModel.js';
import { Icon } from './icons.js';
import { LOCAL_TOOLTIP, STATUS_CLASS } from './TerminalView.js';
import { useUpdates } from '../updates.js';
import { below, Menu } from './Menu.js';
import type { MenuIconName } from './menuIcons.js';
import type { MenuTone } from './menuModel.js';
import { UpdateBadge } from './UpdatePanel.js';

export function TabStrip({
  workspace,
  onQuickConnect,
  onTheme,
  onShortcuts,
  onAbout,
  onUpdates,
  onLock,
}: {
  workspace: Workspace;
  onQuickConnect(): void;
  onTheme(): void;
  onShortcuts(): void;
  onAbout(): void;
  /** The update panel when a newer version is out, otherwise a check now (About). */
  onUpdates(): void;
  onLock(): void;
}) {
  useSyncExternalStore(workspace.subscribe, workspace.getVersion);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const rows = workspace.rows();
  const attention = rows.filter((r) => r.attention).length;
  const { text: summary } = summarize(rows);

  const drop = (event: DragEvent, index: number) => {
    event.preventDefault();
    if (dragging !== null) workspace.moveTab(dragging, index);
    setDragging(null);
    setOver(null);
  };

  return (
    <header className="app-bar">
      <div className="tab-strip" role="tablist" aria-label="Terminals">
        <button
          type="button"
          role="tab"
          aria-selected={workspace.activeTab === null}
          className={`app-tab home${workspace.activeTab === null ? ' active' : ''}`}
          onClick={() => workspace.showHome()}
          title="Hosts, keys and security"
        >
          <Icon name="server" />
          <span className="app-tab-name">Hosts</span>
        </button>
        {workspace.tabs.map((tab, index) => (
          <TabButton
            key={tab.id}
            tab={tab}
            index={index}
            workspace={workspace}
            renaming={renaming === tab.id}
            onRename={(on) => setRenaming(on ? tab.id : null)}
            dragOver={over === index && dragging !== null && dragging !== index}
            onDragStart={(event) => {
              setDragging(index);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', tab.id);
            }}
            onDragOver={(event) => {
              if (dragging === null) return;
              event.preventDefault();
              setOver(index);
            }}
            onDrop={(event) => drop(event, index)}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
          />
        ))}
        <button
          type="button"
          className="app-tab-new"
          title="New connection (Ctrl+Shift+O)"
          aria-label="New connection"
          onClick={onQuickConnect}
        >
          <Icon name="plus" />
        </button>
        <LocalButton workspace={workspace} />
      </div>
      <div className="app-bar-actions">
        <UpdateBadge />
        <button
          type="button"
          className={`app-bar-btn dock-btn${workspace.dockOpen ? ' on' : ''}${attention ? ' attention' : ''}`}
          title={`Sessions: ${summary} (Ctrl+Shift+S)`}
          aria-label="Sessions"
          aria-pressed={workspace.dockOpen}
          onClick={() => workspace.setDockOpen(!workspace.dockOpen)}
        >
          <Icon name="layers" />
          {rows.length > 0 && <span className="app-bar-count">{rows.length}</span>}
          {attention > 0 && <span className="app-bar-attn">{attention}</span>}
        </button>
        <button
          type="button"
          className="app-bar-btn"
          title="Switch session (Ctrl+Shift+K)"
          aria-label="Switch session"
          onClick={() => workspace.setSwitcherOpen(true)}
        >
          <Icon name="search" />
        </button>
        <MainMenu
          onTheme={onTheme}
          onShortcuts={onShortcuts}
          onAbout={onAbout}
          onUpdates={onUpdates}
          onLock={onLock}
        />
      </div>
    </header>
  );
}

function TabButton({
  tab,
  index,
  workspace,
  renaming,
  onRename,
  dragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  tab: Tab;
  index: number;
  workspace: Workspace;
  renaming: boolean;
  onRename(on: boolean): void;
  dragOver: boolean;
  onDragStart(event: DragEvent): void;
  onDragOver(event: DragEvent): void;
  onDrop(event: DragEvent): void;
  onDragEnd(): void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const sessions = tab.panes.flatMap((tag) => {
    const session = workspace.terms.get(tag);
    return session ? [session] : [];
  });
  const first = sessions[tab.active] ?? sessions[0];
  if (!first) return null;
  const snapshots = sessions.map((s) => s.getSnapshot());
  const active = workspace.activeTab === tab.id;
  const name = sessions.map((s) => workspace.nameOf(s)).join(' | ');
  const attention = !active && snapshots.some((s) => s.attention);
  const unread = !active && snapshots.some((s) => s.unread);
  const busy = snapshots.some((s) => s.busy);
  const state = first.getSnapshot().state;

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className={`app-tab${active ? ' active' : ''}${attention ? ' attention' : ''}${dragOver ? ' drag-over' : ''}`}
      draggable={!renaming}
      data-testid="app-tab"
      title={`${name}${index < 9 ? '' : ''}`}
      onClick={(event) => {
        // The second click of a double-click (rename) must not move focus to the terminal.
        if (event.detail < 2) workspace.showTab(tab.id);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') workspace.showTab(tab.id);
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          setMenu({ x: box.left, y: box.bottom + 4 });
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!renaming) setMenu({ x: event.clientX, y: event.clientY });
      }}
      onDoubleClick={() => onRename(true)}
      onAuxClick={(event) => {
        if (event.button === 1) workspace.closeTab(tab.id);
      }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={(() => {
        const color = first.hostId ? workspace.host(first.hostId)?.color : '';
        return color ? ({ '--tab-color': color } as React.CSSProperties) : undefined;
      })()}
    >
      <span className={`app-tab-dot ${STATUS_CLASS[state]}${busy ? ' busy' : ''}`} />
      {first.isLocal && <Icon name="terminal" className="app-tab-local" />}
      {renaming ? (
        <input
          className="app-tab-rename"
          aria-label="Session name"
          autoFocus
          defaultValue={workspace.nameOf(first)}
          maxLength={60}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              workspace.rename({ tag: first.tag }, event.currentTarget.value);
              onRename(false);
            } else if (event.key === 'Escape') onRename(false);
          }}
          onBlur={(event) => {
            workspace.rename({ tag: first.tag }, event.currentTarget.value);
            onRename(false);
          }}
        />
      ) : (
        <span className="app-tab-name">{name}</span>
      )}
      {tab.panes.length === 2 && (
        <Icon name={tab.split === 'v' ? 'splitV' : 'splitH'} className="app-tab-split" />
      )}
      {(attention || unread) && <span className={`app-tab-mark${attention ? ' attention' : ''}`} />}
      <button
        type="button"
        className="app-tab-close"
        title="Close (tmux sessions keep running)"
        aria-label={`Close ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          workspace.closeTab(tab.id);
        }}
      >
        <Icon name="close" />
      </button>
      {menu && (
        <TabMenu
          tab={tab}
          name={name}
          workspace={workspace}
          at={menu}
          onClose={() => setMenu(null)}
          onRename={() => onRename(true)}
        />
      )}
    </div>
  );
}

/** Right-click on a tab: the few things people do with one, in plain words. */
function TabMenu({
  tab,
  name,
  workspace,
  at,
  onClose,
  onRename,
}: {
  tab: Tab;
  name: string;
  workspace: Workspace;
  at: { x: number; y: number };
  onClose(): void;
  onRename(): void;
}) {
  const tag = tab.panes[tab.active] ?? tab.panes[0];
  const session = tag ? workspace.terms.get(tag) : undefined;
  if (!session) return null;
  const local = session.isLocal;
  const single = tab.panes.length === 1;
  /** Actions on "the active terminal" act on this tab's. */
  const onThis = (action: () => void) => () => {
    workspace.showTab(tab.id);
    action();
  };
  const tmux = session.getSnapshot().tmux;
  const favorite = tmux
    ? workspace.isPinned({ tag: session.tag, session: tmux })
    : session.hostId
      ? workspace.isHostFavorite(session.hostId)
      : workspace.isPinned({ tag: session.tag, session: null });
  return (
    <Menu
      label={`${name} tab`}
      title={name}
      at={at}
      onClose={onClose}
      entries={[
        {
          label: 'Rename…',
          hint: 'Or double-click the tab',
          icon: 'pencil',
          tone: 'blue',
          onSelect: onRename,
        },
        {
          label: local ? 'Another local terminal' : 'Another terminal here',
          hint: local ? 'Same shell, same folder' : 'Same host, same login',
          icon: 'copyPlus',
          tone: 'green',
          shortcut: 'Ctrl+Shift+T',
          onSelect: onThis(() => workspace.duplicateActive()),
        },
        single && {
          label: 'Split side by side',
          icon: 'columns',
          tone: 'teal',
          shortcut: 'Ctrl+Shift+D',
          onSelect: onThis(() => workspace.duplicateActive('h')),
        },
        single && {
          label: 'Split one above the other',
          icon: 'rows',
          tone: 'teal',
          shortcut: 'Ctrl+Shift+E',
          onSelect: onThis(() => workspace.duplicateActive('v')),
        },
        !single && {
          label: tab.split === 'h' ? 'Stack the panes' : 'Panes side by side',
          icon: tab.split === 'h' ? 'rows' : 'columns',
          tone: 'teal',
          onSelect: () => workspace.setSplit(tab.id, tab.split === 'h' ? 'v' : 'h'),
        },
        !local && {
          label: 'Files',
          hint: 'Browse, upload, download',
          icon: 'folderOpen',
          tone: 'amber',
          onSelect: () => workspace.openFilesForTerminal(session.tag),
        },
        {
          label: favorite ? 'Remove from favorites' : 'Add to favorites',
          icon: favorite ? 'starOff' : 'star',
          tone: 'amber',
          onSelect: onThis(() => workspace.toggleActiveFavorite()),
        },
        { kind: 'separator' },
        workspace.tabs.length > 1 && {
          label: 'Close the other tabs',
          icon: 'copyX',
          tone: 'slate',
          onSelect: () => {
            for (const other of [...workspace.tabs]) {
              if (other.id !== tab.id) workspace.closeTab(other.id);
            }
          },
        },
        {
          label: 'Close tab',
          hint: local
            ? 'Ends the shell and its programs'
            : tmux
              ? 'tmux keeps running on the host'
              : 'Ends the session',
          icon: 'x',
          tone: 'red',
          ...(single && { shortcut: 'Ctrl+Shift+W' }),
          onSelect: () => workspace.closeTab(tab.id),
        },
      ]}
    />
  );
}

export function FavoritesBar({ workspace }: { workspace: Workspace }) {
  useSyncExternalStore(workspace.subscribe, workspace.getVersion);
  const favorites = workspace.favorites().slice(0, MAX_FAVORITES_SHOWN);
  if (favorites.length === 0) return null;
  const current = workspace.activeSession()?.tag;
  return (
    <nav className="favorites-bar" aria-label="Favorites">
      <Icon name="star" filled className="favorites-icon" />
      {favorites.map((favorite, index) => (
        <button
          key={favorite.key}
          type="button"
          className={`fav-chip fav-${favorite.state}${favorite.tag && favorite.tag === current ? ' current' : ''}${favorite.busy ? ' busy' : ''}${favorite.attention ? ' attention' : ''}`}
          title={`${favorite.name}${favorite.session ? ` — ${favorite.hostName}` : ' (new terminal)'} · Alt+Shift+${index + 1}`}
          onClick={() => workspace.openFavorite(favorite)}
        >
          <span className="fav-dot" aria-hidden="true" />
          <span className="fav-name">{favorite.name}</span>
          {favorite.session === null && favorite.tag === null && (
            <Icon name="plus" className="fav-new" />
          )}
        </button>
      ))}
    </nav>
  );
}

/**
 * "New local terminal" (Ctrl+Shift+`): the default shell at a click; the
 * arrow lists every shell main found, a folder to start in, and the default.
 */
function LocalButton({ workspace }: { workspace: Workspace }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const shells = workspace.shells;
  if (shells.length === 0) return null;
  const current = shells.find((s) => s.id === workspace.defaultShell) ?? shells[0];
  return (
    <div className="app-local">
      <button
        type="button"
        className="app-tab-new app-local-open"
        title={`New local terminal: ${current?.name ?? ''} (Ctrl+Shift+\`)`}
        aria-label="New local terminal"
        onClick={() => workspace.openLocal()}
      >
        <Icon name="terminal" />
      </button>
      <button
        type="button"
        className="app-tab-new app-local-more"
        title="Local shells"
        aria-label="Local shells"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(event) => {
          setMenu(menu ? null : below(event.currentTarget));
        }}
      >
        <Icon name="chevronDown" />
      </button>
      {menu && <LocalMenu workspace={workspace} at={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** A friendly icon per shell. */
const SHELL_ICONS: Record<ShellId, { icon: MenuIconName; tone: MenuTone; hint: string }> = {
  pwsh: { icon: 'zap', tone: 'blue', hint: 'PowerShell 7, the modern one' },
  powershell: { icon: 'shell', tone: 'blue', hint: 'Built into Windows' },
  cmd: { icon: 'window', tone: 'slate', hint: 'The classic Command Prompt' },
  wsl: { icon: 'boxes', tone: 'amber', hint: 'Linux on Windows' },
  login: { icon: 'shell', tone: 'green', hint: 'Your login shell' },
};

function LocalMenu({
  workspace,
  at,
  onClose,
}: {
  workspace: Workspace;
  at: { x: number; y: number };
  onClose(): void;
}) {
  const shells = workspace.shells;
  const chosen = workspace.defaultShell ?? shells[0]?.id ?? null;
  return (
    <Menu
      label="Local shells"
      className="local-menu"
      title={<span title={LOCAL_TOOLTIP}>On this computer · no tmux</span>}
      at={at}
      onClose={onClose}
      entries={[
        ...shells.map((shell) => ({
          label: shell.name,
          icon: SHELL_ICONS[shell.id].icon,
          tone: SHELL_ICONS[shell.id].tone,
          hint: SHELL_ICONS[shell.id].hint,
          ...(shell.id === chosen && { badge: 'default', shortcut: 'Ctrl+Shift+`' }),
          onSelect: () => workspace.openLocal({ shellId: shell.id }),
        })),
        { kind: 'separator' as const },
        {
          label: 'In a folder…',
          hint: 'Pick where the shell starts',
          icon: 'folderOpen' as const,
          tone: 'teal' as const,
          onSelect: () => void workspace.openLocalInFolder(),
        },
      ]}
      footer={
        shells.length > 1 && (
          <label className="app-menu-setting local-menu-setting">
            <span>Default shell</span>
            <select
              aria-label="Default shell"
              value={chosen ?? ''}
              onChange={(event) => {
                const shell = shells.find((s) => s.id === event.target.value);
                if (shell) void workspace.setDefaultShell(shell.id);
              }}
            >
              {shells.map((shell) => (
                <option key={shell.id} value={shell.id}>
                  {shell.name}
                </option>
              ))}
            </select>
          </label>
        )
      }
    />
  );
}

/** The app menu (☰ at the right of the top bar): fewer buttons, plain words. */
function MainMenu({
  onTheme,
  onShortcuts,
  onAbout,
  onUpdates,
  onLock,
}: {
  onTheme(): void;
  onShortcuts(): void;
  onAbout(): void;
  onUpdates(): void;
  onLock(): void;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const update = useUpdates();
  const available = update?.available ?? null;
  return (
    <>
      <button
        type="button"
        className={`app-bar-btn main-menu-btn${at ? ' on' : ''}`}
        title="Menu: look, shortcuts, updates, lock"
        aria-label="Main menu"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={(event) => setAt(at ? null : below(event.currentTarget, 'end', 280))}
      >
        <Icon name="menu" />
        {available && <span className="update-dot" aria-hidden="true" />}
      </button>
      {at && (
        <Menu
          label="Main menu"
          className="main-menu"
          at={at}
          onClose={() => setAt(null)}
          entries={[
            { kind: 'heading', label: 'Make it yours' },
            {
              label: 'Look and notifications',
              hint: 'Theme, colours, fonts, sounds',
              icon: 'palette',
              tone: 'pink',
              onSelect: onTheme,
            },
            { kind: 'heading', label: 'Help' },
            {
              label: 'Keyboard shortcuts',
              icon: 'keyboard',
              tone: 'blue',
              shortcut: 'F1',
              onSelect: onShortcuts,
            },
            available
              ? {
                  label: `Update to ${available.version}`,
                  hint: "What's new, then one click",
                  icon: 'gift',
                  tone: 'green',
                  badge: 'new',
                  onSelect: onUpdates,
                }
              : {
                  label: 'Check for updates',
                  icon: 'rocket',
                  tone: 'green',
                  onSelect: onUpdates,
                },
            {
              label: 'About quqa-express',
              icon: 'info',
              tone: 'violet',
              onSelect: onAbout,
            },
            { kind: 'separator' },
            {
              label: 'Lock',
              hint: 'Hide everything until you unlock',
              icon: 'lock',
              tone: 'amber',
              onSelect: onLock,
            },
          ]}
        />
      )}
    </>
  );
}
