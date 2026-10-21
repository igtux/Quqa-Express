/**
 * Terminal Theme: 20 colour schemes, 12 fonts, a live preview; Apply restyles
 * every open terminal (hosts with their own look keep it). Also the
 * notification switches and "re-open tabs at start".
 *
 * Ported from Jarvis NG (apps/web/src/terminal/ThemeModal.tsx), same owner.
 */
import { useState } from 'react';
import type { UiState } from '../../../shared/ipc.js';
import { playChime } from '../terminal/chime.js';
import { FONTS, SCHEMES, fontById, fontFamily, schemeById } from '../terminal/themes.js';
import { Dialog } from './Dialog.js';

export function ThemeDialog({
  ui,
  onApply,
  onClose,
}: {
  ui: UiState;
  onApply(change: Partial<UiState>): void;
  onClose(): void;
}) {
  const [scheme, setScheme] = useState(ui.scheme);
  const [font, setFont] = useState(ui.font);
  const [notifications, setNotifications] = useState(ui.notifications);
  const [sound, setSound] = useState(ui.sound);
  const [restoreTabs, setRestoreTabs] = useState(ui.restoreTabs);
  const current = schemeById(scheme);
  const family = fontFamily(fontById(font));

  return (
    <Dialog
      title="Terminal Theme"
      wide
      className="theme-dialog"
      onClose={onClose}
      submitLabel="Apply"
      onSubmit={() => {
        onApply({ scheme, font, notifications, sound, restoreTabs });
        onClose();
      }}
    >
      <span className="terminal-theme-label">Colour scheme</span>
      <div className="terminal-theme-schemes" role="radiogroup" aria-label="Colour scheme">
        {SCHEMES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={s.id === scheme}
            className={`terminal-theme-scheme${s.id === scheme ? ' selected' : ''}`}
            onClick={() => setScheme(s.id)}
          >
            <span
              className="terminal-theme-scheme-preview"
              style={{ background: s.bg, color: s.fg, border: `1px solid ${s.cursor}` }}
            >
              Aa
            </span>
            <span className="terminal-theme-scheme-name">{s.name}</span>
          </button>
        ))}
      </div>
      <span className="terminal-theme-label">Font</span>
      <div className="terminal-theme-fonts" role="radiogroup" aria-label="Font">
        {FONTS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={f.id === font}
            className={`terminal-theme-font${f.id === font ? ' selected' : ''}`}
            onClick={() => setFont(f.id)}
          >
            <span className="terminal-theme-font-sample" style={{ fontFamily: fontFamily(f) }}>
              AaBb 123 ქართ
            </span>
            <span className="terminal-theme-font-name">{f.name}</span>
          </button>
        ))}
      </div>
      <span className="terminal-theme-label">Preview</span>
      <div
        className="terminal-theme-preview"
        style={{ background: current.bg, color: current.fg, fontFamily: family }}
      >
        <div>
          <span className="preview-prompt">user@host</span>:
          <span className="preview-path">~/projects</span>$ ls -la
        </div>
        <div>
          drwxr-xr-x 4 user user 4096 Jan 15 10:30 <span className="preview-dir">src</span>
        </div>
        <div>
          -rw-r--r-- 1 user user 1234 Jan 15 10:28 <span className="preview-file">README.md</span>
        </div>
        <div>
          <span className="preview-prompt">user@host</span>:
          <span className="preview-path">~/projects</span>${' '}
          <span style={{ color: current.cursor }}>▋</span>
        </div>
      </div>
      <span className="terminal-theme-label">
        When a background terminal rings or an agent finishes
      </span>
      <label className="system-check">
        <input
          type="checkbox"
          checked={notifications}
          onChange={(e) => setNotifications(e.target.checked)}
        />
        <span>Show a desktop notification (clicking it opens the terminal)</span>
      </label>
      <label className="system-check">
        <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />
        <span>
          Play a chime{' '}
          <button type="button" className="link-btn" onClick={() => playChime()}>
            Preview
          </button>
        </span>
      </label>
      <label className="system-check">
        <input
          type="checkbox"
          checked={restoreTabs}
          onChange={(e) => setRestoreTabs(e.target.checked)}
        />
        <span>Re-open the last tabs at start (tmux sessions re-attach)</span>
      </label>
    </Dialog>
  );
}
