/** A remote program asked to set the clipboard (OSC 52): the user decides. */
import { Icon } from './icons.js';
import { useModalDialog } from './useModalDialog.js';

const PREVIEW = 600;

export function ClipboardDialog({
  text,
  onAnswer,
}: {
  text: string;
  onAnswer(allow: boolean): void;
}) {
  const ref = useModalDialog(() => onAnswer(false));
  const preview = text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text;
  return (
    <dialog ref={ref} className="terminal-decision" aria-labelledby="clipboard-title">
      <div className="terminal-decision-body">
        <div className="terminal-decision-heading">
          <span className="terminal-decision-icon">
            <Icon name="clipboard" />
          </span>
          <h3 id="clipboard-title">Copy to clipboard?</h3>
        </div>
        <p className="terminal-decision-note">
          A program on the server wants to put {text.length.toLocaleString()} characters on your
          clipboard.
        </p>
        <div className="terminal-decision-preview">{preview}</div>
      </div>
      <div className="terminal-decision-actions">
        <button type="button" className="terminal-decision-btn" onClick={() => onAnswer(false)}>
          Deny
        </button>
        <button
          type="button"
          className="terminal-decision-btn primary"
          onClick={() => onAnswer(true)}
        >
          Copy
        </button>
      </div>
    </dialog>
  );
}
