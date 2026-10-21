/** The keyboard shortcuts list (F1). Letters are matched by key position, so they work on Georgian and other layouts. */
import { Dialog } from './Dialog.js';

export const SHORTCUTS: [string, string][] = [
  ['Ctrl+Shift+K', 'Switch session (also inside a terminal)'],
  ['Ctrl+K', 'Switch session (outside a terminal)'],
  ['Ctrl+Shift+O', 'Quick connect'],
  ['Ctrl+Shift+S', 'Sessions dock'],
  ['Ctrl+Shift+T', 'New terminal to the same host (a local one from Hosts)'],
  ['Ctrl+Shift+`', 'New local terminal (the default shell)'],
  ['Ctrl+Shift+D', 'Split side by side'],
  ['Ctrl+Shift+E', 'Split one above the other'],
  ['Ctrl+Shift+← / →', 'Other pane'],
  ['Ctrl+Shift+W', 'Close the pane'],
  ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
  ['Ctrl+PageDown / PageUp', 'Next / previous tab'],
  ['Alt+Shift+1…8', 'Open favorite 1…8'],
  ['Ctrl+Shift+H', 'Hosts'],
  ['Ctrl+Shift+F', 'Search the scrollback (Enter next, Shift+Enter previous)'],
  [
    'Ctrl+V / Ctrl+Shift+V / Shift+Insert',
    'Paste text, an image or copied files (right click too)',
  ],
  ['Ctrl+C with a selection / Ctrl+Shift+C', 'Copy (Ctrl+C without a selection interrupts)'],
  ['Ctrl+click a link', 'Open an http(s) address in your browser'],
  ['Ctrl+= / Ctrl+- / Ctrl+0', 'Larger / smaller / default text'],
  ['F11', 'Full screen'],
  ['F1', 'This list'],
];

export function ShortcutsDialog({ onClose, onAbout }: { onClose(): void; onAbout(): void }) {
  return (
    <Dialog
      title="Keyboard shortcuts"
      onClose={onClose}
      cancelLabel="Close"
      wide
      footer={
        <button type="button" className="system-btn ghost inline" onClick={onAbout}>
          About quqa-express
        </button>
      }
    >
      <table className="shortcuts-table">
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}>
              <td>
                <kbd>{keys}</kbd>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="system-hint">
        Selecting text copies it. Ctrl+C in a terminal goes to the program.
      </p>
    </Dialog>
  );
}
