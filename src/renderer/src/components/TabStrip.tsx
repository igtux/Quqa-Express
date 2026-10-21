/**
 * The top bar: the Hosts tab, one tab per terminal tab (drag to reorder,
 * double-click to rename, middle-click or × to close), + for Quick Connect,
 * and the app buttons (sessions dock, switcher, look, shortcuts, lock). Below
 * it, the favorites bar: pinned sessions and favorite hosts, up to eight,
 * Alt+Shift+1…8.
 *
 * The favorites bar follows Jarvis NG's (apps/web/src/terminal/SessionsDock.tsx,
 * `tsd-favs`), same owner; desktop tabs are new.
 */
import { useState, useSyncExternalStore, type DragEvent } from 'react';
import type { Tab, Workspace } from '../terminal/workspace.js';
import { MAX_FAVORITES_SHOWN } from '../terminal/workspace.js';
import { summarize } from '../terminal/dockModel.js';
import { Icon } from './icons.js';
import { STATUS_CLASS } from './TerminalView.js';

export function TabStrip({
  workspace,
  onQuickConnect,
  onTheme,
  onShortcuts,
  onLock,
}: {
  workspace: Workspace;
  onQuickConnect(): void;
  onTheme(): void;
  onShortcuts(): void;
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
      </div>
      <div className="app-bar-actions">
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
        <button
          type="button"
          className="app-bar-btn"
          title="Terminal look and notifications"
          aria-label="Terminal look and notifications"
          onClick={onTheme}
        >
          <Icon name="palette" />
        </button>
        <button
          type="button"
          className="app-bar-btn"
          title="Keyboard shortcuts (F1)"
          aria-label="Keyboard shortcuts"
          onClick={onShortcuts}
        >
          <Icon name="keyboard" />
        </button>
        <button
          type="button"
          className="app-bar-btn"
          title="Lock the vault"
          aria-label="Lock"
          onClick={onLock}
        >
          <Icon name="lock" />
        </button>
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
        if (event.key === 'Enter' || event.key === ' ') workspace.showTab(tab.id);
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
    </div>
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
