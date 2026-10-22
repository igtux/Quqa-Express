/**
 * The one menu of the app: a small floating list with a friendly icon chip
 * per item, plain-language labels, an optional hint line and the keyboard
 * shortcut at the right. Arrow keys, Home/End, Enter and Escape work as in
 * any desktop menu; a click outside or Tab closes it and focus goes back to
 * what opened it.
 *
 * It is rendered into `.app-shell` (not inside the panel that opened it):
 * glass panels use backdrop-filter, which would make `position: fixed`
 * relative to the panel and push the menu off screen.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { MENU_ICONS, type MenuIconName } from './menuIcons.js';
import { isItem, moveFocus, placeMenu, tidy, type MenuEntry } from './menuModel.js';

export type { MenuEntry } from './menuModel.js';

export function MenuIcon({ name, className }: { name: MenuIconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {MENU_ICONS[name].map(([tag, attrs], i) => {
        const Tag = tag;
        return <Tag key={i} {...attrs} />;
      })}
    </svg>
  );
}

export function Menu({
  label,
  title,
  at,
  entries,
  onClose,
  footer,
  className,
}: {
  /** Accessible name of the menu. */
  label: string;
  /** A small caption at the top (e.g. the session's name). */
  title?: ReactNode;
  at: { x: number; y: number };
  entries: readonly (MenuEntry | false | null | undefined)[];
  onClose(): void;
  /** Extra controls under the items (e.g. the default shell). */
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const list = tidy(entries);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setPlace(
      placeMenu(
        at,
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [at]);

  const items = () =>
    [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].filter(
      (b) => !b.disabled,
    );

  /** Closes and gives focus back to the button that opened the menu. */
  const close = () => {
    onClose();
    const back = opener.current;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  };

  useEffect(() => {
    opener.current = document.activeElement;
    items()[0]?.focus();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The button that opened the menu toggles it itself.
      if (opener.current?.contains(target)) return;
      if (!ref.current?.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        close();
      }
    };
    const onResize = () => onClose();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Tab') {
      onClose();
      return;
    }
    const buttons = items();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = moveFocus(
      event.key,
      current,
      buttons.map(() => true),
    );
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  const menu = (
    <div
      ref={ref}
      className={`app-menu${className ? ` ${className}` : ''}`}
      role="menu"
      aria-label={label}
      style={place ? { left: place.left, top: place.top } : { left: at.x, top: at.y, opacity: 0 }}
      onKeyDown={onKeyDown}
      // React events bubble through the portal to whatever opened the menu
      // (a tab, a dock row); they stop here.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onAuxClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {title && <div className="app-menu-title">{title}</div>}
      {list.map((entry, index) => {
        if (entry.kind === 'separator') {
          return <div key={index} className="app-menu-sep" role="separator" />;
        }
        if (entry.kind === 'heading') {
          return (
            <div key={index} className="app-menu-heading" role="presentation">
              {entry.label}
            </div>
          );
        }
        if (!isItem(entry)) return null;
        return (
          <button
            key={index}
            type="button"
            role="menuitem"
            className={`app-menu-item${entry.danger ? ' danger' : ''}`}
            disabled={entry.disabled}
            aria-label={entry.label}
            aria-keyshortcuts={entry.shortcut}
            title={entry.hint}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            <span
              className={`app-menu-chip tone-${entry.danger ? 'red' : (entry.tone ?? 'slate')}`}
            >
              <MenuIcon name={entry.icon} />
            </span>
            <span className="app-menu-text">
              <span className="app-menu-label">
                {entry.label}
                {entry.badge && <span className="app-menu-badge">{entry.badge}</span>}
              </span>
              {entry.hint && <span className="app-menu-hint">{entry.hint}</span>}
            </span>
            {entry.shortcut && <kbd className="app-menu-kbd">{entry.shortcut}</kbd>}
          </button>
        );
      })}
      {footer && <div className="app-menu-footer">{footer}</div>}
    </div>
  );
  return createPortal(menu, document.querySelector('.app-shell') ?? document.body);
}

/** Where a menu opens for a button: under it, right edges aligned when `align` is 'end'. */
export function below(button: Element, align: 'start' | 'end' = 'start', width = 260) {
  const box = button.getBoundingClientRect();
  return { x: align === 'end' ? box.right - width : box.left, y: box.bottom + 6 };
}
