/**
 * The SFTP file browser for one host: Back / Up / Home / Refresh, the path,
 * search, folders first with typed icons, size, date and permissions; New
 * folder, Upload (button or files dropped on the list), Download (to a folder
 * chosen in a system dialog), Rename, Delete (confirmed; folders with their
 * contents), and drag a row onto a folder (or "..") to move it. Transfers
 * show on the notice island.
 *
 * Ported from Jarvis NG (apps/web/src/machines/Files.tsx: nav bar, search,
 * typed rows, drag to move, upload strip → notice island), same owner. It
 * works over the terminal's own connection when opened from a terminal, else
 * over a shell-less link to the host.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { FileEntry } from '../../../shared/ipc.js';
import { call, messageOf } from '../api.js';
import { formatBytes } from '../terminal/notices.js';
import type { FilesView, Workspace } from '../terminal/workspace.js';
import { Dialog } from './Dialog.js';
import { Icon, type IconName } from './icons.js';
import { NoticeIsland } from './NoticeIsland.js';
import { useModalDialog } from './useModalDialog.js';

const IMAGE = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp'];
const DOC = ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx', 'md'];
const CODE = [
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'rb',
  'java',
  'c',
  'cpp',
  'h',
  'go',
  'rs',
  'php',
  'html',
  'css',
  'scss',
  'json',
  'xml',
  'yaml',
  'yml',
  'sh',
  'sql',
  'conf',
  'toml',
  'ini',
];
const ARCHIVE = ['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz', 'zst'];

/** Row class and icon by type and extension (Jarvis's colours). */
export function kindOf(entry: FileEntry): { row: string; icon: IconName } {
  if (entry.type === 'directory') return { row: 'folder-item', icon: 'folder' };
  if (entry.type === 'symlink') return { row: 'file-type-link', icon: 'link' };
  const ext = entry.name.includes('.') ? (entry.name.split('.').pop() ?? '').toLowerCase() : '';
  if (IMAGE.includes(ext)) return { row: 'file-type-image', icon: 'image' };
  if (DOC.includes(ext)) return { row: 'file-type-doc', icon: 'file' };
  if (CODE.includes(ext)) return { row: 'file-type-code', icon: 'code' };
  if (ARCHIVE.includes(ext)) return { row: 'file-type-archive', icon: 'archive' };
  return { row: '', icon: 'file' };
}

/** `drwxr-xr-x` from the type and mode bits. */
export function permissions(entry: FileEntry): string {
  const type = entry.type === 'directory' ? 'd' : entry.type === 'symlink' ? 'l' : '-';
  const bits = 'rwxrwxrwx';
  let text = '';
  for (let i = 0; i < 9; i++) text += entry.mode & (1 << (8 - i)) ? bits[i] : '-';
  return type + text;
}

export function parentOf(path: string): string {
  if (path === '/' || !path.includes('/')) return '/';
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function joinPath(folder: string, name: string): string {
  return folder === '/' ? `/${name}` : `${folder}/${name}`;
}

type Ask =
  | { kind: 'mkdir' }
  | { kind: 'rename'; entry: FileEntry }
  | { kind: 'delete'; entry: FileEntry }
  | { kind: 'overwrite-upload'; names: string[]; grants: string[] }
  | { kind: 'overwrite-move'; entry: FileEntry; toParent: string; toName: string };

export function FileBrowser({ workspace, view }: { workspace: Workspace; view: FilesView }) {
  const ref = useModalDialog(() => workspace.closeFiles());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [home, setHome] = useState('/');
  const [roots, setRoots] = useState<string[]>([]);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [back, setBack] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [ask, setAsk] = useState<Ask | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [osDrag, setOsDrag] = useState(false);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const loadId = useRef(0);
  const pathRef = useRef<string | null>(null);
  /** Names of the grants of the last upload, in order (to match conflicts back to grants). */
  const namesOf = useRef<string[]>([]);

  // Connect (or reuse the terminal's connection).
  useEffect(() => {
    let cancelled = false;
    workspace.sessionFor(view.target).then(
      (id) => {
        if (!cancelled) setSessionId(id);
      },
      (failure: unknown) => {
        if (!cancelled)
          setConnectError(failure instanceof Error ? failure.message : 'Not connected');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspace, view.target]);

  const load = useCallback(
    async (target: string | undefined, remember: boolean) => {
      if (!sessionId) return;
      const id = ++loadId.current;
      setLoading(true);
      setError(null);
      try {
        const listing = await call('files.list', {
          sessionId,
          ...(target !== undefined && { path: target }),
        });
        if (id !== loadId.current) return;
        const previous = pathRef.current;
        if (remember && previous && previous !== listing.path) {
          setBack((stack) => [...stack.slice(-49), previous]);
        }
        pathRef.current = listing.path;
        setPath(listing.path);
        setHome(listing.home);
        setRoots(listing.roots);
        setEntries(listing.entries);
        setSearch('');
      } catch (failure) {
        if (id === loadId.current) setError(messageOf(failure));
      } finally {
        if (id === loadId.current) setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!sessionId) return;
    const timer = setTimeout(() => void load(view.start ?? undefined, false), 0);
    return () => clearTimeout(timer);
  }, [sessionId, view.start, load]);

  const go = (target: string) => void load(target, true);
  const refresh = useCallback(() => {
    if (pathRef.current) void load(pathRef.current, false);
  }, [load]);

  // A finished upload into this folder shows up in the list.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Set<string>();
    const unsubscribe = workspace.notices.subscribe(() => {
      for (const transfer of workspace.notices.transfers.values()) {
        if (
          transfer.state !== 'done' ||
          transfer.direction !== 'upload' ||
          transfer.sessionId !== sessionId ||
          seen.has(transfer.id)
        ) {
          continue;
        }
        seen.add(transfer.id);
        if (parentOf(transfer.remotePath) === pathRef.current) {
          clearTimeout(timer);
          timer = setTimeout(refresh, 150);
        }
      }
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [workspace, sessionId, refresh]);

  const run = async (action: () => Promise<unknown>, done?: string) => {
    try {
      await action();
      if (done) workspace.notices.notice(done, 'success');
      refresh();
      return true;
    } catch (failure) {
      workspace.notices.notice(messageOf(failure), 'error');
      return false;
    }
  };

  const upload = async (grants: string[], conflict: 'ask' | 'overwrite') => {
    if (!sessionId || !path || grants.length === 0) return;
    try {
      const result = await call('files.upload', {
        sessionId,
        directory: path,
        grants,
        conflict,
        wait: false,
      });
      if (result.conflicts.length > 0) {
        // Only the clashing files are asked about again.
        const clashing = grants.filter((_, i) =>
          result.conflicts.includes(namesOf.current[i] ?? ''),
        );
        setAsk({ kind: 'overwrite-upload', names: result.conflicts, grants: clashing });
      }
    } catch (failure) {
      workspace.notices.notice('Upload failed', 'error', { detail: messageOf(failure) });
    }
  };
  const pickUpload = async () => {
    try {
      const { files } = await call('files.pickUpload', {});
      namesOf.current = files.map((f) => f.name);
      await upload(
        files.map((f) => f.token),
        'ask',
      );
    } catch (failure) {
      workspace.notices.notice(messageOf(failure), 'error');
    }
  };

  const dropUpload = async (list: File[]) => {
    const grants = await window.quqa.grantFiles(list).catch(() => []);
    if (grants.length === 0) {
      workspace.notices.notice('Only files can be uploaded (no folders)', 'error');
      return;
    }
    namesOf.current = grants.map((g) => g.name);
    await upload(
      grants.map((g) => g.token),
      'ask',
    );
  };

  const download = async (entry: FileEntry) => {
    if (!sessionId) return;
    try {
      await call('files.download', { sessionId, paths: [entry.path] });
    } catch (failure) {
      workspace.notices.notice('Download failed', 'error', { detail: messageOf(failure) });
    }
  };

  const move = async (entry: FileEntry, toParent: string, overwrite = false) => {
    if (!sessionId || toParent === parentOf(entry.path) || toParent === entry.path) return;
    try {
      await call('files.rename', {
        sessionId,
        from: entry.path,
        toParent,
        toName: entry.name,
        overwrite,
      });
      workspace.notices.notice(`Moved ${entry.name}`, 'success', { detail: `to ${toParent}` });
      refresh();
    } catch (failure) {
      if ((failure as { code?: string }).code === 'exists' && !overwrite) {
        setAsk({ kind: 'overwrite-move', entry, toParent, toName: entry.name });
      } else workspace.notices.notice(messageOf(failure), 'error');
    }
  };

  const onRowDragStart = (event: DragEvent, entry: FileEntry) => {
    event.dataTransfer.setData('application/x-quqa-path', entry.path);
    event.dataTransfer.effectAllowed = 'move';
    setDragging(entry.path);
  };
  const isOsDrag = (event: DragEvent) =>
    event.dataTransfer.types.includes('Files') &&
    !event.dataTransfer.types.includes('application/x-quqa-path');
  const onFolderDrop = (event: DragEvent, folder: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    setOsDrag(false);
    if (isOsDrag(event)) {
      void dropUpload([...event.dataTransfer.files]);
      return;
    }
    const from = event.dataTransfer.getData('application/x-quqa-path');
    setDragging(null);
    const entry = entries?.find((e) => e.path === from);
    if (entry) void move(entry, folder);
  };

  const shown = (entries ?? []).filter(
    (e) => search === '' || e.name.toLowerCase().includes(search.toLowerCase()),
  );
  const atRoot = path === '/' || (roots.length > 0 && path !== null && roots.includes(path));
  const linkState = view.target.kind === 'link' ? workspace.links.get(view.target.hostId) : null;
  const link = linkState?.getSnapshot();

  return (
    <dialog ref={ref} className="file-browser" aria-labelledby="files-title">
      {/* The modal sits in the top layer: transfers show on its own island. */}
      <NoticeIsland notices={workspace.notices} />
      <div className="file-browser-header">
        <Icon name="folder" className="file-browser-icon" />
        <h2 id="files-title">Files — {view.title}</h2>
        <button
          type="button"
          className="file-upload-btn"
          disabled={!path}
          onClick={() => void pickUpload()}
        >
          <Icon name="upload" /> Upload
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close files"
          title="Close (Esc)"
          onClick={() => workspace.closeFiles()}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="file-nav-bar">
        <button
          type="button"
          className="file-nav-btn"
          title="Back"
          aria-label="Back"
          disabled={back.length === 0}
          onClick={() => {
            const previous = back.at(-1);
            if (!previous) return;
            setBack((stack) => stack.slice(0, -1));
            void load(previous, false);
          }}
        >
          <Icon name="arrowLeft" />
        </button>
        <button
          type="button"
          className="file-nav-btn"
          title="Up"
          aria-label="Up"
          disabled={!path || atRoot}
          onClick={() => path && go(parentOf(path))}
        >
          <Icon name="arrowUp" />
        </button>
        <button
          type="button"
          className="file-nav-btn"
          title="Home"
          aria-label="Home"
          disabled={!path}
          onClick={() => void load(undefined, true)}
        >
          <Icon name="home" />
        </button>
        <button
          type="button"
          className={`file-nav-btn${loading ? ' spinning' : ''}`}
          title="Refresh"
          aria-label="Refresh"
          disabled={!path}
          onClick={refresh}
        >
          <Icon name="refresh" />
        </button>
        <span className="file-nav-divider" />
        {editingPath !== null ? (
          <form
            className="file-path-form"
            onSubmit={(event) => {
              event.preventDefault();
              const target = editingPath.trim().replace(/^~(?=\/|$)/, home);
              setEditingPath(null);
              if (target.startsWith('/')) go(target);
            }}
          >
            <input
              autoFocus
              className="file-path-input"
              aria-label="Go to folder"
              value={editingPath}
              spellCheck={false}
              onChange={(event) => setEditingPath(event.target.value)}
              onBlur={() => setEditingPath(null)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditingPath(null);
                }
              }}
            />
          </form>
        ) : (
          <button
            type="button"
            className="modal-path"
            title="Click to type a folder"
            data-testid="files-path"
            onClick={() => path && setEditingPath(path)}
          >
            {path ?? '…'}
          </button>
        )}
        <button
          type="button"
          className="file-nav-btn"
          title="New folder"
          aria-label="New folder"
          disabled={!path}
          onClick={() => setAsk({ kind: 'mkdir' })}
        >
          <Icon name="folderPlus" />
        </button>
      </div>
      <div className="file-search-bar">
        <Icon name="search" />
        <input
          aria-label="Search files"
          placeholder="Search this folder"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div
        className={`file-list${dragging ? ' drag-active' : ''}${osDrag ? ' os-drag' : ''}`}
        data-testid="file-list"
        onDragOver={(event) => {
          if (!isOsDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setOsDrag(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setOsDrag(false);
        }}
        onDrop={(event) => path && onFolderDrop(event, path)}
      >
        {connectError || link?.state === 'failed' ? (
          <div className="file-empty">
            {connectError ?? link?.error ?? 'Not connected'}
            {linkState && (
              <div>
                <button
                  type="button"
                  className="system-btn small"
                  onClick={() => {
                    linkState.reconnect();
                    setConnectError(null);
                    void workspace
                      .sessionFor(view.target)
                      .then(setSessionId, (e: unknown) =>
                        setConnectError(e instanceof Error ? e.message : 'Not connected'),
                      );
                  }}
                >
                  Reconnect
                </button>
              </div>
            )}
          </div>
        ) : !sessionId ? (
          <div className="file-loading">Connecting…</div>
        ) : error ? (
          <div className="file-empty" role="alert">
            {error}
          </div>
        ) : entries === null ? (
          <div className="file-loading">Loading files…</div>
        ) : (
          <>
            {path && !atRoot && (
              <div
                className={`file-item back-item${dropTarget === '..' ? ' drag-over' : ''}`}
                onClick={() => go(parentOf(path))}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDropTarget('..');
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(event) => onFolderDrop(event, parentOf(path))}
              >
                <div className="file-icon-wrapper">
                  <Icon name="arrowUp" className="file-icon" />
                </div>
                <div className="file-info">
                  <div className="file-name">..</div>
                  <div className="file-meta">Up to {parentOf(path)}</div>
                </div>
              </div>
            )}
            {shown.length === 0 && (
              <div className="file-empty">
                {search ? 'No matching files' : 'This folder is empty'}
              </div>
            )}
            {shown.map((entry) => {
              const kind = kindOf(entry);
              const folder = entry.type === 'directory';
              return (
                <div
                  key={entry.path}
                  className={`file-item ${kind.row}${dragging === entry.path ? ' dragging' : ''}${dropTarget === entry.path ? ' drag-over' : ''}`}
                  data-testid="file-row"
                  aria-label={entry.name}
                  draggable
                  onDragStart={(event) => onRowDragStart(event, entry)}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropTarget(null);
                  }}
                  onDragOver={(event) => {
                    if (!folder) return;
                    event.preventDefault();
                    setDropTarget(entry.path);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(event) => (folder ? onFolderDrop(event, entry.path) : undefined)}
                  onDoubleClick={() => (folder ? go(entry.path) : void download(entry))}
                  onClick={() => (folder ? go(entry.path) : undefined)}
                >
                  <div className="file-icon-wrapper">
                    <Icon name={kind.icon} className={`file-icon${folder ? ' folder' : ''}`} />
                  </div>
                  <div className="file-info">
                    <div className="file-name" title={entry.name}>
                      {entry.name}
                    </div>
                    <div className="file-meta">
                      {folder ? 'Folder' : formatBytes(entry.size)} ·{' '}
                      {new Date(entry.modifiedAt).toLocaleString()} ·{' '}
                      <span className="file-perms">{permissions(entry)}</span>
                    </div>
                  </div>
                  <div className="file-actions" onClick={(event) => event.stopPropagation()}>
                    {entry.type === 'file' && (
                      <button
                        type="button"
                        className="file-download"
                        aria-label={`Download ${entry.name}`}
                        onClick={() => void download(entry)}
                      >
                        Download
                      </button>
                    )}
                    <button
                      type="button"
                      className="file-action-btn"
                      title="Rename"
                      aria-label={`Rename ${entry.name}`}
                      onClick={() => setAsk({ kind: 'rename', entry })}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      type="button"
                      className="file-action-btn danger"
                      title="Delete"
                      aria-label={`Delete ${entry.name}`}
                      onClick={() => setAsk({ kind: 'delete', entry })}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
        {osDrag && <div className="file-drop-hint">Drop to upload to {path}</div>}
      </div>
      <div className="file-browser-footer">
        <span>
          {entries ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : ''}
          {roots.length > 0 && ` · limited to ${roots.join(', ')}`}
        </span>
        <span className="system-hint">
          Drop files here to upload · drag a row onto a folder to move it
        </span>
      </div>
      {ask?.kind === 'mkdir' && path && (
        <NameDialog
          title="New folder"
          label="Folder name"
          initial=""
          submitLabel="Create"
          onClose={() => setAsk(null)}
          onSubmit={async (name) => {
            if (!sessionId) return;
            if (await run(() => call('files.mkdir', { sessionId, parent: path, name }))) {
              setAsk(null);
            }
          }}
        />
      )}
      {ask?.kind === 'rename' && (
        <NameDialog
          title={`Rename ${ask.entry.name}`}
          label="New name"
          initial={ask.entry.name}
          submitLabel="Rename"
          onClose={() => setAsk(null)}
          onSubmit={async (name) => {
            if (!sessionId || name === ask.entry.name) return setAsk(null);
            try {
              await call('files.rename', {
                sessionId,
                from: ask.entry.path,
                toParent: parentOf(ask.entry.path),
                toName: name,
                overwrite: false,
              });
              setAsk(null);
              refresh();
            } catch (failure) {
              if ((failure as { code?: string }).code === 'exists') {
                setAsk({
                  kind: 'overwrite-move',
                  entry: ask.entry,
                  toParent: parentOf(ask.entry.path),
                  toName: name,
                });
              } else workspace.notices.notice(messageOf(failure), 'error');
            }
          }}
        />
      )}
      {ask?.kind === 'delete' && (
        <Dialog
          title={`Delete ${ask.entry.name}?`}
          onClose={() => setAsk(null)}
          submitLabel="Delete"
          danger
          onSubmit={() => {
            const entry = ask.entry;
            setAsk(null);
            if (!sessionId) return;
            void run(
              () =>
                call('files.delete', {
                  sessionId,
                  path: entry.path,
                  recursive: entry.type === 'directory',
                }),
              `Deleted ${entry.name}`,
            );
          }}
        >
          <p>
            {ask.entry.type === 'directory'
              ? 'The folder and everything in it will be deleted from the host. This cannot be undone.'
              : 'The file will be deleted from the host. This cannot be undone.'}
          </p>
          <p className="item-mono">{ask.entry.path}</p>
        </Dialog>
      )}
      {ask?.kind === 'overwrite-upload' && (
        <Dialog
          title="Replace existing files?"
          onClose={() => setAsk(null)}
          submitLabel="Replace"
          danger
          onSubmit={() => {
            const grants = ask.grants;
            setAsk(null);
            void upload(grants, 'overwrite');
          }}
        >
          <p>These already exist in {path} and would be replaced:</p>
          <ul className="file-conflicts">
            {ask.names.slice(0, 20).map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </Dialog>
      )}
      {ask?.kind === 'overwrite-move' && (
        <Dialog
          title={`Replace ${ask.toName}?`}
          onClose={() => setAsk(null)}
          submitLabel="Replace"
          danger
          onSubmit={() => {
            const { entry, toParent, toName } = ask;
            setAsk(null);
            if (!sessionId) return;
            void run(
              () =>
                call('files.rename', {
                  sessionId,
                  from: entry.path,
                  toParent,
                  toName,
                  overwrite: true,
                }),
              `Moved ${entry.name}`,
            );
          }}
        >
          <p>
            {joinPath(ask.toParent, ask.toName)} already exists and will be replaced by{' '}
            {ask.entry.name}.
          </p>
        </Dialog>
      )}
    </dialog>
  );
}

function NameDialog({
  title,
  label,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  onClose(): void;
  onSubmit(name: string): Promise<void> | void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const invalid =
    name.trim() === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.length > 255;
  return (
    <Dialog
      title={title}
      onClose={onClose}
      submitLabel={submitLabel}
      busy={busy}
      submitDisabled={invalid}
      onSubmit={() => {
        setBusy(true);
        void Promise.resolve(onSubmit(name.trim())).finally(() => setBusy(false));
      }}
    >
      <div className="system-form-group">
        <label htmlFor="file-name-input">{label}</label>
        <input
          id="file-name-input"
          className="system-input"
          value={name}
          autoFocus
          spellCheck={false}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
    </Dialog>
  );
}
