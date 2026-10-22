# Third-party notices

quqa-express is licensed under the Apache License 2.0 (`LICENSE`). It ships
the following third-party files unmodified, each under its own licence. The
licence texts are in `licenses/` here and in `resources/licenses/` of the
installed app.

## Fonts

Both fonts are bundled because the app is offline. They are served only to
the app's own window, from `src/renderer/src/assets/fonts/`, and cover only
the Georgian blocks (`styles/fonts.css`).

### BPG Courier S GPL&GNU (`bpg-courier.ttf`)

- Monospace Georgian for the terminal, in every terminal font stack.
- Copyright (c) BPG-InfoTech, 2009. Version 4.000. Designed by Besarion
  Gugushvili (http://groups.google.com/group/bpg-fonts).
- Licence: the font's own licence entry (name table, ID 13) says: "May be
  distributed under the terms of General Public License (GPL).
  http://www.gnu.org/licenses/gpl.html. Are licensed for free distribution
  by individuals and by companies independently, or along with any GNU Linux
  System or other open-source software, as well for free use of the
  typefaces". No GPL version is named, so per the GPL any version may be
  chosen. The GPL v3 text is in `licenses/GPL-3.0-bpg-courier.txt`.
- **Redistribution is allowed.** The font ships unmodified as a separate
  file that the app loads at run time. This is mere aggregation with the
  Apache-2.0 app, which does not become GPL. The font file is its own
  "source". The same file is in Jarvis NG (`apps/web/src/assets/fonts/`).
- "BPG Courier S GPL&GNU" is a trademark of BPG-InfoTech. The app refers to
  the font by the CSS family name "BPG Courier".

### Noto Sans Georgian (`noto-sans-georgian.ttf`)

- Proportional Georgian (Mkhedruli, Mtavruli, Asomtavruli, Nuskhuri) for the
  UI, and the terminal's fallback for Mtavruli capitals. Variable font,
  weights 100 to 900, version 2.005.
- Copyright 2022 The Noto Project Authors
  (https://github.com/notofonts/georgian).
- Licence: SIL Open Font License 1.1 (`licenses/OFL-1.1-noto-sans-georgian.txt`).
  Bundling with software is allowed. The font is not sold on its own, and it
  is used under the CSS family name "Quqa Georgian Sans", so the Reserved
  Font Name clause does not come into play.

## Icons

### Lucide (menu icons)

- About 40 icons from Lucide 1.61.0 (https://lucide.dev), copied as SVG
  element data into `src/renderer/src/components/menuIcons.ts` (nothing is
  loaded from the network). Some of them (check, info, power, terminal, x)
  come from Feather.
- Copyright (c) 2026 Lucide Icons and Contributors; Feather icons
  Copyright (c) 2013-present Cole Bemis. Licence: ISC, Feather's part MIT
  (`licenses/ISC-lucide.txt`).

## npm packages

The JavaScript dependencies (Electron, React, xterm.js, ssh2, node-pty,
@noble/*, typebox and their dependencies) are listed with their licences in
`pnpm-lock.yaml` and in each package's own folder. All are MIT, ISC, BSD or
Apache-2.0 licensed.

### node-pty (local terminals)

- Pseudo-terminals for local shells (ADR 0007), with its prebuilt native
  modules. On Windows it also ships `conpty.dll` and `OpenConsole.exe`, the
  console host of Windows Terminal (Microsoft, MIT).
- Copyright (c) 2012-2015 Christopher Jeffrey, (c) 2016 Daniel Imms,
  (c) 2018 Microsoft Corporation. Licence: MIT (`licenses/MIT-node-pty.txt`;
  also `node_modules/node-pty/LICENSE` inside the app).
