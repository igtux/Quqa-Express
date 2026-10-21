# quqa-express backlog

Phased plan to v1. Each item has acceptance criteria (**AC**) and the Jarvis
NG source to port from (`/home/irakli/jarvis_ref`, reference only; keep
attribution in ported files). Feature statuses are in `docs/FEATURES.md`;
the stack and security model in `docs/adr/0001-stack-and-security.md`.

Short names: `gw/` = `apps/ssh-gateway/src/`, `web/` = `apps/web/src/`,
`term/` = `apps/web/src/terminal/`, `mach/` = `apps/web/src/machines/`.

---

## Phase 1: Electron shell, hardened IPC, SSH engine, one terminal

**Status: done** (e790750). The `app://` protocol, engine-side password
prompts and paste warnings, left open here, were finished in Phase 2.

### 1.1 Repository and tooling
- **AC:** pnpm workspace, TypeScript strict, ESLint, Prettier, Vitest;
  `pnpm check` (typecheck + lint + test) passes on a clean clone; lockfile
  committed; Apache-2.0 headers policy documented in AGENTS.md.
- **Port:** `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`
  conventions.

### 1.2 Electron shell with security defaults
- **AC:** one `BrowserWindow` with `contextIsolation`, `sandbox`,
  `nodeIntegration: false`; app content served from `app://` only; strict
  CSP header; navigation and `window.open` denied; permission requests
  denied; DevTools off in release builds. A test asserts these
  `webPreferences` and that loading a remote URL is refused.
- **Port:** — (new).

### 1.3 Typed, validated IPC
- **AC:** one schema file per channel (TypeBox); preload exposes a small
  `window.quqa` API built from the schemas; main and engine reject messages
  that fail validation (tested with malformed payloads); identifiers matched
  against strict patterns; no channel returns secrets (a test walks every
  response schema for `privateKey`/`passphrase`/`password` fields).
- **Port:** the `route()` + TypeBox pattern from Jarvis `packages/*` and
  `AGENTS.md` rule 3.

### 1.4 SSH engine in a utilityProcess
- **AC:** engine starts with the app, restarts if it crashes (renderer shows
  "engine restarted", terminals reconnect); talks to main over a
  `MessagePort`; per-terminal data on its own port; connection pool with
  keepalive 15 s × 3, Nagle off, `MaxSessions` headroom, `MaxStartups`
  reset retry; unit tests against an in-process ssh2 test server.
- **Port:** `gw/ssh/connection-pool.ts`, `gw/ssh/target.ts` (TCP only).

### 1.5 One terminal
- **AC:** connect to a host given in a temporary dev form (address, user,
  key file), run a shell, resize, type with no visible latency on a LAN;
  xterm.js WebGL with DOM fallback, Unicode 11, fit pipeline; exit shows
  "Session ended". Host key is checked against an in-memory pin (full trust
  flow in Phase 2).
- **Port:** `term/connection.ts` (xterm setup, fit, input), transport
  swapped from WebSocket to MessagePort; `gw/terminals/terminal-relay.ts`.

### 1.6 Reconnect and connection states
- **AC:** states connecting / connected / stale / AFK / disconnected /
  retry exhausted / refused / exited with the Jarvis texts; 45 s watchdog
  and probe (keepalive RTT); backoff 1/2/4/8/16/30 s × 6 ±20 % jitter;
  retry on resume from sleep; fatal codes stop retrying. Unit tests with
  fake timers.
- **Port:** `term/connection.ts` (watchdog, reconnect, fatal codes),
  legacy-ui `01b` §10.

---

## Phase 2: Vault, keys, host-key trust

**Status: done**, except where noted below. Design: ADR 0002.

- 2.1 done: vault file with modes `os` / `os+password` / `password`
  (portable), auto-lock on idle, sleep and screen lock, unlock screen,
  atomic writes with `.bak`, versioned format with migrations and KDF
  upgrade; tests for round trip, wrong password, tampering, moved items,
  versions and lock.
- 2.2 done: generate, import (paste or file; OpenSSH/PEM/PPK via ssh2) with
  saved or per-unlock passphrase, list, copy / export public key, delete;
  "used by N hosts" since Phase 3.
- 2.3 done: password and keyboard-interactive prompts engine-side, opt-in
  saved passwords; "Install my public key on this host" since Phase 4.
- 2.4 partly: pins persist in the vault, TOFU prompt, changed-key block with
  old/new fingerprints and a two-step replace, known_hosts import (plain
  and hashed). Open: scan without authenticating / Re-check in Edit Host /
  re-check on address change (need the hosts manager, Phase 3); strict
  mode stays v1.x.

### 2.1 Vault
- **AC:** encrypted vault file; per-item XChaCha20-Poly1305 (or AES-256-GCM)
  with item id + kind as associated data; random data key wrapped by
  `safeStorage`; optional master password (Argon2id, stored parameters);
  "portable vault" mode for the zip build; lock/unlock and auto-lock; a
  moved ciphertext fails to decrypt (test); a wrong password fails without
  leaking timing of partial matches; the data key never leaves the engine.
- **Port:** `packages/crypto/src/secret-box.ts` (context binding,
  versioned format).

### 2.2 Keys
- **AC:** generate Ed25519 (retry until ssh2 parses it back); import
  OpenSSH/PEM/PPK keys with passphrase from a file path or pasted text;
  list label, type, fingerprint, created; Copy public key; delete with "used
  by N hosts" warning; passphrase saved or asked per session; no API
  returns key material (test).
- **Port:** `gw/credentials/credential-store.ts`,
  `gw/credentials/generate.test.ts`, `mach/SshKeysTab.tsx`.

### 2.3 Password and keyboard-interactive auth
- **AC:** password and keyboard-interactive prompts shown in a dialog and
  answered straight to the engine; saving a password is opt-in; "Install my
  public key on this host" appends to `~/.ssh/authorized_keys` over SFTP
  with correct permissions, idempotently.
- **Port:** — (new).

### 2.4 Host-key trust
- **AC:** scan without authenticating (strongest type first); unknown host
  → trust dialog with SHA256 fingerprints; changed key → blocking dialog
  with previous fingerprint, replacement needs a second confirm; Re-check
  host key in Edit Host; changing address/port re-checks; pins stored in
  the app database; import pins from `~/.ssh/known_hosts` (plain and hashed
  entries); strict mode refuses unknown hosts.
- **Port:** `gw/ssh/host-keys.ts`, `gw/ssh/host-key-scan.ts`,
  `mach/HostKeyTrust.tsx`, `term/HostKeyDialog.tsx`, legacy-ui `01b` §10.4.

---

## Phase 3: Hosts manager, tabs, panes, favorites, dock, switcher

**Status: done**, except where noted below. Design: ADR 0003.

- 3.1 done: hosts in the vault with name, address, port, user, key or
  password, type, group, tags, colour, notes, tmux switch, per-host scheme
  and font, jump-host placeholder; add / edit / duplicate / delete (optionally
  forgetting the pinned key); compact status line (total, online, offline,
  avg latency), latency as TCP connect time cached 20 s, Ping all; search
  with `tag:` / `group:`, group filter, collapsible groups; connect counter
  and last used; keys show "used by N hosts". Open: file roots and the Files
  button (Phase 4), Windows setup guide, re-check host key on address change.
- 3.2 done: Ctrl+Shift+O picker, ad-hoc `user@host:port`, "Save as a host".
- 3.3 done: parser with wildcard defaults, Include / Match reported, preview
  with checkboxes, duplicates flagged, IdentityFile keys imported on consent
  (deduplicated by fingerprint; passphrase-protected keys reported), ProxyJump
  stored for Phase 4.
- 3.4 done: tabs (drag, rename, close, Ctrl+Tab), split side by side or
  stacked, pane headers in split view, + new terminal to the same host, F11,
  layout restored at start (switchable).
- 3.5 done: opt-in per host (default off), `quqa-<32 hex>` names, list / end /
  re-attach, 20 per host, "sessions on host" dialog, notice when a restored
  session had ended, history (copy-mode) scrolling with Live. Tested against
  tmux in the test server.
- 3.6 done: dock side panel (group, filter, states, card menu, hover
  preview, Close all), favorites bar (sessions and hosts, Alt+Shift+1…8),
  switcher. Open: pinned plain shells are not kept across restarts.
- 3.7 partly: 20 schemes, 12 font stacks (not bundled), theme dialog,
  zoom, search, bell and agent-finished attention with 30 s cooldown,
  desktop notifications through main, per-terminal mute, shortcuts list (F1),
  non-Latin shortcuts; the notice island and OSC 52 "remember for this host"
  since Phase 4. Open: bundled fonts, sound packs (a synthesized chime).

### 3.1 Hosts manager
- **AC:** add/edit/delete hosts (name, address, port, user, key or
  password, type Linux/Windows, description, file roots, tmux toggle,
  groups, tags, colour); start screen with dashboard (total, online/offline,
  avg latency); host cards with Open Terminal, Files, Edit, Ping, Test;
  live latency cached 20 s, Ping all; group filter and collapsible groups;
  search.
- **Port:** `mach/SshManager.tsx`, `mach/HostForms.tsx`, `mach/common.tsx`,
  legacy-ui `03a` §5.

### 3.2 Quick Connect
- **AC:** Ctrl+Shift+O opens a picker over all hosts with type-to-filter;
  `user@host:port` connects ad hoc (trust prompt applies) and offers to save.
- **Port:** `mach/QuickConnect.tsx`.

### 3.3 `~/.ssh/config` import
- **AC:** parses Host, HostName, User, Port, IdentityFile, ProxyJump (and
  ignores the rest with a note); preview with checkboxes; keys from
  IdentityFile offered for vault import; wildcard blocks applied as
  defaults; tested against sample configs.
- **Port:** — (new).

### 3.4 Tabs and split panes
- **AC:** tab strip with reorder, rename, close; two-pane split with active
  pane highlight, pane headers in split view only; keys, bell and scroll
  follow the active pane; + opens a new terminal to the same host; closing
  a pane returns to single view; fullscreen (F11); layout restored at next
  start.
- **Port:** `term/TerminalModal.tsx`, `term/TerminalProvider.tsx`
  (`place`, restore), legacy-ui `01b` §1–§4.

### 3.5 Resumable sessions via tmux
- **AC:** with tmux on the host, terminals run in `quqa-<hex>` sessions
  (`new-session -A`); closing a tab or a network drop keeps the session;
  reopening re-attaches; sessions listed from the host; "Session found on
  host" and "Session ended" dialogs; End session on host… with confirm;
  hosts without tmux get a plain shell; max 20 per host; tmux commands
  built only from validated names (tests).
- **Port:** `gw/terminals/tmux-attach.ts` (`own` mode only),
  `gw/terminals/terminal-relay.ts`, legacy-ui `01b` §13.

### 3.6 Sessions dock, favorites, switcher
- **AC:** dock lists every session (open or on the host) with states,
  idle, attention, unread; group by host; order pinned → attention →
  running → down → ended; fuzzy filter; card menu (Open, Pin/Unpin,
  Rename, Close, Forget, End on host); hover preview (≤ 18 lines); Close
  all; favorites bar (up to 8) with Alt+Shift+1…9; switcher on
  Ctrl+Shift+K (inside the terminal too), Ctrl+K only outside it.
- **Port:** `term/SessionsDock.tsx`, `term/dockModel.ts`,
  `term/SessionSwitcher.tsx`.

### 3.7 Look, history, clipboard, notifications
- **AC:** 20 schemes, 12 bundled fonts (BPG Courier first), theme dialog
  with preview; zoom 6–24 px with Ctrl+=/-/0; scroll mode auto/terminal
  history with Live button; search (Ctrl+Shift+F); copy on select,
  Ctrl+Shift+C/V; chunked paste (4 KiB) with progress and Cancel; paste
  warnings; OSC 52 write with per-host confirm, reads denied; notice
  island; bell and agent-finished attention with 30 s cooldown, native
  notifications, sound packs and volume; shortcuts on non-Latin layouts.
- **Port:** `term/themes.ts`, `term/ThemeModal.tsx`, `term/connection.ts`
  (history, paste queue, OSC 52, attention), `gw/terminals/tmux-history.ts`,
  `term/bell.ts`, `term/soundPacks.ts`, `term/notices.ts`,
  `term/NoticeIsland.tsx`, `web/kit/keys.ts`.

---

## Phase 4: Files, uploads, image paste, forwarding, jump hosts, agent

**Status: done**, except where noted below. Design: ADR 0004.

- 4.1 done: browser from a terminal (its connection, tmux folder) or a host
  card (shell-less `hold` login), Back/Up/Home/Refresh, typed path, search,
  typed icons, size/date/permissions, new folder, rename, delete (confirmed,
  recursive), drag to move; file roots enforced after `realpath` (e2e tests
  for `..` and symlink escapes).
- 4.2 done: downloads to a folder chosen in main's dialog (`.quqa-part`, a
  free name, never overwriting); resumable uploads into a hashed partial
  file; both resume by themselves after a drop and on Resume; Cancel; three
  at a time per connection; island with progress.
- 4.3 done: image (and, on Windows, copied files) paste through main's
  clipboard; drop on a terminal; grants instead of renderer paths. Default
  upload folder `~/uploads` (or the first file root), not `/tmp`.
- 4.4 done, plus `-R` and `-D` (SOCKS5) from "later": per-host saved forwards
  (optionally automatic), ad-hoc ones from a terminal, Tunnels screen.
- 4.5 done: chains, loops refused, every hop's pin and login, `ProxyJump`.
- 4.6 done: system agent (OpenSSH pipe / SSH_AUTH_SOCK) and Pageant, keys by
  fingerprint, forwarding per host with a warning. Open: confirm-each-use.
- Phase 3 leftovers done: OSC 52 "remember for this host"; 2.3's "Install my
  public key on this host".

### 4.1 SFTP file browser
- **AC:** browse with Back/Up/Home/Refresh, folders first, typed icons,
  search; new folder, rename, delete (recursive, confirmed), drag to move;
  paths normalised and kept under the host's file roots after resolving
  symlinks (tests for `..` and symlink escapes); opened from a terminal it
  starts in the program's folder when known.
- **Port:** `mach/Files.tsx`, `gw/files/remote-files.ts`,
  `gw/files/remote-paths.ts`.

### 4.2 Downloads and resumable uploads
- **AC:** download streams SFTP → a path chosen in a main-process save
  dialog; uploads stream disk → SFTP into a partial file and resume from
  its size after a drop; overwrite only after confirm; progress on the
  notice island; cancel works; multi-GB files without high memory.
- **Port:** `gw/files/remote-files.ts` (resumable uploads),
  `web/files/upload.ts`.

### 4.3 Image paste and drag and drop onto a terminal
- **AC:** an image on the clipboard is uploaded to the terminal's folder
  (or the host's upload folder, default `/tmp`) as
  `clipboard_<timestamp>.<ext>` and its shell-quoted path typed into the
  terminal; dropped files upload with the drop overlay; the renderer only
  passes paths that main re-validates.
- **Port:** `term/connection.ts` (onImagePaste),
  `term/TerminalProvider.tsx` (upload target), legacy-ui `01b` §8.

### 4.4 Local port forwarding
- **AC:** per-host saved forwards and ad-hoc ones; bind `127.0.0.1` by
  default (other addresses need a confirm); list of active tunnels with
  bytes and stop; port-in-use errors are clear; forwards close with their
  connection and reopen on reconnect.
- **Port:** direct-tcpip use in `gw/ssh/connection-pool.ts`.

### 4.5 Jump hosts
- **AC:** a host may name another saved host as its jump (chains allowed,
  loops refused); each hop verifies its own pinned host key and uses its
  own credentials; ProxyJump from `~/.ssh/config` maps to this.
- **Port:** the `openTransport` hook in `gw/ssh/host-key-scan.ts` and
  `gw/ssh/target.ts` (transport other than TCP).

### 4.6 SSH agent
- **AC:** authenticate with keys from the Windows OpenSSH agent
  (`\\.\pipe\openssh-ssh-agent`) or Pageant, selectable per host; agent
  forwarding off by default, per-host switch with a warning; keys shown by
  fingerprint only.
- **Port:** — (new; ssh2 agent support).

---

## Phase 5: Windows packaging, CI, release

**Status: done** (first pre-release `v0.1.0-beta.1`). Design: ADR 0005. The
owner chose to keep releases simple: no code signing, no Microsoft Store, no
SBOM or provenance attestations (moved to "later"), and a portable `.exe`
instead of a zip.

- 5.1 done: NSIS per-user installer (no admin; Start menu and desktop
  shortcuts; the uninstaller asks before deleting `%APPDATA%\quqa-express`,
  default No) and a portable exe that keeps `quqa-express-data\` next to
  itself; fuses as in Phase 1; `pagent.exe` unpacked from the asar so
  Pageant works in the packaged app. Product name `quqa-express`, version
  0.1.0, icon (`build/icon.svg` → `.ico`/`.png`, `scripts/icons.mjs`).
- 5.2 done: CI runs `pnpm check` on Ubuntu (with the Docker SSH server for
  the end-to-end tests, `pnpm audit --audit-level high`, the Playwright UI
  tests) and on Windows (end-to-end tests skip without Docker); a Windows job
  packages the app, smoke-tests the packaged build with Playwright (vault
  created with DPAPI, first-run welcome, About, restart), and uploads the
  installer, portable exe and checksums. Every failed test is listed in one
  annotation (`scripts/ci-failures.mjs`), since job logs need a login.
- 5.3 done: a `v*` tag runs `release.yml` on windows-latest (check, smoke
  test, build, `SHA256SUMS.txt`) and publishes a GitHub release, a
  pre-release when the tag has a suffix, with the SmartScreen and checksum
  notes; only `GITHUB_TOKEN` with `contents: write`.
- Release polish: About (F1 → About), first-run welcome offering the ssh
  config (with its key files), known_hosts and the Keys screen, window size
  and position remembered, Ctrl+click on `http(s)` links in terminals (main
  re-checks them), Windows test fixes (named-pipe agent test, POSIX-shell
  tests skipped, path joins).
- Moved to v1.x: leaving tmux copy-mode after a reconnect, an explicit
  host-key re-check when a host's address changes (the next connection
  already checks), known_hosts write-back, the sound packs (v1 has a chime),
  agent confirm-each-use.

### 5.1 Packaging
- **AC:** electron-builder produces an unsigned NSIS installer (per-user
  install, no admin) and a portable exe; Electron fuses set (RunAsNode off,
  NODE_OPTIONS off, inspect args off, asar integrity on, only load from
  asar); app data in `%APPDATA%\quqa-express` (portable: next to the exe);
  uninstall keeps the vault unless asked.
- **Port:** — (new).

### 5.2 CI on GitHub Actions
- **AC:** `windows-latest` and `ubuntu-latest` run
  `pnpm install --frozen-lockfile` and `pnpm check`; Ubuntu adds the
  end-to-end tests against the Docker SSH server, `pnpm audit` (fail on
  high) and the UI tests; Windows packages the app, smoke-tests the packaged
  build with Playwright for Electron and keeps the installer and portable exe
  as artifacts on every push to `main`.
- **Port:** Jarvis CI's security-scan ideas (`AGENTS.md` workflow).

### 5.3 Release
- **AC:** a tag `v*` builds, writes `SHA256SUMS.txt` and attaches the
  installer, the portable exe and the checksums to a GitHub (pre-)release
  with notes that explain the SmartScreen warning and how to verify the
  checksums; README install section matches.
- **Port:** — (new).

---

## After v1 (v1.x / later)

Toolbar key buttons, background cap/parking, "Where it runs", quick
commands, transfer queue (pause, recents), agent confirm-each-use, history
overlay from `capture-pane`, leave tmux copy-mode after a reconnect, host-key
re-check on an address change, known_hosts write-back, sound packs, scrollback
export, configurable shortcuts, per-host themes, "My sounds", host list
export/import, RSA/ECDSA generation; later: macOS and Linux builds, multiple
windows, proxies, FIDO2 keys, edit remote files
locally, session logging, opt-in unsigned self-update check, SBOM and build
provenance attestations for releases, code signing, optional AI
recap with the user's own API key (Jarvis ADR 0029, `term/summaries.ts`).
