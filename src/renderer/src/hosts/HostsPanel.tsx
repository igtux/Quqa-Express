/**
 * The hosts screen (the SSH Manager): a compact status line, search and
 * group filter, collapsible groups, host cards with Open Terminal, Files,
 * Sessions, Install key, Edit, Duplicate, Ping, favorite and Delete; Add
 * host, Quick Connect and the ~/.ssh/config import.
 *
 * Ported from Jarvis NG (apps/web/src/machines/SshManager.tsx, host cards,
 * latency cached 20 s, Ping all; groups from legacy-ui 03a §5.4), same owner.
 * Latency is the TCP connect time to the SSH port (no login).
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { HostInfo, KeyInfo } from '../../../shared/ipc.js';
import { call, errorText, messageOf } from '../api.js';
import { Dialog } from '../components/Dialog.js';
import { Icon } from '../components/icons.js';
import { formatIdle } from '../terminal/dockModel.js';
import type { Workspace } from '../terminal/workspace.js';
import { EMPTY_HOST, HostForm, inputOf } from './HostForm.js';
import {
  destination,
  filterHosts,
  groupHosts,
  hostStatus,
  LATENCY_TTL_MS,
  latencyClass,
  latencyText,
  relativeTime,
  toLatency,
  type Latency,
} from './hostModel.js';
import { SshImportDialog } from './SshImportDialog.js';

/** Survives switching tabs. */
const latencyCache = new Map<string, Latency>();

type Editing =
  | { mode: 'add'; initial: typeof EMPTY_HOST }
  | { mode: 'edit'; host: HostInfo }
  | { mode: 'duplicate'; host: HostInfo };

export function HostsPanel({
  hosts,
  keys,
  workspace,
  onChange,
  onManageKeys,
  onQuickConnect,
}: {
  hosts: HostInfo[];
  keys: KeyInfo[];
  workspace: Workspace;
  onChange(): void;
  onManageKeys(): void;
  onQuickConnect(): void;
}) {
  useSyncExternalStore(workspace.subscribe, workspace.getVersion);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [latency, setLatency] = useState(() => new Map(latencyCache));
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<HostInfo | null>(null);
  const [importing, setImporting] = useState(false);
  const [found, setFound] = useState<HostInfo | null>(null);
  const [installing, setInstalling] = useState<HostInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const ping = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    setChecking((current) => new Set([...current, ...ids]));
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const { results } = await call('hosts.ping', { ids: ids.slice(i, i + 100) });
        for (const result of results) latencyCache.set(result.id, toLatency(result));
      }
    } catch {
      // Shown as unknown.
    } finally {
      setLatency(new Map(latencyCache));
      setChecking((current) => new Set([...current].filter((id) => !ids.includes(id))));
    }
  }, []);

  // Live latency: stale entries are checked when the screen shows.
  const hostIds = hosts.map((h) => h.id).join(',');
  useEffect(() => {
    const now = Date.now();
    const stale = hostIds
      .split(',')
      .filter((id) => id && now - (latencyCache.get(id)?.at ?? 0) > LATENCY_TTL_MS);
    const timer = setTimeout(() => void ping(stale), 0);
    return () => clearTimeout(timer);
  }, [hostIds, ping]);

  const visible = useMemo(() => {
    const list = filterHosts(hosts, query);
    return group === null ? list : list.filter((h) => h.group === group);
  }, [hosts, query, group]);
  const groups = groupHosts(visible);
  const groupNames = [...new Set(hosts.map((h) => h.group))].sort((a, b) =>
    a === '' ? 1 : b === '' ? -1 : a.localeCompare(b),
  );
  const showGroups = groupNames.some(Boolean);

  const measured = hosts.map((h) => latency.get(h.id)).filter((x): x is Latency => !!x);
  const online = measured.filter((x) => x.ms !== null);
  const avg =
    online.length > 0
      ? `${Math.round(online.reduce((n, x) => n + (x.ms ?? 0), 0) / online.length)} ms`
      : '--';

  const openTerminal = (host: HostInfo) => {
    if (host.tmux && workspace.detachedOn(host.id).length > 0) {
      setFound(host);
      return;
    }
    workspace.openHost(host.id);
  };

  const keyLabel = (host: HostInfo) =>
    host.auth.kind === 'key'
      ? (keys.find((k) => k.id === (host.auth as { keyId: string }).keyId)?.label ?? 'missing key')
      : null;

  return (
    <section className="panel hosts-panel" aria-label="Hosts">
      <div className="hosts-toolbar">
        <div className="hosts-stats" data-testid="hosts-stats">
          <span>
            <b>{hosts.length}</b> host{hosts.length === 1 ? '' : 's'}
          </span>
          <span className="stat-online">
            <b>{online.length}</b> online
          </span>
          <span className="stat-offline">
            <b>{measured.length - online.length}</b> offline
          </span>
          <span>avg {avg}</span>
          <button
            type="button"
            className={`icon-btn${checking.size > 0 ? ' spinning' : ''}`}
            title="Ping all hosts"
            aria-label="Ping all hosts"
            disabled={hosts.length === 0}
            onClick={() => void ping(hosts.map((h) => h.id))}
          >
            <Icon name="refresh" />
          </button>
        </div>
        <div className="hosts-actions">
          <button type="button" className="system-btn ghost small" onClick={onQuickConnect}>
            <Icon name="bolt" /> Quick connect
          </button>
          <button
            type="button"
            className="system-btn ghost small"
            onClick={() => setImporting(true)}
          >
            <Icon name="import" /> Import from ~/.ssh
          </button>
          <button
            type="button"
            className="system-btn primary small"
            onClick={() => setEditing({ mode: 'add', initial: EMPTY_HOST })}
          >
            <Icon name="plus" /> Add host
          </button>
        </div>
      </div>

      {hosts.length > 0 && (
        <div className="panel-row hosts-filter">
          <input
            className="system-input"
            type="search"
            aria-label="Search hosts"
            placeholder="Search name, address, user, tag:prod, group:web…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {showGroups && (
            <select
              className="system-input group-select"
              aria-label="Group"
              value={group ?? '\u0000all'}
              onChange={(e) => setGroup(e.target.value === '\u0000all' ? null : e.target.value)}
            >
              <option value={'\u0000all'}>All groups</option>
              {groupNames.map((name) => (
                <option key={name || 'ungrouped'} value={name}>
                  {name || 'Ungrouped'}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {notice && (
        <p className="system-hint" role="status">
          {notice}
        </p>
      )}

      {hosts.length === 0 ? (
        <div className="hosts-empty">
          <span className="hosts-empty-icon" aria-hidden="true">
            <Icon name="terminal" />
          </span>
          <p className="hosts-empty-title">No hosts yet.</p>
          <p className="system-hint">
            Add a server to connect to, or bring over the hosts and keys you already use with
            OpenSSH. Quick connect (Ctrl+Shift+O) opens a one-off session.
          </p>
          <div className="hosts-empty-actions">
            <button
              type="button"
              className="system-btn primary inline"
              onClick={() => setEditing({ mode: 'add', initial: EMPTY_HOST })}
            >
              <Icon name="plus" /> Add host
            </button>
            <button
              type="button"
              className="system-btn ghost inline"
              onClick={() => setImporting(true)}
            >
              <Icon name="import" /> Import from ~/.ssh
            </button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <p className="panel-empty">No host matches.</p>
      ) : (
        <div className="host-groups">
          {groups.map(({ name, hosts: members }) => {
            const isCollapsed = collapsed.has(name);
            const up = members.filter((h) => latency.get(h.id)?.ms != null).length;
            return (
              <section key={name || 'ungrouped'} className="host-group">
                {showGroups && (
                  <button
                    type="button"
                    className={`host-group-head${isCollapsed ? ' collapsed' : ''}`}
                    aria-expanded={!isCollapsed}
                    onClick={() => {
                      const next = new Set(collapsed);
                      if (next.has(name)) next.delete(name);
                      else next.add(name);
                      setCollapsed(next);
                    }}
                  >
                    <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} />
                    <span className="host-group-name">{name || 'Ungrouped'}</span>
                    <span className="host-group-count">
                      {up}/{members.length} online
                    </span>
                  </button>
                )}
                {!isCollapsed && (
                  <ul className="ssh-host-cards" aria-label={name || 'Ungrouped'}>
                    {members.map((host) => (
                      <HostCard
                        key={host.id}
                        host={host}
                        keyLabel={keyLabel(host)}
                        latency={latency.get(host.id)}
                        checking={checking.has(host.id)}
                        favorite={workspace.isHostFavorite(host.id)}
                        detached={host.tmux ? workspace.detachedOn(host.id).length : 0}
                        onOpen={() => openTerminal(host)}
                        onFiles={() => workspace.openFilesForHost(host.id)}
                        onInstallKey={() => setInstalling(host)}
                        onSessions={() => {
                          setFound(host);
                          workspace.listSessions(host.id);
                        }}
                        onEdit={() => setEditing({ mode: 'edit', host })}
                        onDuplicate={() => setEditing({ mode: 'duplicate', host })}
                        onPing={() => void ping([host.id])}
                        onFavorite={() => workspace.toggleHostFavorite(host.id)}
                        onDelete={() => setDeleting(host)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      {editing && (
        <HostForm
          title={
            editing.mode === 'add'
              ? 'Add host'
              : editing.mode === 'edit'
                ? `Edit ${editing.host.name}`
                : `Duplicate ${editing.host.name}`
          }
          {...(editing.mode === 'edit' && { id: editing.host.id })}
          initial={
            editing.mode === 'add'
              ? editing.initial
              : editing.mode === 'edit'
                ? inputOf(editing.host)
                : { ...inputOf(editing.host), name: `${editing.host.name} copy`.slice(0, 64) }
          }
          keys={keys}
          hosts={hosts}
          onManageKeys={() => {
            setEditing(null);
            onManageKeys();
          }}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setNotice(`${saved.name} saved`);
            latencyCache.delete(saved.id);
            onChange();
          }}
        />
      )}
      {deleting && (
        <DeleteHost
          host={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setNotice(`${deleting.name} deleted`);
            onChange();
          }}
        />
      )}
      {importing && (
        <SshImportDialog
          onClose={() => setImporting(false)}
          onImported={onChange}
          onShowKeys={() => {
            setImporting(false);
            onManageKeys();
          }}
        />
      )}
      {found && <HostSessions host={found} workspace={workspace} onClose={() => setFound(null)} />}
      {installing && (
        <InstallKey
          host={installing}
          keys={keys}
          workspace={workspace}
          onClose={() => setInstalling(null)}
        />
      )}
    </section>
  );
}

function HostCard({
  host,
  keyLabel,
  latency,
  checking,
  favorite,
  detached,
  onOpen,
  onFiles,
  onInstallKey,
  onSessions,
  onEdit,
  onDuplicate,
  onPing,
  onFavorite,
  onDelete,
}: {
  host: HostInfo;
  keyLabel: string | null;
  latency: Latency | undefined;
  checking: boolean;
  favorite: boolean;
  detached: number;
  onOpen(): void;
  onFiles(): void;
  onInstallKey(): void;
  onSessions(): void;
  onEdit(): void;
  onDuplicate(): void;
  onPing(): void;
  onFavorite(): void;
  onDelete(): void;
}) {
  const status = hostStatus(latency, checking);
  return (
    <li
      className={`ssh-host-card ${status}`}
      style={host.color ? ({ '--host-color': host.color } as React.CSSProperties) : undefined}
      data-testid="host-card"
      aria-label={host.name}
    >
      <span className={`ssh-card-status ${status}`} title={status} />
      <div className="ssh-card-info">
        <div className="ssh-card-header">
          <span className="ssh-card-name">{host.name}</span>
          {host.os === 'windows' && <span className="ssh-card-group">Windows</span>}
          {host.tmux && (
            <span className="ssh-card-group tmux" title="Resumable sessions (tmux)">
              tmux
            </span>
          )}
          {host.tags.map((tag) => (
            <span key={tag} className="ssh-card-tag">
              #{tag}
            </span>
          ))}
        </div>
        <div className="ssh-card-details">
          <span className="ssh-card-host">{destination(host)}</span>
          {keyLabel && (
            <span className="ssh-card-key" title={`Logs in with the key ${keyLabel}`}>
              {keyLabel}
            </span>
          )}
          <span className={`ssh-card-latency ${latencyClass(latency)}`}>
            {checking ? '…' : latencyText(latency)}
          </span>
          {host.lastUsedAt && (
            <span className="ssh-card-last-check" title={`${host.connectCount} connections`}>
              used {relativeTime(host.lastUsedAt)} · {host.connectCount}×
            </span>
          )}
        </div>
        {host.notes && <div className="ssh-card-notes">{host.notes.split('\n')[0]}</div>}
      </div>
      <div className="ssh-card-actions">
        <button
          type="button"
          className="ssh-card-btn terminal"
          title="Open a terminal"
          aria-label={`Open a terminal on ${host.name}`}
          onClick={onOpen}
        >
          <Icon name="terminal" />
        </button>
        <button
          type="button"
          className="ssh-card-btn"
          title="Files (SFTP)"
          aria-label={`Files on ${host.name}`}
          onClick={onFiles}
        >
          <Icon name="folder" />
        </button>
        {host.tmux && (
          <button
            type="button"
            className="ssh-card-btn"
            title="Sessions on this host"
            aria-label={`Sessions on ${host.name}`}
            onClick={onSessions}
          >
            <Icon name="layers" />
            {detached > 0 && <span className="ssh-access-badge">{detached}</span>}
          </button>
        )}
        <button
          type="button"
          className={`ssh-card-btn${favorite ? ' on' : ''}`}
          title={favorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={favorite ? `Unfavorite ${host.name}` : `Favorite ${host.name}`}
          aria-pressed={favorite}
          onClick={onFavorite}
        >
          <Icon name="star" filled={favorite} />
        </button>
        <button
          type="button"
          className="ssh-card-btn"
          title="Ping"
          aria-label={`Ping ${host.name}`}
          onClick={onPing}
        >
          <Icon name="activity" />
        </button>
        {host.os === 'linux' && (
          <button
            type="button"
            className="ssh-card-btn"
            title="Install a public key on this host"
            aria-label={`Install a key on ${host.name}`}
            onClick={onInstallKey}
          >
            <Icon name="key" />
          </button>
        )}
        <button
          type="button"
          className="ssh-card-btn"
          title="Edit"
          aria-label={`Edit ${host.name}`}
          onClick={onEdit}
        >
          <Icon name="edit" />
        </button>
        <button
          type="button"
          className="ssh-card-btn"
          title="Duplicate"
          aria-label={`Duplicate ${host.name}`}
          onClick={onDuplicate}
        >
          <Icon name="copy" />
        </button>
        <button
          type="button"
          className="ssh-card-btn danger"
          title="Delete"
          aria-label={`Delete ${host.name}`}
          onClick={onDelete}
        >
          <Icon name="trash" />
        </button>
      </div>
    </li>
  );
}

/**
 * "Install my public key on this host": appends a vault key to
 * ~/.ssh/authorized_keys over SFTP (once; nothing changes if it is there).
 */
function InstallKey({
  host,
  keys,
  workspace,
  onClose,
}: {
  host: HostInfo;
  keys: KeyInfo[];
  workspace: Workspace;
  onClose(): void;
}) {
  const [keyId, setKeyId] = useState(
    host.auth.kind === 'key' ? host.auth.keyId : (keys[0]?.id ?? ''),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [useAfter, setUseAfter] = useState(host.auth.kind === 'password');
  const key = keys.find((k) => k.id === keyId);
  return (
    <Dialog
      title={`Install a key on ${host.name}?`}
      onClose={onClose}
      submitLabel="Install key"
      busy={busy}
      submitDisabled={!key}
      onSubmit={() => {
        if (!key) return;
        setBusy(true);
        setProblem(null);
        workspace.installKey(host.id, key.id).then(
          async (result) => {
            workspace.notices.notice(
              result.added
                ? `Key installed on ${host.name}`
                : `The key was already on ${host.name}`,
              'success',
              { detail: result.path },
            );
            if (useAfter && host.auth.kind !== 'key') {
              const { id: _id, createdAt: _c, lastUsedAt: _l, connectCount: _n, ...input } = host;
              await call('hosts.save', {
                id: host.id,
                host: { ...input, auth: { kind: 'key', keyId: key.id } },
              }).then(
                (saved) =>
                  workspace.setHosts(workspace.hosts.map((h) => (h.id === saved.id ? saved : h))),
                () => undefined,
              );
            }
            onClose();
          },
          (error: unknown) => {
            setBusy(false);
            setProblem(errorText(error));
          },
        );
      }}
    >
      {keys.length === 0 ? (
        <p className="system-hint">Generate or import a key under Keys first.</p>
      ) : (
        <>
          <p className="system-hint">
            The public key is added to <code>~/.ssh/authorized_keys</code> of {host.username} on{' '}
            {host.name} (the folder and file are created with safe permissions if missing). If it is
            already there, nothing changes.
          </p>
          <select
            aria-label="Key to install"
            className="system-input"
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
          >
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label} ({k.algorithm}, {k.fingerprint.slice(7, 19)}…)
              </option>
            ))}
          </select>
          {host.auth.kind !== 'key' && (
            <label className="system-check">
              <input
                type="checkbox"
                checked={useAfter}
                onChange={(e) => setUseAfter(e.target.checked)}
              />
              <span>Log in to {host.name} with this key from now on</span>
            </label>
          )}
        </>
      )}
      {problem && (
        <p className="system-error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}

function DeleteHost({
  host,
  onClose,
  onDeleted,
}: {
  host: HostInfo;
  onClose(): void;
  onDeleted(): void;
}) {
  const [forget, setForget] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={`Delete ${host.name}?`}
      onClose={onClose}
      submitLabel="Delete"
      danger
      busy={busy}
      onSubmit={() => {
        setBusy(true);
        call('hosts.delete', { id: host.id, forgetHostKey: forget }).then(onDeleted, (error) => {
          setProblem(messageOf(error));
          setBusy(false);
        });
      }}
    >
      <p className="system-hint">
        The host is removed from the list. Its key in the vault and a saved password stay; tmux
        sessions on the host keep running.
      </p>
      <label className="system-check">
        <input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} />
        <span>Also forget its pinned host key ({destination(host)})</span>
      </label>
      {problem && (
        <p className="system-error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}

/**
 * "Sessions on host" / "Session found on host": the host's quqa tmux
 * sessions, to re-attach or end, or a new session.
 */
export function HostSessions({
  host,
  workspace,
  onClose,
}: {
  host: HostInfo;
  workspace: Workspace;
  onClose(): void;
}) {
  useSyncExternalStore(workspace.subscribe, workspace.getVersion);
  const [ending, setEnding] = useState<string | null>(null);
  const found = workspace.found.get(host.id);
  const sessions = workspace.detachedOn(host.id);
  const probe = workspace.probeOf(host.id) ?? null;
  const probing = probe !== null && !probe.getSnapshot().done;
  const probeError = probe?.getSnapshot().error ?? null;
  const aliases = new Map(workspace.ui.aliases.map((a) => [a.session, a.label]));

  return (
    <>
      <Dialog
        title={`Sessions on ${host.name}`}
        onClose={onClose}
        cancelLabel="Close"
        wide
        footer={
          <button
            type="button"
            className="system-btn ghost inline"
            onClick={() => workspace.listSessions(host.id)}
            disabled={probing}
          >
            <Icon name="refresh" /> Refresh
          </button>
        }
        onSubmit={() => {
          workspace.openHost(host.id);
          onClose();
        }}
        submitLabel="New session"
      >
        {probing && !found && <p className="system-hint">Logging in to list the sessions…</p>}
        {probeError && (
          <p className="system-error" role="alert">
            {probeError}
          </p>
        )}
        {found && !found.available && (
          <p className="system-hint">
            tmux is not installed on this host: terminals are plain shells.
          </p>
        )}
        {found?.available && sessions.length === 0 && (
          <p className="panel-empty">No detached sessions on this host.</p>
        )}
        {sessions.length > 0 && (
          <ul className="item-list" aria-label="Sessions on the host">
            {sessions.map((session) => (
              <li key={session.name} className="item" data-testid="host-session">
                <div className="item-main">
                  <div className="item-title">
                    {aliases.get(session.name) ??
                      (session.path.split('/').filter(Boolean).pop() || host.name)}
                    {session.command && <span className="item-badge">{session.command}</span>}
                    {session.attached > 0 && <span className="item-badge">open elsewhere</span>}
                  </div>
                  <div className="item-meta">
                    {session.path} · {formatIdle(session.idleSeconds)} · started{' '}
                    {session.createdAt ? relativeTime(session.createdAt) : '?'}
                  </div>
                </div>
                <div className="item-actions row">
                  <button
                    type="button"
                    className="system-btn primary small"
                    onClick={() => {
                      workspace.openHost(host.id, { tmux: session.name });
                      onClose();
                    }}
                  >
                    Attach
                  </button>
                  <button
                    type="button"
                    className="link-btn danger"
                    onClick={() => setEnding(session.name)}
                  >
                    End…
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      {ending && (
        <Dialog
          title="End this session on the host?"
          onClose={() => setEnding(null)}
          submitLabel="End session"
          danger
          onSubmit={() => {
            workspace.endOnHost(host.id, ending);
            setEnding(null);
          }}
        >
          <p className="system-hint">
            The programs running in it are stopped. This cannot be undone.
          </p>
        </Dialog>
      )}
    </>
  );
}
