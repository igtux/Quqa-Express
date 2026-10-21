/**
 * The notice island: floats at the top of the window, centred, and shows
 * uploads and downloads with live progress (Cancel, Resume), "copied" and
 * "path pasted" messages and errors.
 *
 * Ported from Jarvis NG (apps/web/src/terminal/NoticeIsland.tsx), same owner,
 * without the voice and activity parts.
 */
import { useSyncExternalStore } from 'react';
import type { Notice, Notices } from '../terminal/notices.js';

export function NoticeIsland({ notices }: { notices: Notices }) {
  useSyncExternalStore(notices.subscribe, notices.getVersion);
  if (notices.notices.length === 0) return null;
  return (
    <div className="term-island" role="status" aria-live="polite" data-testid="notice-island">
      {notices.notices.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} onClose={() => notices.dismiss(notice.id)} />
      ))}
    </div>
  );
}

function NoticeCard({ notice, onClose }: { notice: Notice; onClose(): void }) {
  const percent =
    notice.kind === 'progress' && typeof notice.progress === 'number'
      ? Math.round(notice.progress * 100)
      : null;
  return (
    <div
      className={`term-island-card ${notice.kind}${notice.leaving ? ' leaving' : ''}`}
      data-testid="notice"
    >
      <span className="term-island-icon" aria-hidden>
        {notice.kind === 'progress' && <span className="term-island-spinner" />}
        {notice.kind === 'success' && (
          <svg viewBox="0 0 24 24">
            <path className="term-island-check" d="M5 12.5l4.2 4.2L19 7" />
          </svg>
        )}
        {notice.kind === 'error' && (
          <svg viewBox="0 0 24 24">
            <path d="M12 7v6M12 16.5v.5" />
          </svg>
        )}
        {notice.kind === 'info' && <span className="term-island-dot" />}
      </span>
      <span className="term-island-text">
        <span className="term-island-title">
          {notice.text}
          {percent !== null && <span className="term-island-percent">{percent}%</span>}
        </span>
        {notice.detail && (
          <span className="term-island-detail" title={notice.detail}>
            {notice.detail}
          </span>
        )}
      </span>
      {notice.actions && notice.actions.length > 0 && (
        <span className="term-island-actions">
          {notice.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`term-island-action${action.label === 'Cancel' ? '' : ' neutral'}`}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </span>
      )}
      {notice.kind !== 'progress' && (
        <button type="button" className="term-island-close" aria-label="Dismiss" onClick={onClose}>
          ×
        </button>
      )}
      {notice.kind === 'progress' && (
        <span className="term-island-bar" aria-hidden>
          <span
            className={`term-island-fill${percent === null ? ' indeterminate' : ''}`}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </span>
      )}
    </div>
  );
}
