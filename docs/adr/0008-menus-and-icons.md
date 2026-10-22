# ADR 0008: One menu component, Lucide icons

- Status: accepted
- Date: 2026-10-22
- Deciders: AURA (project owner)
- Refines: ADR 0006 (themes)

## Context

By 0.1.0-beta.9 the app had grown three hand-made menus (the local shells
menu, the dock card menu and nothing on tabs), a row of five icon buttons
at the right of the top bar, and nine buttons on every host card. The owner
asked for menus that are simple and easy to understand, with fun, friendly
icons, fewer items, clear groups, plain words and the keyboard shortcuts
shown. A menu opened from the sessions dock also landed off screen: glass
panels use `backdrop-filter`, which makes `position: fixed` relative to the
panel.

## Decision

- **One `Menu` component** (`components/Menu.tsx`, rules in `menuModel.ts`)
  for every menu: items with an icon chip, a label, an optional hint line,
  badge and shortcut; headings and separators. Arrow keys, Home/End,
  Enter, Escape (focus goes back to the opener), Tab and a click outside
  close it. It renders into `.app-shell` through a portal and keeps itself
  inside the window (opens upwards near the bottom).
- **Fewer buttons.** The top bar keeps the update badge, Sessions and Switch;
  Look and notifications, Keyboard shortcuts, Check for updates / Update to
  …, About and Lock move into the **main menu** (☰). Host cards keep Open a
  terminal, Files, Sessions (tmux) and the star; Ping, Install a key, Edit,
  Duplicate and Delete move into **More** (⋯). Tabs get a right-click menu
  (also the context-menu key and Shift+F10): Rename, another terminal like
  this one, splits, Files, favorite, close the other tabs, close.
- **Icons: a subset of Lucide** (ISC; a few icons from Feather, MIT), copied
  as SVG element data into `components/menuIcons.ts`. No package, no font,
  nothing loaded at run time (AGENTS.md §8). Each item sits on a soft
  coloured chip, one colour per kind of action (red only for destructive
  ones), which reads at a glance in both themes.

## Consequences

- Adding a menu means passing a list of entries; the keyboard rules and the
  placement are tested once (`menuModel.test.ts`, `test/ui/menus.spec.ts`).
- Menu items are `menuitem`s, not buttons: UI tests open the menu first.
- New icons are copied from Lucide with their element data; the licence is
  in `licenses/ISC-lucide.txt` and THIRD_PARTY_NOTICES.md.
