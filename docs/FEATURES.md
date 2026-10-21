# quqa-express features

The inventory of every user-facing terminal and SSH feature of Jarvis NG
(the web platform quqa-express is ported from), and what quqa-express does
with each one.

Jarvis NG lives at `/home/irakli/jarvis_ref` (reference only). Paths in the
**Jarvis** column are relative to it. Behaviour notes come from the code and
from `docs/FEATURES.md` and `docs/legacy-ui/01a-shell.md`, `01b-terminal.md`,
`03a-access-and-machines-ssh.md`, `03b-access-and-machines-files-users.md`
there.

## Status

Rows marked **Built (Phase n)** are implemented; see `docs/BACKLOG.md` for
what each phase finished and what is still open.

| Status       | Meaning                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| **v1**       | In the first public release.                                                |
| **v1.x**     | Planned soon after v1, no design change needed.                             |
| **later**    | Wanted, but needs more design or an opt-in the user configures themselves.  |
| **excluded** | Not in quqa-express: voice/speech, terminal sharing, or server/multi-user only. |

quqa-express is a single-user, fully offline desktop app. There is no server
in between: the app itself is the "gateway". Wherever Jarvis says "the
gateway does X", quqa-express does X in its **SSH engine** (an Electron
`utilityProcess`); wherever Jarvis says "the browser", read "the renderer".
Permissions, roles, audit and sharing collapse to "the person at the
keyboard".

Short names used below:

- `gw/` = `apps/ssh-gateway/src/`
- `web/` = `apps/web/src/`
- `term/` = `apps/web/src/terminal/`
- `mach/` = `apps/web/src/machines/`

---

## 1. Terminal window and layout

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Terminal window with header bar (title, status badge, controls) and body | `term/TerminalModal.tsx` | v1 | Becomes the main window content instead of a modal; same header controls. **Built (Phase 3).** |
| Several terminals at once ("live cards"), each its own xterm + connection that outlives the UI showing it | `term/TerminalProvider.tsx`, `term/connection.ts` | v1 | Each tab owns a renderer-side xterm and an engine-side SSH channel; hiding a tab never closes it. **Built (Phase 3).** |
| Tabs (switch terminals) | dock + favorites in Jarvis (`term/SessionsDock.tsx`) | v1 | Desktop gets a real tab strip in addition to the dock/switcher; drag to reorder. **Built (Phase 3): drag to reorder, double-click to rename, × or middle click to close, Ctrl+Tab.** |
| Split view: two panes side by side, active pane highlighted, keys/bell/scroll follow the active pane, closing one pane returns to single view | `term/TerminalModal.tsx`, `term/TerminalProvider.tsx` (`place`), legacy-ui `01b` §4 | v1 | Same two-pane split; vertical/horizontal split and more than two panes are v1.x. **Built (Phase 3): side by side (Ctrl+Shift+D) or one above the other (Ctrl+Shift+E), already in v1.** |
| Pane headers only in split view (status dot, name, close) | legacy-ui `01b` §4 | v1 | Same. **Built (Phase 3).** |
| "New terminal to the same host" (+ button, same login) | `term/TerminalModal.tsx` | v1 | Opens a new tab on the same host with the same key. **Built (Phase 3), Ctrl+Shift+T.** |
| Minimize (session keeps running), backdrop click / Escape minimizes | `term/TerminalModal.tsx` | excluded | Web modal behaviour; on desktop a tab is just hidden behind another tab. |
| ✕ closes the visible panes, tmux keeps running | `term/TerminalModal.tsx` | v1 | Closing a tab closes the SSH channel; with tmux the session survives on the host (see §3). **Built (Phase 3).** |
| Fullscreen (refit at 120 ms and 260 ms) | `term/TerminalModal.tsx` | v1 | Electron `BrowserWindow.setFullScreen`, F11. **Built (Phase 3).** |
| Header overflow on narrow windows (hide IDE → quick commands → theme → zoom) | `term/TerminalModal.tsx`, legacy-ui `01b` §3.11 | v1 | Same collapse order. **Built (Phase 3): controls hide by window width.** |
| Keys group in the toolbar (ESC, Tab, ^C twice "exit agent", ↑ ↓ ← →, Enter) | `term/TerminalModal.tsx`, `term/KeyButton.tsx` | v1.x | Kept as optional toolbar buttons (off by default on desktop; handy for agents). |
| Phone keys bar, on-screen keyboard handling, swipe scroll, choice picker, install as PWA | `term/MobileKeysBar.tsx`, `term/visualViewport.ts`, legacy-ui `01b` §12 | excluded | Phone-only; quqa-express is a desktop app. |
| Background cap: more than 8 live cards in the background → the least recently viewed is parked (socket closed, card kept) | `term/TerminalProvider.tsx` (park) | v1.x | Same idea to bound memory; parked tabs reconnect when shown. |
| Pane layout and open terminals restored after a reload | `term/TerminalProvider.tsx` (restore, 01b §13) | v1 | Restored at app start from local state; tmux sessions are re-attached, plain shells start fresh. **Built (Phase 3); a switch in Terminal Theme turns it off.** |
| Cross-tab sync of which sessions are open | `term/TerminalProvider.tsx` | excluded | Single window in v1; multiple windows (later) share one engine anyway. |
| Multiple app windows | — | later | One engine, several windows; tabs can be moved between them. |
| IDE launcher (code-server) | `term/TerminalModal.tsx` (disabled), legacy-ui `01b` §11.5 | excluded | Server feature (AURA agents). |

## 2. xterm.js rendering, look and fonts

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| xterm.js with WebGL renderer, DOM fallback when WebGL fails | `term/connection.ts` | v1 | Same; Chromium in Electron makes WebGL reliable. |
| Unicode 11 widths, fixed 16-colour ANSI palette, `minimumContrastRatio` 4.5, 10 000 lines scrollback, cursor blink | `term/connection.ts`, `term/themes.ts` | v1 | Same options; scrollback length becomes a setting. |
| 20 colour schemes (Default Dark, Dracula, Nord, Monokai, Gruvbox, One Dark, Tokyo Night, Catppuccin, Ayu, Night Owl, Material, Synthwave 84, Cobalt2, Horizon, Palenight, Everforest, Kanagawa, Rosé Pine, Solarized Dark, GitHub Dark) | `term/themes.ts` | v1 | Ported as is. **Built (Phase 3).** |
| 12 font stacks, each led by BPG Courier so Georgian fills one cell; web fonts bundled and awaited before measuring | `term/themes.ts` | v1 | Fonts bundled in the app (no font CDN: offline). **Built (Phase 3) as stacks. 0.1.0-beta.5 bundles BPG Courier (terminal) and Noto Sans Georgian (UI and Mtavruli), loads them before glyphs are cached and redraws the WebGL atlas when they arrive (ADR 0006). The Latin web fonts are not bundled.** |
| Terminal Theme dialog: schemes, fonts, live preview, Apply restyles every open terminal | `term/ThemeModal.tsx` | v1 | Same; stored in local settings. **Built (Phase 3), also holds the notification switches; renamed "Look and notifications" in 0.1.0-beta.5 with the app theme (Liquid glass, the default, or Classic).** |
| Font size ladder by window width + zoom −/+ (6–24 px), remembered | `term/themes.ts`, `term/TerminalModal.tsx` | v1 | Same, plus Ctrl+= / Ctrl+- / Ctrl+0. **Built (Phase 3); zoom is saved in the vault, Ctrl+= / Ctrl+- / Ctrl+0.** |
| Per-host / per-tab theme override | — | v1.x | New: a host may carry its own scheme (e.g. red for production). **Built early (Phase 3): colour scheme and font per host.** |
| Fit pipeline (fonts ready, debounce, ResizeObserver), resize sent to the PTY | `term/connection.ts` | v1 | Same; resize is an IPC intent to the engine. |
| Classic look (application chrome) | `web/styles/legacy`, `web/kit/` | v1 | The app chrome reuses the Classic look and kit controls (dialogs, toasts, icons). |
| Clickable links: only `http(s)://`, opened with noopener | `term/connection.ts` (WebLinksAddon) | v1 | Opened in the system browser via `shell.openExternal` after a scheme allow-list check in main; never inside the app. **Built (Phase 5): Ctrl+click on an `http(s)` address (a plain click selects); main re-checks the URL (no credentials, no other schemes); OSC 8 hyperlinks stay inert because their text can hide the target.** |

## 3. Sessions, persistence and reconnect

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Resumable sessions: the shell runs inside tmux (`tmux new-session -A`), so closing, a reload or a network drop does not end it; hosts without tmux get a plain shell | `gw/terminals/terminal-relay.ts`, `gw/terminals/tmux-attach.ts` | v1 | Same, optional per host ("Resumable sessions (tmux)", default off). The engine builds tmux commands only from its own validated session names. **Built (Phase 3); opt-in per host, default off, Linux hosts (ADR 0003).** |
| At most 20 sessions per host | Jarvis FEATURES "Terminals" | v1 | Same soft limit. **Built (Phase 3).** |
| Session list from tmux on the host (attached/detached, idle, program, folder) | `term/dockModel.ts`, Jarvis core terminal sessions | v1 | Engine lists `quqa-*` tmux sessions over SSH exec on connect/refresh. **Built (Phase 3): folder, program, idle time, attached elsewhere.** |
| "Session found on host" / ended card asks before starting a fresh shell | `term/TerminalProvider.tsx` (01a §7.4) | v1 | Same dialog. **Built (Phase 3): opening a host with known detached sessions offers them; a restored session that had ended shows a notice.** |
| End session on host… (kills tmux, confirm) | `term/SessionsDock.tsx` | v1 | Same. **Built (Phase 3).** |
| Rename a session (alias, max 60 chars, empty resets to host name) | `term/SessionsDock.tsx`, `term/TerminalModal.tsx` | v1 | Stored locally. **Built (Phase 3): double-click a tab or Rename… in the dock; saved per tmux session.** |
| Connection states: connecting, connected, stale (45 s watchdog + ping/pong probe), AFK (no output ≥ 1000 s), disconnected, retry exhausted, refused (keys/host key), exited | `term/connection.ts`, legacy-ui `01b` §10.2 | v1 | Same states; the probe is an SSH keepalive round trip in the engine. |
| Automatic reconnect 1/2/4/8/16/30 s × 6 with ±20 % jitter, only a verified ready resets the budget, manual retry restarts it | `term/connection.ts`, legacy-ui `01b` §10.3 | v1 | Same algorithm, also on resume from sleep and network change (`powerMonitor`, online events). |
| Probe button (RTT "OK · N ms") | `term/TerminalModal.tsx` | v1 | Same. |
| Codes that retrying will not fix (host key mismatch, auth) stop reconnecting | `term/connection.ts` | v1 | Same. |
| Keepalive 15 s × 3, Nagle off for keystrokes, `MaxStartups` reset retry | `gw/ssh/connection-pool.ts` | v1 | Ported. |
| One pooled authenticated connection per target carrying many channels (terminals, SFTP, exec), closed when idle; stays below `MaxSessions` | `gw/ssh/connection-pool.ts` | v1 | Ported into the engine. |
| Input sent before ready is buffered (≤ 64 KiB) | legacy-ui `01b` §10.5 | v1 | Same. |
| Login identity chooser (personal workspace vs shared login) | `term/IdentityChooser.tsx`, `term/identity.ts` | excluded | Multi-user workspaces (Jarvis ADR 0019). A host simply has one user + key; several hosts may point at one address. |

## 4. Scrollback and history

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Local xterm scrollback | `term/connection.ts` | v1 | Same. |
| Scroll mode "S": *auto* (wheel scrolls local scrollback or goes to full-screen apps) / *terminal history* (wheel drives tmux copy-mode) | `term/connection.ts`, `gw/terminals/tmux-history.ts` | v1 | Same three fixed tmux actions (enter, scroll N, exit) run by the engine. **Built (Phase 3).** |
| "Live" button: leave history, jump to newest output, unread hint while reading | `term/connection.ts`, `term/TerminalModal.tsx` | v1 | Same. **Built (Phase 3).** |
| Typing leaves history first so keys never act as copy-mode commands; tmux is taken out of copy-mode after reconnect | `term/connection.ts` | v1 | Same. **Built (Phase 3) for typing; leaving copy-mode after a reconnect is v1.x.** |
| Search in scrollback (Enter next, Shift+Enter previous, highlighted matches) | legacy-ui `01b` §9.3 (legacy history overlay; not in NG) | v1 | xterm search addon, Ctrl+Shift+F. **Built (Phase 3).** |
| History overlay from tmux `capture-pane` | legacy-ui `01b` §9.3 | v1.x | Optional full tmux history snapshot, searchable. |
| Export scrollback to a text file | — | v1.x | New; saved through the main process file dialog. |
| Session logging to a file | — | later | New, opt-in per host; never on by default (logs can hold secrets). |

## 5. Keyboard, clipboard and paste

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Copy on select (desktop) with "Copied" notice | `term/connection.ts` | v1 | Same (setting: copy on select on/off). Ctrl+Shift+C also copies. |
| Ctrl/Cmd+V pastes text through xterm (bracketed paste kept) | `term/connection.ts` | v1 | Same, plus Ctrl+Shift+V and right-click paste (setting). |
| Paste button in the toolbar | `term/TerminalModal.tsx` | v1 | Same. |
| Chunked paste: large input sent in 4 KiB slices with progress and **Cancel paste** | `term/connection.ts` (PASTE_CHUNK), `term/TerminalProvider.tsx` | v1 | Same; slicing happens in the engine, the renderer only shows progress and cancel. |
| Paste safety warning (multi-line or very large paste, paste containing control characters) | — (new) | v1 | New: confirm dialog before sending multi-line text outside bracketed paste and before pastes over a size limit; "don't ask again" per host. **Built (Phase 2), always on, also for control characters; "don't ask again" waits for per-host settings.** |
| OSC 52 clipboard write from programs (Claude Code inside tmux); read requests ignored; tmux `set-clipboard on` + passthrough set on attach | `term/connection.ts`, `gw/terminals/tmux-attach.ts` | v1 | Write requires a confirm per host the first time ("Allow this host to set the clipboard?") then may be remembered; reads always denied. **Built (Phase 4): "Remember my choice for this host" in the dialog, and Ask / Allow / Deny in Edit host; allowed writes show a "Copied" notice.** |
| Refused clipboard write → notice with a **Copy** button | `term/connection.ts`, `term/TerminalProvider.tsx` | v1 | Kept for the "ask" case: the notice shows the text and a Copy button. |
| Shortcuts work on Georgian and other non-Latin layouts (match by key code) | `web/kit/keys.ts` | v1 | Ported. **Built (Phase 3) for all app shortcuts.** |
| Ctrl+Shift+K switcher inside the terminal, plain Ctrl+K only outside (shell keeps kill-line) | `term/SessionSwitcher.tsx`, `term/connection.ts` | v1 | Same. **Built (Phase 3).** |
| Alt+Shift+1…9 reserved for pinned sessions | `term/connection.ts` | v1 | Implemented: Alt+Shift+N opens favorite N; Ctrl+Tab / Ctrl+Shift+Tab cycle tabs. **Built (Phase 3) for favorites 1–8.** |
| Configurable keyboard shortcuts | — | v1.x | New: a shortcuts page with defaults and rebinding. |
| Ctrl+Space dictation hotkey | `term/connection.ts`, `term/Dictation.tsx` | excluded | Voice. |

## 6. Files: uploads, image paste, SFTP

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Image paste → uploaded to the host and its **path** pasted into the terminal (so Claude Code can read it) | `term/connection.ts` (onImagePaste), `term/TerminalProvider.tsx`, `web/files/upload.ts` | v1 | Engine writes the image over SFTP into the terminal's folder (or a per-host upload folder, default `/tmp`) and types the shell-quoted path. **Built (Phase 4): Ctrl+V / Ctrl+Shift+V / right-click with an image (or files copied in Explorer) on the clipboard; main reads the clipboard itself, uploads `clipboard_<time>.png` to the host's upload folder (default `~/uploads`, else the first file root) and types the quoted path (Windows hosts get `C:\…`).** |
| Drag and drop files onto a terminal → upload to the program's folder (if inside the file roots) else the first root, drop overlay | `term/TerminalModal.tsx`, `term/TerminalProvider.tsx`, legacy-ui `01b` §8.3 | v1 | Same; the renderer passes file paths it received from the drop, main validates them and the engine reads them from disk. **Built (Phase 4): the preload turns dropped `File`s into grants; tmux folder when known, else the upload folder; a taken name gets `-1`.** |
| File transfer menu (Upload / Download) in the terminal header | `term/TerminalModal.tsx` | v1 | Opens the file browser for that host. **Built (Phase 4) as the Files button (over the terminal's own connection).** |
| Upload notices with progress on the notice island | `term/notices.ts`, `term/NoticeIsland.tsx` | v1 | Same. **Built (Phase 4): uploads and downloads with progress, Cancel, Resume.** |
| "Where it runs": folder · user · program of the foreground program (from tmux and `/proc`, follows sudo), Copy path, Open in Files | `term/WhereButton.tsx`, `term/where.ts` | v1.x | Engine runs one fixed read-only command over SSH exec (tmux sessions only). |
| SFTP file browser: Back / Up / Home / Refresh, folders first, typed icons, search | `mach/Files.tsx` | v1 | Same UI, opened from a terminal (starts in its program's folder) or from a host. **Built (Phase 4): plus size, date and permissions, a typed path, and a shell-less "hold" login when opened from a host card.** |
| Create folder, rename, delete (recursive), drag a row onto a folder to move | `mach/Files.tsx`, `gw/files/remote-files.ts` | v1 | Same, with confirms for delete. Atomic posix-rename where the server supports it. **Built (Phase 4).** |
| Download (streamed) | `mach/Files.tsx`, `gw/files/remote-files.ts` | v1 | Save dialog in main, engine streams SFTP → disk. **Built (Phase 4): a folder dialog; a `.quqa-part` file renamed to a free name when complete, resumed after a drop.** |
| Upload: chunked and resumable (resume from partial file size), overwrite only after confirm | `web/files/upload.ts`, `gw/files/remote-files.ts` | v1 | Engine streams disk → SFTP; resume uses the same partial-file scheme. **Built (Phase 4): button or drop on the list; resumes by itself when the connection comes back; Cancel removes the partial file.** |
| File roots: every path normalised and, after resolving symlinks, kept under the host's allowed roots | `gw/files/remote-files.ts`, `gw/files/remote-paths.ts` | v1 | Kept as an optional per-host restriction (default `/`: the user owns their hosts). **Built (Phase 4), tested against `..` and symlink escapes.** |
| "Open files as" (identity) | `mach/Files.tsx` | excluded | Multi-user. |
| Transfer manager (queue, pause/resume, recents, pins) | GAP in Jarvis (legacy only) | v1.x | Queue with pause/cancel. **Partly (Phase 4): three transfers at a time per connection, the rest queued; Cancel and Resume on the island.** |
| Edit a remote file in a local editor (download, watch, upload on save) | — | later | New. |
| Local ↔ remote two-pane browser | — | later | New. |

## 7. Hosts

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Host: display name, address, port, SSH user, type (Linux/Windows), key, description, optional file roots | `mach/HostForms.tsx`, Jarvis FEATURES "Hosts and keys" | v1 | Same fields plus optional password auth, jump host, tmux toggle, colour/tags. **Built (Phase 3); file roots, upload folder, agent, agent forwarding, OSC 52 choice and saved forwards since Phase 4.** |
| Add Host form and Edit Host dialog; changing address or port re-checks host-key trust | `mach/HostForms.tsx` | v1 | Same. **Built (Phase 3); the next connection to a changed address checks its key (prompt on first use, block on change); an explicit "Re-check" on save is v1.x.** |
| Delete host | `mach/SshManager.tsx` | v1 | Same (asks; offers to forget its pinned keys). **Built (Phase 3), optionally forgetting the pinned key.** |
| SSH Manager: dashboard (total hosts, online/offline, avg latency), host cards with Open Terminal, Files, Edit, Ping, Test reachability, More | `mach/SshManager.tsx` | v1 | Same; becomes the start screen. **Built (Phase 3) with a compact status line instead of stat cards, plus Sessions, Duplicate and favorite; Files and Install key since Phase 4.** |
| Live latency per host: one SSH keepalive round trip on the pooled connection, cached 20 s; Ping all hosts | `gw/ssh/connection-pool.ts`, `mach/SshManager.tsx` | v1 | Same; only for hosts with a live connection, plus TCP connect time for others (no ICMP). **Built (Phase 3) as the TCP connect time to the SSH port, no login (ADR 0003).** |
| Host groups (filter, collapsible group headers, online/total count, Ungrouped) | legacy-ui `03a` §5.4 (GAP in NG) | v1 | Ported from the legacy design. **Built (Phase 3).** |
| Tags and search/filter over hosts | — | v1 | New: free tags, quick filter. **Built (Phase 3): fuzzy search plus `tag:` and `group:` filters.** |
| Quick Connect picker (double-click the SSH button; all hosts, type to filter) | `mach/QuickConnect.tsx` | v1 | Ctrl+Shift+O; also accepts `user@host:port` for an ad-hoc connection (host-key prompt applies). **Built (Phase 3): Ctrl+Shift+O; ad-hoc `user@host:port` can be saved as a host.** |
| Import hosts from `~/.ssh/config` (Host, HostName, User, Port, IdentityFile, ProxyJump) | — | v1 | New: preview, choose which to import; keys referenced by IdentityFile are offered for import into the vault. **Built (Phase 3); Include and Match are reported, not followed (ADR 0003).** |
| Export/import host list (JSON, no secrets) | — | v1.x | New. |
| Host type Windows (OpenSSH Server on Windows) with setup guide | `mach/HostForms.tsx` | v1 | Works with the same engine; guide text ported. **Built partly (Phase 3): the type is stored and Windows hosts get plain shells; the setup guide is not ported yet.** |
| Quick commands: 4 coloured slots per host, each sends its command + Enter | `term/QuickCommands.tsx`, legacy-ui `03a` §8 | v1.x | Same, stored per host. |
| Host Config document | legacy-ui `03a` §5.11 | v1.x | Becomes the host's free-text notes field. **Built early (Phase 3) as the notes field.** |
| Manage Access / share a host with users until a date | `mach/ManageAccess.tsx` | excluded | Multi-user. |
| Available SSH Hosts (non-admin view), roles, permissions | `mach/SshManager.tsx`, `mach/roles.tsx` | excluded | Multi-user. |
| Run a command API (`POST …/run`, jarvisctl) | Jarvis FEATURES "Hosts and keys" | excluded | Server API. A local CLI may come later. |
| Guided Host Wizard (Shield enrolment, provisioning, Odoo) | `mach/HostWizard.tsx` | excluded | Server-only provisioning. |
| Remote desktops (RDP/VNC through the host's SSH tunnel) | `mach/Desktops.tsx`, `mach/DesktopViewer.tsx` | later | Possible on top of local port forwarding (open `mstsc` against a forwarded port); not a built-in viewer. |
| Reach a host through an AURA agent's reverse tunnel | `gw/ssh/target.ts`, `gw/agents/agent-registry.ts` | excluded | Server relay. Jump hosts (below) cover the offline equivalent. |

## 8. Keys and credentials

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Generate Ed25519 key (retry until ssh2 can parse it back), optional comment | `gw/credentials/credential-store.ts` (`generateEd25519`) | v1 | Ported into the engine. Also RSA-4096 and ECDSA for old servers (v1.x). **Built (Phase 2).** |
| Import an existing private key (OpenSSH/PEM/PPK), with passphrase; key text dropped right after | `gw/credentials/credential-store.ts`, `mach/SshKeysTab.tsx` | v1 | Renderer sends a file path or pasted text once to the engine, never stores it; the engine parses and seals it. **Built (Phase 2); files are read by the engine from a main-process dialog.** |
| Keys list: label, type, fingerprint, created; Copy public key; Delete | `mach/SshKeysTab.tsx` | v1 | Same; delete warns when hosts use the key. **Built (Phase 2), plus Export public key; "used by N hosts" since Phase 3.** |
| Private keys sealed at rest (AES-256-GCM bound to a context string) and never returned by any API | `packages/crypto/src/secret-box.ts`, `gw/credentials/credential-store.ts` | v1 | Vault: per-item XChaCha20-Poly1305 (or AES-256-GCM) with the item id as associated data; data key wrapped by Electron `safeStorage` (DPAPI) and optionally a master password (Argon2id). See ADR 0001. **Built (Phase 2): XChaCha20-Poly1305 + Argon2id (@noble), ADR 0002.** |
| Passphrase sealed with the key | `gw/credentials/credential-store.ts` | v1 | Option: store the passphrase in the vault, or ask each time (kept in engine memory for the session only). **Built (Phase 2).** |
| Re-authentication before importing a key | `mach/SshKeysTab.tsx` | v1.x | Becomes "unlock the vault" when a master password is set. |
| Install a public key on a host (`ssh-copy-id` equivalent) after a password login | — | v1 | New: engine appends to `~/.ssh/authorized_keys` over SFTP (no shell string building). **Built (Phase 4): key button on a Linux host card, confirmed, idempotent, `~/.ssh` 0700 and a new file 0600; optionally switches the host to that key.** |
| Password authentication and keyboard-interactive (2FA prompts) | — (Jarvis is key-only) | v1 | New: prompts are shown by the renderer, answers go straight to the engine; saving the password in the vault is opt-in. **Built (Phase 2): prompts are engine requests, answered once from a dialog.** |
| SSH agent: Windows OpenSSH agent pipe, Pageant | — | v1 | Engine uses ssh2's agent support; agent forwarding off by default, per host opt-in with a warning. **Built (Phase 4): login "SSH agent" (OpenSSH pipe / SSH_AUTH_SOCK, or Pageant), "Show its keys" by fingerprint, forwarding per host with a warning. Confirm-each-use is not built (v1.x).** |
| Hardware keys (FIDO2 `sk-` keys) | — | later | Through the system agent. |

## 9. Host-key trust

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Host keys pinned and verified on every new connection | `gw/ssh/connection-pool.ts`, `gw/ssh/host-keys.ts` | v1 | Same, in the engine. **Built (Phase 2): pins persist in the vault.** |
| Scan a host's key without authenticating (strongest type first, stop at the first) | `gw/ssh/host-key-scan.ts` | v1 | Same. |
| Trust dialog: compare SHA256 fingerprints, tick the ones to pin, "Trust host" | `mach/HostKeyTrust.tsx`, `term/HostKeyDialog.tsx` | v1 | First connection shows the prompt (TOFU with an explicit decision: Jarvis has no TOFU because a server shares it; on one's own desktop the prompt is the standard model). The engine pins what it scanned, never key material from the renderer. **Built (Phase 2) as the first-connection prompt.** |
| Changed key blocks the connection; "SSH host key changed" dialog with the previous fingerprint and a warning; "Trust replacement key" | `mach/HostKeyTrust.tsx`, legacy-ui `01b` §10.4 | v1 | Same; replacement needs a deliberate second confirm. **Built (Phase 2).** |
| Re-check host key (Edit Host) | `mach/HostForms.tsx` | v1 | Same. |
| Read `~/.ssh/known_hosts` (incl. hashed entries) as an extra trust source; optional write-back | — | v1 | New: import pins from known_hosts; write-back is off by default. **Import built (Phase 2), also offered on first run (Phase 5); write-back is v1.x.** |
| Strict mode (never prompt, refuse unknown keys) | — | v1.x | Setting. |

## 10. Sessions dock, favorites and switcher

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Sessions dock: launcher button, popover with every session (open or saved on the host), "1 live · 9 detached" | `term/SessionsDock.tsx`, `term/dockModel.ts` | v1 | Same, as a side panel. **Built (Phase 3) as a side panel (Ctrl+Shift+S).** |
| Group by host / one list toggle; inside a group, un-aliased rows show folder/program | `term/SessionsDock.tsx`, `term/dockModel.ts` | v1 | Same. **Built (Phase 3).** |
| Order: pinned → attention → running → down → ended; then host, name | `term/dockModel.ts` | v1 | Same. **Built (Phase 3).** |
| Fuzzy filter | `term/dockModel.ts` | v1 | Same. **Built (Phase 3).** |
| Row states, idle time, attention bell, unread dot | `term/dockModel.ts`, `term/SessionsDock.tsx` | v1 | Same. **Built (Phase 3).** |
| Card menu: Open, Pin to top / Unpin, Rename…, Close (keeps tmux), Forget card, End session on host… | `term/SessionsDock.tsx` | v1 | Same. **Built (Phase 3).** |
| Hover preview: last ≤ 18 lines of the screen | `term/SessionsDock.tsx`, `term/connection.ts` (`previewLines`) | v1 | Same. **Built (Phase 3).** |
| Close all (tmux keeps running) | `term/SessionsDock.tsx` | v1 | Same. **Built (Phase 3).** |
| Favorites: pinned sessions, up to 8 shown as one-click buttons (or hover until the outline fills); clicking the one on screen hides it | `term/SessionsDock.tsx` | v1 | Favorites bar; Alt+Shift+1…9. **Built (Phase 3): a favorites bar under the tabs, sessions and whole hosts; plain shells pinned only until restart.** |
| Session switcher: Ctrl/Cmd+Shift+K anywhere, fuzzy search, keyboard navigation | `term/SessionSwitcher.tsx` | v1 | Same. **Built (Phase 3).** |

## 11. Notifications and attention

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Terminal bell (BEL) rings only when global sounds are on, the terminal's own bell is on (default off) and nobody is watching it | `term/bell.ts`, `term/TerminalProvider.tsx` | v1 | Same; "watching" = tab visible and window focused. **Built (Phase 3) with a per-terminal mute in the header (on by default) and the global notification and chime switches.** |
| Agent finished / asks a question (Claude Code working markers, then quiet) → attention mark + completion alert, at most once per 30 s | `term/connection.ts`, `term/TerminalProvider.tsx` | v1 | Same heuristics, client-side. **Built (Phase 3).** |
| Desktop notification "<name> needs you" in the background | `term/TerminalProvider.tsx` | v1 | Native notification via Electron; clicking focuses that tab. Taskbar flash/badge on Windows. **Built (Phase 3).** |
| Sound packs Knight (12) and Default (5), single sound or shuffle, preview, volume | `term/bell.ts`, `term/soundPacks.ts` | v1 | Bundled with the app (sound files owned by AURA, ported). **v1 ships a synthesized chime instead (ADR 0003); the packs are v1.x.** |
| "My sounds": add MP3/WAV/OGG/M4A (≤ 2 MB each, 30 total) | `term/bell.ts`, `term/soundStore.ts` | v1.x | Stored in the app data folder. |
| Notice island under the toolbar (uploads, clipboard, copy, paste progress) | `term/notices.ts`, `term/NoticeIsland.tsx` | v1 | Same. **Built (Phase 4): transfers, pasted paths, copies, errors.** |
| Settings follow the account (ADR 0032) | `term/bell.ts`, `term/themes.ts` | excluded | No accounts: one local settings file. |

## 12. Network features

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Local port forwarding (`-L`) | — (Jarvis uses direct-tcpip only internally, `gw/ssh/connection-pool.ts`) | v1 | New: per host or ad hoc, bound to 127.0.0.1 by default; list of active tunnels with stop. **Built (Phase 4): from a terminal's tunnel button or saved with the host ("start automatically" opens it with the first connection); Tunnels screen with state, connections, bytes and Stop; paused while the connection is down, reopened after.** |
| Remote forwarding (`-R`), dynamic SOCKS (`-D`) | — | later | New, opt-in with warnings. **Built early (Phase 4): same dialog and list; SOCKS5 CONNECT without authentication.** |
| Jump hosts (ProxyJump, chained) | — | v1 | New: a host may name another host as its jump; host keys are pinned for every hop. **Built (Phase 4): chains through saved hosts, each with its own login and pin; `ProxyJump` from `~/.ssh/config` resolves to saved hosts; loops refused.** |
| HTTP/SOCKS proxy for the SSH connection | — | later | New. |
| X11 forwarding | — | excluded | Needs a local X server; out of scope. |

## 13. Optional AI recap (not core)

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Terminal summaries: when an agent finishes or a prompt waits, a short recap of what happened (Georgian in Jarvis) shown as a notice | `term/summaries.ts`, `term/summaryModel.ts`, `term/SummaryToggle.tsx`, Jarvis `docs/adr/0029-terminal-summaries.md` | later | Optional, off by default, needs the user's **own** API key; the only network call besides SSH, made only when the user enables it, and it sends terminal text, so the switch is per terminal with a clear warning. Never in core builds' default path. |
| Agent's own recap setting | `term/AgentRecapSettings.tsx`, `term/agentRecap.ts` | later | Same conditions. |
| Spoken summaries (Georgian voice) | `term/voice.ts`, `term/VoiceControls.tsx` | excluded | Voice. |

## 14. Excluded outright

| Feature | Jarvis | Why |
| --- | --- | --- |
| Dictation, live dictation, speech gate, mic level, voice controls, activity pill for recording | `term/Dictation.tsx`, `term/liveDictation.ts`, `term/speechGate.ts`, `term/micLevel.ts`, `term/ActivityPill.tsx` | Voice/speech. |
| Terminal sharing (share modal, shared with me, control requests, viewers, privacy curtain, device ids) | `term/ShareSessionModal.tsx`, `term/SharedWithMe.tsx`, `term/ShareControls.tsx`, `term/sharing.ts`, `term/shareModel.ts`, `term/deviceId.ts` | Sharing. |
| Workspaces (personal Linux accounts on hosts), identities | `mach/Workspaces.tsx`, `term/identity.ts` | Multi-user. |
| Users, roles, access, audit log, sign-in, API tokens | `mach/Users.tsx`, `mach/ManageAccess.tsx`, `mach/Activity.tsx` | Server/multi-user. |
| Claude energy tube / usage probe | Jarvis ADR 0033, 0034 | Server feature. |
| Discord panel, Agent Teams | legacy-ui `01b` §11 | Server/collaboration. |

## 15. Desktop app and release (new, no Jarvis counterpart)

| Feature | Jarvis | Status | quqa-express mapping |
| --- | --- | --- | --- |
| Windows installer: per user, no administrator rights, Start menu and desktop shortcuts, uninstall keeps the vault unless the user says yes | — | v1 | **Built (Phase 5):** NSIS via electron-builder, `quqa-express-<version>-setup.exe`. |
| Portable exe, profile next to the exe | — | v1 | **Built (Phase 5):** `quqa-express-<version>-portable.exe`, data in `quqa-express-data\`. |
| Unsigned builds, SHA256SUMS.txt, GitHub (pre-)releases from tags | — | v1 | **Built (Phase 5):** `.github/workflows/release.yml`; SmartScreen note and checksum steps in README and release notes (ADR 0005). |
| App icon, About (version, licence, source, origin) | — | v1 | **Built (Phase 5):** F1 → About quqa-express. |
| First run: create the vault, then offer to import hosts (ssh config, with key files), known_hosts and keys | — | v1 | **Built (Phase 5). Since 0.1.0-beta.5 it is not forced: the app goes straight to the hosts screen, whose empty state and toolbar offer "Import from ~/.ssh".** |
| Lost master password: "Forgot password? Start over" moves the vault to `vault-backups/<time>/` after typing DELETE | — | v1 | **Built (0.1.0-beta.5, ADR 0006).** |
| App theme: Liquid glass (default; Windows 11 acrylic) or Classic | — | v1 | **Built (0.1.0-beta.5, ADR 0006).** |
| Window size, position and maximized state remembered; one instance (a second start focuses the window) | — | v1 | **Built (Phase 5)**; single instance since Phase 1. |
| Update check: badge, release notes, Update now (installer verified against SHA256SUMS.txt) / Later / Skip | — | v1 | **Built (0.1.0-beta.5, ADR 0006):** on by default, opt-out in About. **0.1.0-beta.7:** the portable exe updates itself (verified download, swap on restart, same file name, `updates\previous.exe` kept; download page if its folder is read-only); downloads can be cancelled. |
| Build provenance attestations, SBOM, code signing | — | later | Left out to keep releases simple. |

## v1 at a glance

Electron app with hardened IPC and an isolated SSH engine; tabs and two-pane
split; xterm.js WebGL with 20 schemes, 12 fonts, zoom; resumable tmux
sessions with the sessions dock, favorites, switcher, rename and end on host;
reconnect with backoff, watchdog and probe; local scrollback, tmux history
mode and search; copy on select, chunked paste with cancel, paste warnings,
OSC 52 write with confirm; image paste and drag-and-drop upload; SFTP file
browser with resumable transfers; hosts with groups, tags, latency, Quick
Connect and `~/.ssh/config` import; encrypted vault; Ed25519 generation,
key import with passphrase, password and keyboard-interactive login, public
key install, SSH agent (OpenSSH pipe, Pageant); local port forwarding and
jump hosts; pinned host keys with TOFU prompt, changed-key block and
known_hosts import; bell, agent-finished attention, desktop notifications,
a chime; import from `~/.ssh`; bundled Georgian fonts; Liquid glass and
Classic themes; an update check with verified installs; "Start over" for a
lost master password; Windows per-user installer and portable exe
(unsigned), with SHA256SUMS and GitHub pre-releases.
