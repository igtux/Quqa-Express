/**
 * The sessions dock: a side panel with every session (open here, or a tmux
 * session found on a host), grouped by host or as one list, with a fuzzy
 * filter, state dots, pins, the card menu (Open, Pin/Unpin, Rename, Close,
 * Forget, End on host), a hover preview of the last lines and Close all.
 *
 * Ported from Jarvis NG (apps/web/src/terminal/SessionsDock.tsx), same owner,
 * as a desktop side panel instead of the floating launcher.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  dotClass,
  filterRows,
  groupRows,
  rowName,
  rowNameInGroup,
  summarize,
  type DockRow,
} from '../terminal/dockModel.js';
import type { Workspace } from '../terminal/workspace.js';
import { Dialog } from './Dialog.js';
import { Icon } from './icons.js';
import { Menu } from './Menu.js';

const PREVIEW_DELAY_MS = 450;

export function SessionsDock({ workspace }: { workspace: Workspace }) {
  useSyncExternalStore(workspace.subscribe, workspace.getVersion);
  const rows = workspace.rows();
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ row: DockRow; x: number; y: number } | null>(null);
  const [preview, setPreview] = useState<{ row: DockRow; top: number } | null>(null);
  const [renaming, setRenaming] = useState<DockRow | null>(null);
  const [ending, setEnding] = useState<DockRow | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const previewTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const panelRef = useRef<HTMLElement>(null);

  const filtered = useMemo(() => filterRows(rows, filter), [rows, filter]);
  useEffect(() => () => clearTimeout(previewTimer.current), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || menu || document.querySelector('dialog[open]')) return;
      workspace.setDockOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, workspace]);

  const { text: summary } = summarize(rows);
  const hosts = new Set(rows.map((r) => r.hostId ?? r.hostName));
  const grouped = workspace.ui.groupDock && hosts.size >= 2;

  const open = (row: DockRow) => {
    setMenu(null);
    workspace.openRow(row);
  };
  const showPreview = (row: DockRow, element: HTMLElement) => {
    clearTimeout(previewTimer.current);
    if (!row.tag) return;
    previewTimer.current = setTimeout(
      () => setPreview({ row, top: element.getBoundingClientRect().top }),
      PREVIEW_DELAY_MS,
    );
  };
  const hidePreview = () => {
    clearTimeout(previewTimer.current);
    setPreview(null);
  };

  const renderRow = (row: DockRow, inGroup: boolean) => (
    <div
      key={row.key}
      role="listitem"
      tabIndex={0}
      className={`tsd-row tsd-${row.state}${row.shown ? ' shown' : ''}${row.attention ? ' attention' : ''}${row.busy ? ' busy' : ''}`}
      data-testid="dock-row"
      onClick={() => open(row)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') open(row);
        if (event.key === 'ContextMenu') {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ row, x: rect.left, y: rect.bottom });
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        hidePreview();
        setMenu({ row, x: event.clientX, y: event.clientY });
      }}
      onMouseEnter={(event) => showPreview(row, event.currentTarget)}
      onMouseLeave={hidePreview}
    >
      <span className={`terminal-switcher-dot ${dotClass(row)}`} />
      <div className="tsd-row-main">
        <span className="tsd-row-name">
          {inGroup ? rowNameInGroup(row) : rowName(row)}
          {row.unread && <span className="tsd-unread" title="New output" />}
          {row.attention && <Icon name="bell" className="tsd-attn" />}
        </span>
        <span className="tsd-row-sub">
          {[!inGroup && row.aliased ? row.hostName : '', row.statusText, row.folder]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <button
        type="button"
        className={`tsd-pin${row.pinned ? ' on' : ''}`}
        title={row.pinned ? 'Unpin' : 'Pin to the favorites bar'}
        aria-label={row.pinned ? `Unpin ${rowName(row)}` : `Pin ${rowName(row)}`}
        aria-pressed={row.pinned}
        onClick={(event) => {
          event.stopPropagation();
          workspace.togglePin(row);
        }}
      >
        <Icon name="star" filled={row.pinned} />
      </button>
      <button
        type="button"
        className="tsd-more"
        title="More"
        aria-label={`More for ${rowName(row)}`}
        onClick={(event) => {
          event.stopPropagation();
          hidePreview();
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ row, x: rect.right, y: rect.bottom });
        }}
      >
        <Icon name="more" />
      </button>
    </div>
  );

  return (
    <aside className="sessions-dock" ref={panelRef} role="dialog" aria-label="Sessions">
      <div className="tsd-head">
        <div className="tsd-heading">
          <span className="tsd-title">Sessions</span>
          <span className="tsd-summary">{summary}</span>
        </div>
        <div className="tsd-head-actions">
          <button
            type="button"
            className={`icon-btn${workspace.ui.groupDock ? ' on' : ''}`}
            title={workspace.ui.groupDock ? 'Show as one list' : 'Group by host'}
            aria-pressed={workspace.ui.groupDock}
            aria-label="Group by host"
            onClick={() => workspace.updateUi({ groupDock: !workspace.ui.groupDock })}
          >
            <Icon name="layers" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Refresh sessions from hosts"
            aria-label="Refresh"
            onClick={() => workspace.refreshFound()}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Close panel (Esc)"
            aria-label="Close panel"
            onClick={() => workspace.setDockOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
      <input
        className="tsd-filter"
        value={filter}
        placeholder="Filter by name, host, folder, program…"
        aria-label="Filter sessions"
        autoFocus
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (filter) setFilter('');
            else workspace.setDockOpen(false);
          } else if (event.key === 'Enter') {
            const first = filtered[0];
            if (first) open(first);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            panelRef.current?.querySelector<HTMLElement>('.tsd-row')?.focus();
          }
        }}
      />
      <div className="tsd-list" role="list" aria-label="Sessions list">
        {rows.length === 0 && (
          <div className="tsd-empty">
            No sessions yet. Open a terminal from Hosts; resumable (tmux) sessions on your hosts
            show here too.
          </div>
        )}
        {rows.length > 0 && filtered.length === 0 && (
          <div className="tsd-empty">No sessions match</div>
        )}
        {grouped
          ? groupRows(filtered).map((group) => {
              const isCollapsed = collapsed.has(group.hostId) && !filter.trim();
              const attention = group.rows.filter((r) => r.attention).length;
              return (
                <section key={group.hostId} className="tsd-group">
                  <button
                    type="button"
                    className={`tsd-group-head${isCollapsed ? ' collapsed' : ''}`}
                    aria-expanded={!isCollapsed}
                    onClick={() => {
                      const next = new Set(collapsed);
                      if (next.has(group.hostId)) next.delete(group.hostId);
                      else next.add(group.hostId);
                      setCollapsed(next);
                    }}
                  >
                    <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} />
                    <span className="tsd-group-name">{group.name}</span>
                    <span className="tsd-group-count">{group.rows.length}</span>
                    {attention > 0 && <span className="tsd-group-attn">{attention}</span>}
                  </button>
                  {!isCollapsed && group.rows.map((row) => renderRow(row, true))}
                </section>
              );
            })
          : filtered.map((row) => renderRow(row, false))}
      </div>
      <div className="tsd-foot">
        <button
          type="button"
          className="link-btn"
          disabled={workspace.terms.size === 0}
          onClick={() => setClosingAll(true)}
        >
          Close all
        </button>
        <span className="tsd-kbd">Ctrl+Shift+K to switch</span>
      </div>

      {preview?.row.tag && (
        <Preview
          lines={workspace.terms.get(preview.row.tag)?.previewLines(18) ?? []}
          top={preview.top}
          title={rowName(preview.row)}
        />
      )}
      {menu && (
        <CardMenu
          row={menu.row}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onOpen={() => open(menu.row)}
          onPin={() => {
            workspace.togglePin(menu.row);
            setMenu(null);
          }}
          onRename={() => {
            setRenaming(menu.row);
            setMenu(null);
          }}
          onCloseTerm={() => {
            if (menu.row.tag) workspace.closeTerm(menu.row.tag);
            setMenu(null);
          }}
          onForget={() => {
            if (menu.row.tag) workspace.closeTerm(menu.row.tag);
            if (menu.row.session) workspace.forget(menu.row.session);
            setMenu(null);
          }}
          onEnd={() => {
            setEnding(menu.row);
            setMenu(null);
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          name={renaming.aliased ? renaming.label : ''}
          placeholder={renaming.hostName}
          onClose={() => setRenaming(null)}
          onSave={(label) => {
            workspace.rename({ tag: renaming.tag, session: renaming.session }, label);
            setRenaming(null);
          }}
        />
      )}
      {ending?.session && ending.hostId && (
        <Dialog
          title="End this session on the host?"
          onClose={() => setEnding(null)}
          submitLabel="End session"
          danger
          onSubmit={() => {
            if (ending.hostId && ending.session) workspace.endOnHost(ending.hostId, ending.session);
            setEnding(null);
          }}
        >
          <p className="system-hint">
            {rowName(ending)} on {ending.hostName}: the programs running in it are stopped. This
            cannot be undone.
          </p>
        </Dialog>
      )}
      {closingAll && (
        <Dialog
          title="Close every terminal?"
          onClose={() => setClosingAll(false)}
          submitLabel="Close all"
          onSubmit={() => {
            workspace.closeAll();
            setClosingAll(false);
          }}
        >
          <p className="system-hint">
            Resumable (tmux) sessions keep running on their hosts; plain shells end.
          </p>
        </Dialog>
      )}
    </aside>
  );
}

function Preview({ lines, top, title }: { lines: string[]; top: number; title: string }) {
  return (
    <div
      className="terminal-card-preview"
      style={{ top: Math.max(56, Math.min(top - 40, window.innerHeight - 380)) }}
      aria-hidden="true"
    >
      <div className="terminal-card-preview-title">{title}</div>
      <pre>{lines.length > 0 ? lines.join('\n') : '(nothing on screen yet)'}</pre>
    </div>
  );
}

function CardMenu({
  row,
  x,
  y,
  onClose,
  onOpen,
  onPin,
  onRename,
  onCloseTerm,
  onForget,
  onEnd,
}: {
  row: DockRow;
  x: number;
  y: number;
  onClose(): void;
  onOpen(): void;
  onPin(): void;
  onRename(): void;
  onCloseTerm(): void;
  onForget(): void;
  onEnd(): void;
}) {
  return (
    <Menu
      label={`${rowName(row)} actions`}
      title={`${rowName(row)} · ${row.hostName}`}
      at={{ x, y }}
      onClose={onClose}
      entries={[
        { label: 'Open', icon: 'open', tone: 'blue', onSelect: onOpen },
        {
          label: row.pinned ? 'Unpin' : 'Pin to the favorites bar',
          icon: row.pinned ? 'pinOff' : 'pin',
          tone: 'amber',
          onSelect: onPin,
        },
        { label: 'Rename…', icon: 'pencil', tone: 'violet', onSelect: onRename },
        { kind: 'separator' },
        row.tag !== null && {
          label: 'Close',
          ...(row.session && { hint: 'Keeps running on the host' }),
          icon: 'x',
          tone: 'slate',
          onSelect: onCloseTerm,
        },
        row.session !== null && {
          label: 'Forget card',
          hint: 'Hide it here; the session stays',
          icon: 'eraser',
          tone: 'slate',
          onSelect: onForget,
        },
        row.session !== null && {
          label: 'End session on host…',
          icon: 'power',
          danger: true,
          onSelect: onEnd,
        },
      ]}
    />
  );
}

export function RenameDialog({
  name,
  placeholder,
  onClose,
  onSave,
}: {
  name: string;
  placeholder: string;
  onClose(): void;
  onSave(label: string): void;
}) {
  const [value, setValue] = useState(name);
  return (
    <Dialog title="Rename session" onClose={onClose} onSubmit={() => onSave(value)}>
      <div className="system-form-group">
        <label htmlFor="rename-session">Name</label>
        <input
          id="rename-session"
          className="system-input"
          value={value}
          maxLength={60}
          placeholder={placeholder}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
        />
        <span className="system-hint">Leave empty to use the host name again.</span>
      </div>
    </Dialog>
  );
}
