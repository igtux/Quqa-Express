# ADR 0003: Saved hosts, resumable sessions and the terminal workspace

- Status: accepted
- Date: 2026-10-21
- Deciders: AURA (project owner)
- Refines: ADR 0001 §2 (intents), §8 (network), ADR 0002 (vault items)

## Context

Phase 3 adds the hosts manager, tabs and split panes, the sessions dock,
favorites, the switcher, resumable tmux sessions, the `~/.ssh/config` import
and notifications. Several choices touch the security model: where hosts and
UI state live, how the renderer names a host and a tmux session, which remote
commands run, what network traffic the hosts screen causes, and how
notifications leave the sandboxed renderer.

## Decision

### Hosts and UI state live in the vault

- A saved host is a vault item `host/<id>` (`h_<16 hex>`), sealed like every
  other item. It holds no secret: it names a vault key by id or uses password
  login (a saved password stays its own `password/<hash>` item).
- The UI state (look, zoom, notification switches, favorites, aliases,
  forgotten sessions, the tab layout) is one item, `settings/ui`, read with
  `ui.get` and written with `ui.save`, both schema-checked (`UiState`). The
  renderer keeps nothing in `localStorage`; the old zoom key is no longer
  used.
- The vault format stays version 1: `host` is a new item kind, and item kinds
  were never part of the file schema's closed set beyond the id pattern.

### The renderer connects to a host by id

`connect` takes either the Phase 1/2 ad-hoc request (Quick Connect) or
`{ hostId, action, cols, rows }`. The engine reads address, port, user and
login from the vault on every attempt, so edits apply on reconnect and the
renderer never assembles a target for a saved host. `action` is one of:

- `shell` with `tmux: quqa-<32 hex> | null`;
- `list` and `end` (one-shot logins: list the host's sessions, or end one
  and list, then close). They use the same host-key and credential prompts
  as a terminal, so a host without an open terminal can still be listed.

A live terminal also takes `tmux` messages on its own connection: `list`,
`end <name>`, and `history enter | exit | scroll ±N` (≤ 500 lines).

### tmux: opt-in, fixed commands, validated names

- **Opt-in per host** ("Resumable sessions (tmux)", default off; the
  `~/.ssh/config` import has its own checkbox) and Linux hosts only. Without
  tmux on the host the terminal is a plain shell; the `ready` event says
  which one it got.
- Names are `quqa-<32 hex>`, generated in the renderer and checked against
  that pattern by main and again by the engine. Every command is built in
  `src/engine/tmux.ts` from constant text plus single-quoted words
  (`src/engine/shell.ts`, ported from Jarvis's `@jarvis/shell`): `tmux
  new-session -A -s <name> ; set-option -s set-clipboard on ; set-option -g
  allow-passthrough on` in a PTY, `tmux kill-session -t =<name>`, a
  `list-sessions` format, and Jarvis's three copy-mode scripts. Nothing the
  renderer sends becomes shell text.
- At most 20 quqa sessions per host: a new name past that is refused
  (`too_many_sessions`); re-attaching is always allowed.
- Closing a tab, a dropped connection or quitting the app only detaches;
  ending a session needs an explicit, confirmed "End session on host".

### Latency is a TCP connect, and the hosts screen measures it

`hosts.ping` opens a TCP connection to each saved host's SSH port, times
the handshake and closes it; nothing is sent and nobody logs in. The hosts
screen runs it for hosts whose result is older than 20 s, and "Ping all"
forces it. This is traffic the user did not ask for byte by byte, but only
to the address and port they saved for SSH, which ADR 0001 §8 already
allows; no other host is ever contacted.

### `~/.ssh/config` import without renderer-chosen paths

Main locates `~/.ssh/config` (or shows an open dialog) and hands the path to
the engine, which parses it and keeps the result behind a random token for
30 minutes. The renderer picks entries by alias with that token; the engine
reads only IdentityFile paths that came from the parsed file, and only when
the user ticked "Import the keys". A key already in the vault (same
fingerprint) is reused; a key with a passphrase is skipped and reported.
`ProxyJump` is stored on the host for Phase 4; `Include` and `Match` are
reported, not followed.

### Notifications go through main

The renderer may ask main to show a desktop notification
(`window:notify`, title ≤ 120 and body ≤ 200 printable characters, a
`t<n>` tag). Main shows it only while the window is not focused, keeps at
most five, flashes the taskbar, and on click focuses the window and sends
the tag back (`window:notification-click`). The renderer's permission
handler still denies the web Notification API. Attention follows Jarvis:
BEL from a terminal not on screen, or the Claude Code working markers
stopping after ≥ 3 s of work, or a choice prompt; at most one chime and
notification per 30 s, per-terminal mute in the header. The chime is
synthesized with Web Audio; Jarvis's sound packs are not bundled.

### Fonts are stacks, not bundled files

The 20 schemes are Jarvis's. The 12 font choices are Jarvis's stacks, each
led by BPG Courier, but the web fonts are not bundled yet (no font CDN is
allowed): a stack falls back to the next installed font.

## Consequences

- Main's IPC surface grows by four channels (`ssh:tmux`, `window:notify`,
  `window:notification-click`, `window:full-screen`) and eight calls; all
  have schemas and hostile-input tests.
- A one-shot list or end login costs a full SSH handshake (and a prompt when
  no password is saved); live terminals are used instead whenever one is
  open to the host.
- Restoring the layout at start re-attaches tmux sessions and opens fresh
  shells for plain ones; that may prompt for passwords right after unlock.
  It can be switched off.
- Bundling fonts and sound packs, OSC 52 "remember for this host", the
  notice island and a connection pool are left for later phases.
