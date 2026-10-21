# ADR 0007: Local terminals

- Status: accepted
- Date: 2026-10-22
- Deciders: AURA (project owner)
- Refines: ADR 0001 §2 (process model), §4 (supply chain), ADR 0005 (packaging)

## Context

The owner wants quqa-express to "emulate local PowerShell to run agents
through it (Claude Code, Codex…) — simply". Agents run on the user's own
computer as well as on servers. The terminal UX already built for SSH tabs
(themes and Georgian fonts, Ctrl+V on any layout, image paste, splits,
favorites, dock, switcher, scrollback search, bell and "agent finished"
notifications) should work the same for a local shell.

A local shell is a different kind of power from an SSH session: it is a
program started on this computer with the user's rights. The design must
make sure that terminal output, a confused renderer or a crafted IPC
message can never start a program, and that the SSH engine and vault are
not affected.

## Decision

### A third process for pseudo-terminals

- **node-pty** (Microsoft, MIT; ConPTY on Windows, `forkpty` elsewhere) runs
  in its own Electron `utilityProcess` (`src/pty`, `out/main/pty.js`),
  started the first time a local terminal opens. It is not the SSH engine
  (keys and vault stay alone there), not main, and never the renderer.
- Version `1.2.0-beta.15`, pinned: it ships **prebuilt N-API binaries** for
  Windows x64 (`conpty.node`, plus Windows Terminal's `conpty.dll` and
  `OpenConsole.exe`), Linux x64 and macOS. N-API binaries work in every
  Electron, so nothing is compiled: `allowBuilds: node-pty: false` keeps its
  node-gyp fallback from running, `npmRebuild` stays off, and the Wine
  cross-build packs the same Windows binaries as the Windows CI build. The
  1.1.0 release has no Linux prebuilds and would need a compiler.
- Packaging: `asarUnpack: node_modules/node-pty/**`, because node-pty loads
  native modules, starts a worker thread and runs `OpenConsole.exe` next to
  itself. `src/pty/node-pty.ts` loads it by its unpacked path. Sources,
  debug symbols, arm64 builds and the other platforms' binaries are left out
  of each package (about 2.5 MB stays on Windows).
- Windows: node-pty's bundled ConPTY (`useConptyDll`) first, the built-in
  one if that fails. With the built-in ConPTY node-pty forks a Node child to
  list a closing console's processes; the packaged app cannot fork Node
  (`RunAsNode` fuse off), so that step is replaced by "end the shell process"
  (ConPTY then ends the programs attached to its console).

### Intents, not commands

- The renderer sends **`local:open { shellId, folder, cols, rows }`**, and
  main checks it against `LocalOpenRequest`. `shellId` is one of `pwsh`,
  `powershell`, `cmd`, `wsl` and `login`. `folder` is `null` (the home folder)
  or a token from `local.chooseFolder`, which shows main's own folder dialog.
  There is no field for a program, an argument, an environment or a path.
- Main **detects** the shells (`src/main/local-shells.ts`) and keeps the
  program for each id:
  - PowerShell 7: `pwsh.exe` on PATH (absolute PATH entries only), then in
    Program Files.
  - Windows PowerShell 5.1: in System32.
  - Command Prompt: `ComSpec`, only if it names `cmd.exe`.
  - WSL: only when `wsl.exe --list --quiet` lists a distribution.
  - On macOS and Linux, the login shell (`$SHELL`), for development and tests.
  The arguments are fixed per shell. PowerShell gets `-NoLogo -NoExit -Command
  <console input/output encodings and $OutputEncoding to UTF-8 without BOM>`,
  and cmd gets `/K chcp 65001`. With these, Georgian goes both ways, also
  through native programs.
- Opening needs a **user gesture**: a key press or click that main itself
  saw within the last 3 s (the same rule as clipboard reads). A renderer
  that went wrong cannot open shells by itself. Opening is also never driven
  by terminal output. The layout restore at start does not reopen local
  tabs.
- The PTY process checks every command against `PtyCommand` again. Its
  answers are the usual session events (`ready`, `data`, `error`, `closed`).
  It never puts node-pty's error text, which can hold a command line, into
  an event or a log.
- Input, resize, flow-control acks and close use the SSH session channels.
  Main sends them to the PTY process for sessions it opened as local, and
  only for the window that opened them. tmux and reconnect messages for a
  local session are dropped. The SFTP, forward and key-install calls answer
  "not connected", because the SSH engine does not know the session.
- Environment: the app's own environment without `ELECTRON_*`, `QUQA_*` and
  similar internal variables, plus `TERM=xterm-256color`,
  `COLORTERM=truecolor` and `TERM_PROGRAM=quqa-express`.
- Flow control works as for SSH channels: past 1 MiB that the renderer has
  not acknowledged, the PTY is paused until it falls under 256 KiB.

### Same terminal, fewer features

- Local tabs use the same `TerminalSession`, with a `local` target. Themes
  and fonts, paste and its warnings, splits, favorites (for this run), the
  dock and switcher, search, bell and agent notifications all work as in SSH
  tabs. The tab title comes from the program (OSC 0/2: PowerShell's path
  shortened to `pwsh`, an agent's task title).
- There is no tmux, no reconnect, no SFTP and no forwards. A local tab is not
  reopened after a restart (the badge's tooltip says so). When the shell
  exits, the tab shows the exit code and **Start again**.
- Image paste: main reads the clipboard after a gesture, saves the image as
  `<profile>\uploads\clipboard_<time>.png` (files older than 7 days are
  removed) and types the quoted path. Copied files and files dropped on the
  tab (through upload grants) have their own paths typed.
- Ctrl+Shift+` opens the default shell. Ctrl+Shift+T opens one from the
  Hosts screen and duplicates the active tab elsewhere. The tab strip has a
  button with a menu: every shell, "In a folder…", and the default shell,
  which is saved in `settings.json` as `localShell`.

## Consequences

- **Trust: the same as Windows Terminal.** A local shell runs as the user,
  with the user's rights, files and network. quqa-express adds no sandbox.
  Whatever the user (or an agent the user starts) runs in it can do what the
  user can do. That includes reading the profile folder, where the vault
  file is encrypted at rest. The app's own guarantees still hold: the
  renderer cannot start a program on its own, terminal output cannot start
  one, and keys never leave the SSH engine.
- One more runtime dependency with native code (node-pty, maintained by
  Microsoft for VS Code). It is pinned to a beta because that beta is the
  release with every prebuild we need. Moving to a stable 1.2 is a version
  bump.
- Windows CI runs the real shells in `test/e2e/local.e2e.test.ts`: pwsh,
  Windows PowerShell and cmd through ConPTY, Georgian output checked as
  UTF-8 bytes, console encodings `utf-8/utf-8`, exit codes. The packaged
  smoke test opens a local tab, so the unpacked native module is exercised in
  the shipped layout. Linux runs the same tests with the login shell.
- macOS and Linux builds would get local terminals for free (their prebuilds
  are in the package) when those builds come.
