/**
 * The session switcher (Ctrl+Shift+K anywhere, also inside the terminal;
 * plain Ctrl+K only outside the terminal and text fields so the shell keeps
 * kill-line): fuzzy search over every session, keyboard navigation.
 *
 * Ported from Jarvis NG (apps/web/src/terminal/SessionSwitcher.tsx), same owner.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { dotClass, filterRows, rowName, type DockRow } from '../terminal/dockModel.js';
import type { Workspace } from '../terminal/workspace.js';

export function SessionSwitcher({ workspace }: { workspace: Workspace }) {
  useSyncExternalStore(workspace.subscribe, workspace.getVersion);
  const rows = workspace.rows();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => filterRows(rows, query), [rows, query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('.terminal-switcher-item.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const close = () => {
    workspace.setSwitcherOpen(false);
    setTimeout(() => workspace.activeSession()?.focus(), 0);
  };
  const choose = (row: DockRow | undefined) => {
    if (!row) return;
    workspace.setSwitcherOpen(false);
    workspace.openRow(row);
  };

  return (
    <div
      className="terminal-switcher-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="terminal-switcher" role="dialog" aria-label="Switch terminal session">
        <input
          autoFocus
          value={query}
          placeholder="Jump to a session — name, host, folder or program"
          aria-label="Find a session"
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelected((i) => Math.min(items.length - 1, i + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelected((i) => Math.max(0, i - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(items[selected]);
            }
          }}
        />
        <div className="terminal-switcher-list" ref={listRef} role="listbox">
          {items.length === 0 && (
            <div className="terminal-switcher-empty">
              {rows.length === 0 ? 'No terminal sessions yet' : 'No matching session'}
            </div>
          )}
          {items.map((row, index) => {
            const sub = [
              row.aliased ? row.hostName : '',
              row.tag ? (row.shown ? 'on screen' : 'open') : null,
              row.statusText,
              row.folder,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <div
                key={row.key}
                role="option"
                aria-selected={index === selected}
                className={`terminal-switcher-item${index === selected ? ' selected' : ''}`}
                onMouseMove={() => setSelected(index)}
                onClick={() => choose(row)}
              >
                <span className={`terminal-switcher-dot ${dotClass(row)}`} />
                <div className="terminal-switcher-main">
                  <span className="terminal-switcher-name">
                    {row.pinned ? '★ ' : ''}
                    {rowName(row)}
                  </span>
                  <span className="terminal-switcher-sub">{sub}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div className="terminal-switcher-hint">↑↓ to move · Enter to open · Esc to close</div>
      </div>
    </div>
  );
}
