/**
 * "Update available": a small badge in the top bar (only when there is a
 * newer release) and the panel it opens, with the version, its date and the
 * release notes. "Update now" downloads and checks the installer (installed
 * builds) or opens the release page (portable); "Skip this version" hides the
 * badge until a newer one is out.
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
  const busy = state.phase !== 'idle';
  return (
    <>
      <button
        type="button"
        className={`app-bar-btn update-badge${busy ? ' busy' : ''}`}
        title={`quqa-express ${state.available.version} is available`}
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

const PHASE_TEXT: Record<UpdateState['phase'], string> = {
  idle: '',
  downloading: 'Downloading…',
  verifying: 'Checking the download against SHA256SUMS.txt…',
  starting: 'Starting the installer; quqa-express closes now.',
};

export function UpdatePanel({ onClose }: { onClose(): void }) {
  const state = useUpdates();
  const [problem, setProblem] = useState<string | null>(null);
  const available = state?.available;
  if (!state || !available) return null;
  const busy = state.phase !== 'idle';
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
      submitLabel={state.method === 'installer' ? 'Update now' : 'Open download page'}
      busy={busy}
      onSubmit={() => run(() => updates.install(), state.method === 'page')}
      footer={
        <button
          type="button"
          className="link-btn"
          disabled={busy}
          onClick={() => run(() => updates.skip(available.version), true)}
        >
          Skip this version
        </button>
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
          <span>{PHASE_TEXT[state.phase]}</span>
          <progress max={1} value={state.progress ?? undefined} />
        </div>
      )}
      {state.method === 'page' && !busy && (
        <p className="system-hint">
          This copy cannot update itself (portable or development build): the release page opens in
          your browser.
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
