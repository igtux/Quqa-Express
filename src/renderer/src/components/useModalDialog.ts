import { useEffect, useRef } from 'react';

/** Opens a <dialog> as a modal on mount; Escape calls `onCancel`. */
export function useModalDialog(onCancel: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef(onCancel);
  useEffect(() => {
    cancel.current = onCancel;
  }, [onCancel]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const onEscape = (event: Event) => {
      event.preventDefault();
      cancel.current();
    };
    dialog.addEventListener('cancel', onEscape);
    return () => {
      dialog.removeEventListener('cancel', onEscape);
      if (dialog.open) dialog.close();
    };
  }, []);
  return ref;
}
