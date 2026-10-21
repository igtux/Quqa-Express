/** A paste that would run commands or holds control characters: the user decides. */
import type { PasteRequest } from '../terminal/connection.js';
import { lineCount, visiblePaste } from '../terminal/paste.js';
import { Icon } from './icons.js';
import { useModalDialog } from './useModalDialog.js';

export function PasteDialog({
  request,
  onAnswer,
}: {
  request: PasteRequest;
  onAnswer(allow: boolean): void;
}) {
  const ref = useModalDialog(() => onAnswer(false));
  const { text, risks } = request;
  const reasons: string[] = [];
  if (risks.includes('multiline')) {
    reasons.push(`It has ${lineCount(text)} lines; each line ending runs a command at once.`);
  }
  if (risks.includes('control')) {
    reasons.push(
      'It holds control characters (shown as ⟨ESC⟩ and similar) that act on the terminal.',
    );
  }
  if (risks.includes('large')) {
    reasons.push(`It is large (${text.length.toLocaleString()} characters).`);
  }
  return (
    <dialog ref={ref} className="terminal-decision warning" aria-labelledby="paste-title">
      <div className="terminal-decision-body">
        <div className="terminal-decision-heading">
          <span className="terminal-decision-icon">
            <Icon name="clipboard" />
          </span>
          <h3 id="paste-title">Paste this?</h3>
        </div>
        {reasons.map((reason) => (
          <p className="terminal-decision-note" key={reason}>
            {reason}
          </p>
        ))}
        <div className="terminal-decision-preview" data-testid="paste-preview">
          {visiblePaste(text)}
        </div>
      </div>
      <div className="terminal-decision-actions">
        <button type="button" className="terminal-decision-btn" onClick={() => onAnswer(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="terminal-decision-btn primary"
          onClick={() => onAnswer(true)}
        >
          Paste
        </button>
      </div>
    </dialog>
  );
}
