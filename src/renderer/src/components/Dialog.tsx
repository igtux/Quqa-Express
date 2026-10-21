/**
 * The app's small modal on a native <dialog>: focus stays inside, Escape
 * cancels, Enter submits. Modelled on Jarvis NG's SmallDialog
 * (apps/web/src/machines/common.tsx, `.rename-modal`), same owner.
 */
import { useId, type FormEvent, type ReactNode } from 'react';
import { useModalDialog } from './useModalDialog.js';

export function Dialog({
  title,
  children,
  onClose,
  onSubmit,
  submitLabel = 'Save',
  busy = false,
  danger = false,
  submitDisabled = false,
  wide = false,
  cancelLabel = 'Cancel',
  footer,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  onClose(): void;
  onSubmit?: () => void;
  submitLabel?: string;
  busy?: boolean;
  danger?: boolean;
  submitDisabled?: boolean;
  wide?: boolean;
  cancelLabel?: string;
  /** Extra buttons on the left of the actions row. */
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useModalDialog(onClose);
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      className={`app-dialog${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
    >
      <form
        className="app-dialog-form"
        noValidate
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!busy && !submitDisabled) onSubmit?.();
        }}
      >
        <h3 id={titleId} className="app-dialog-title">
          {title}
        </h3>
        <div className="app-dialog-body">{children}</div>
        <div className="app-dialog-actions">
          {footer && <div className="app-dialog-footer">{footer}</div>}
          <button type="button" className="system-btn ghost inline" onClick={onClose}>
            {cancelLabel}
          </button>
          {onSubmit && (
            <button
              type="submit"
              className={`system-btn inline ${danger ? 'danger' : 'primary'}`}
              disabled={busy || submitDisabled}
            >
              {submitLabel}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
