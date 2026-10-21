# quqa-express backlog

Phased plan to v1. Each item has acceptance criteria (**AC**) and the Jarvis
NG source to port from (`/home/irakli/jarvis_ref`, reference only; keep
attribution in ported files). Feature statuses are in `docs/FEATURES.md`;
the stack and security model in `docs/adr/0001-stack-and-security.md`.

Short names: `gw/` = `apps/ssh-gateway/src/`, `web/` = `apps/web/src/`,
`term/` = `apps/web/src/terminal/`, `mach/` = `apps/web/src/machines/`.

---

## Phase 1: Electron shell, hardened IPC, SSH engine, one terminal

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

### 5.1 Packaging
- **AC:** electron-builder produces an unsigned NSIS installer (per-user
  install, no admin) and a portable zip; Electron fuses set (RunAsNode off,
  NODE_OPTIONS off, inspect args off, asar integrity on, only load from
  asar); app data in `%APPDATA%\quqa-express` (portable: next to the exe);
  uninstall keeps the vault unless asked.
- **Port:** — (new).

### 5.2 CI on GitHub Actions
- **AC:** `windows-latest` (and `ubuntu-latest` for lint/tests) runs
  `pnpm install --frozen-lockfile`, `pnpm check`, an end-to-end smoke test
  (Playwright for Electron) against an ssh2 test server, `pnpm audit`
  (fail on high), CycloneDX SBOM, secret scanning; builds the installer and
  zip as artifacts on every push to `main`.
- **Port:** Jarvis CI's security-scan ideas (`AGENTS.md` workflow).

### 5.3 Release
- **AC:** a tag `v*` builds, writes `SHA256SUMS.txt`, adds build provenance
  attestations, attaches installer, zip, checksums and SBOM to a GitHub
  Release with notes that explain the SmartScreen warning and how to
  verify checksums; README install section matches.
- **Port:** — (new).

---

## After v1 (v1.x / later)

Toolbar key buttons, background cap/parking, "Where it runs", quick
commands, transfer queue, history overlay from `capture-pane`, scrollback
export, configurable shortcuts, per-host themes, "My sounds", host list
export/import, RSA/ECDSA generation; later: macOS and Linux builds, multiple
windows, remote/dynamic forwarding, proxies, FIDO2 keys, edit remote files
locally, session logging, opt-in unsigned self-update check, optional AI
recap with the user's own API key (Jarvis ADR 0029, `term/summaries.ts`).
