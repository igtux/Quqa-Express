/** The keyboard shortcuts list (F1). Letters are matched by key position, so they work on Georgian and other layouts. */
import { Dialog } from './Dialog.js';

export const SHORTCUTS: [string, string][] = [
  ['Ctrl+Shift+K', 'Switch session (also inside a terminal)'],
  ['Ctrl+K', 'Switch session (outside a terminal)'],
  ['Ctrl+Shift+O', 'Quick connect'],
  ['Ctrl+Shift+S', 'Sessions dock'],
  ['Ctrl+Shift+T', 'New terminal to the same host'],
  ['Ctrl+Shift+D', 'Split side by side'],
  ['Ctrl+Shift+E', 'Split one above the other'],
  ['Ctrl+Shift+← / →', 'Other pane'],
  ['Ctrl+Shift+W', 'Close the pane'],
  ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
  ['Ctrl+PageDown / PageUp', 'Next / previous tab'],
  ['Alt+Shift+1…8', 'Open favorite 1…8'],
  ['Ctrl+Shift+H', 'Hosts'],
  ['Ctrl+Shift+F', 'Search the scrollback (Enter next, Shift+Enter previous)'],
  ['Ctrl+Shift+C / Ctrl+Shift+V', 'Copy / paste (right click pastes too)'],
  ['Ctrl+= / Ctrl+- / Ctrl+0', 'Larger / smaller / default text'],
  ['F11', 'Full screen'],
  ['F1', 'This list'],
];

export function ShortcutsDialog({ onClose }: { onClose(): void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} cancelLabel="Close" wide>
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
