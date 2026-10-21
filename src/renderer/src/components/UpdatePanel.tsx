/**
 * "Update available": a small badge in the top bar (only when there is a
 * newer release) and the panel it opens, with the version, its date and the
 * release notes. "Update now" downloads and checks the installer (installed
 * builds) or the new portable exe (portable build, then "Restart to update"),
 * or opens the release page; a download can be cancelled. "Skip this version"
 * hides the badge until a newer one is out.
 */
import { useState } from 'react';
import type { UpdateState } from '../../../shared/ipc.js';
import { messageOf } from '../api.js';
import { updates, useUpdates } from '../updates.js';
import { Dialog } from './Dialog.js';
import { Icon } from './icons.js';
import { Markdown } from './Markdown.js';

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function UpdateBadge() {
  const state = useUpdates();
  const [open, setOpen] = useState(false);
  if (!state?.available) return null;
  const busy = isBusy(state.phase);
  return (
    <>
      <button
        type="button"
        className={`app-bar-btn update-badge${busy ? ' busy' : ''}`}
        title={
          state.phase === 'ready'
            ? `quqa-express ${state.available.version} is ready: restart to update`
            : `quqa-express ${state.available.version} is available`
        }
        aria-label="Update available"
        onClick={() => setOpen(true)}
      >
        <Icon name="update" />
        <span className="update-dot" aria-hidden="true" />
      </button>
      {open && <UpdatePanel onClose={() => setOpen(false)} />}
    </>
  );
}

const isBusy = (phase: UpdateState['phase']) => phase !== 'idle' && phase !== 'ready';

function phaseText(state: UpdateState): string {
  switch (state.phase) {
    case 'downloading':
      return 'Downloading…';
    case 'verifying':
      return 'Checking the download against SHA256SUMS.txt…';
    case 'starting':
      return state.method === 'portable'
        ? 'Restarting into the new version…'
        : 'Starting the installer; quqa-express closes now.';
    default:
      return '';
  }
}

function submitLabel(state: UpdateState): string {
  if (state.method === 'page') return 'Open download page';
  return state.phase === 'ready' ? 'Restart to update' : 'Update now';
}

export function UpdatePanel({ onClose }: { onClose(): void }) {
  const state = useUpdates();
  const [problem, setProblem] = useState<string | null>(null);
  const available = state?.available;
  if (!state || !available) return null;
  const busy = isBusy(state.phase);
  const ready = state.phase === 'ready';
  const downloading = state.phase === 'downloading' || state.phase === 'verifying';
  const run = (action: () => Promise<void>, close = false) => {
    setProblem(null);
    action().then(
      () => close && onClose(),
      (error: unknown) => setProblem(messageOf(error)),
    );
  };
  return (
    <Dialog
      title={
        <span className="update-title">
          <Icon name="update" /> Update available
        </span>
      }
      className="update-panel"
      onClose={onClose}
      cancelLabel="Later"
      submitLabel={submitLabel(state)}
      busy={busy}
      onSubmit={() =>
        run(() => (ready ? updates.restart() : updates.install()), state.method === 'page')
      }
      footer={
        downloading || ready ? (
          <button type="button" className="link-btn" onClick={() => run(() => updates.cancel())}>
            {ready ? 'Discard download' : 'Cancel download'}
          </button>
        ) : (
          <button
            type="button"
            className="link-btn"
            disabled={busy}
            onClick={() => run(() => updates.skip(available.version), true)}
          >
            Skip this version
          </button>
        )
      }
    >
      <div className="update-head">
        <span className="update-version">quqa-express {available.version}</span>
        <span className="system-hint">
          {formatDate(available.publishedAt)} · you have {state.current}
        </span>
      </div>
      {available.notes ? (
        <Markdown source={available.notes} className="update-notes" />
      ) : (
        <p className="system-hint">This release has no notes.</p>
      )}
      {busy && (
        <div className="update-progress" role="status">
          <span>{phaseText(state)}</span>
          <progress max={1} value={state.progress ?? undefined} />
        </div>
      )}
      {ready && (
        <p className="system-hint" role="status">
          Downloaded and checked against SHA256SUMS.txt. <strong>Restart to update</strong> closes
          quqa-express (open terminals end; tmux sessions can be re-attached), replaces this exe
          under the same name and starts the new version. The old one is kept in
          quqa-express-data\updates\previous.exe.
        </p>
      )}
      {state.method === 'page' && !busy && (
        <p className="system-hint">
          {state.pageReason ??
            'This copy cannot update itself (development build): the release page opens in your browser.'}
        </p>
      )}
      {(problem ?? state.error) && (
        <p className="system-error" role="alert">
          {problem ?? state.error}
        </p>
      )}
    </Dialog>
  );
}
