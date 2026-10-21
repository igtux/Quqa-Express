# ADR 0004: Files, transfers, port forwards, jump hosts and the SSH agent

- Status: accepted
- Date: 2026-10-21
- Deciders: AURA (project owner)
- Refines: ADR 0001 §2 (intents), §6 (agent, forwards), §8 (network); ADR 0003

## Context

Phase 4 adds the SFTP file browser, uploads and downloads, image paste and
drag and drop onto a terminal, port forwarding, jump hosts and the user's SSH
agent. Each one moves data between the user's disk, the network and a
server, so each one needs a rule for who may name a local path, which
sockets the app opens, and what a hostile renderer could make the engine do.

## Decision

### Everything runs over a session's own connection

File operations, transfers and forwards take a `sessionId` and use that
session's ssh2 connection (one SFTP channel per connection, opened on first
use). A terminal's Files and tunnel buttons use the terminal's connection.
Without a terminal, the renderer opens a **`hold`** session: a saved host's
normal login (same host-key and credential prompts) with no shell. Main
forwards a session call only from the window that opened the session.
Long calls (SFTP, forwards, agents) run outside the engine's serial call
queue so they never hold up vault calls.

### The renderer never names a local path

- Uploads go by **grant**: main hands out a random token per file the user
  picked in main's open dialog, or dropped on the window. Dropped files reach
  main only through the preload's `grantFiles(files)`, which reads each path
  with `webUtils.getPathForFile` from a real `File` (the page cannot make one
  with a path). Main checks every path (absolute, an existing regular file)
  and keeps it for 30 minutes; `files.upload` takes tokens only.
- Downloads go to a folder chosen in main's dialog. The engine writes
  `.<name>.<random>.quqa-part` there and renames it to a free name
  (`name (1).ext`), so a local file is never overwritten; the remote name is
  made safe for Windows first (no separators, reserved names or characters).
- Image paste: main reads the clipboard itself (an image, or on Windows the
  files Explorer copied), writes an image to a private temporary file and
  deletes it after the upload. The renderer only says "paste for session S".

### Remote paths and file roots

Ported from Jarvis NG: every remote path is absolute and normalised, then
resolved with `realpath` and checked against the host's **file roots**
(empty: anywhere). A rename or delete acts on a symlink, never its target; a
root itself cannot be deleted; recursive deletes stop after 10 000 entries.
New names are single printable path components. Uploads land in the host's
upload folder: its own setting, else the first file root, else `~/uploads`
(created with mode 0700, inside the roots).

### Transfers resume

Uploads stream into `.<name>.quqa-<hash>.part` next to the target (the hash
covers the local path, size and modification time, so the same file resumes
and a different one starts over) and are moved into place only when
complete, replacing an existing file only with `overwrite` (after a
confirm). A dropped connection marks running transfers `interrupted`; they
continue by themselves from the partial file's size when the session is back
(or on Resume). Cancel removes the partial file. Three transfers run at a
time per connection; files are streamed, never held in memory.

### Port forwards

Local (-L), remote (-R) and dynamic SOCKS5 (-D, CONNECT without
authentication, our own small parser). Listeners bind to loopback by default;
any other address needs `allowPublic`, which the UI sets only after a warned
checkbox, and the engine refuses it otherwise. A forward belongs to its
session: paused when the connection drops, reopened after, closed with the
session. Hosts may save forwards; "start automatically" opens one with the
first connection to the host. These sockets are the "forwards the user asked
for" of ADR 0001 §8.

### Jump hosts

A host names its jump host by id, or (without one) keeps the `ProxyJump` line
from `~/.ssh/config`, whose entries must match saved hosts (by name, then
address, port and user). Every hop is a saved host: its own login and its own
pinned host key, prompted for like any connection, then reached with
`forwardOut` from the hop before. Chains are at most 8 hops; loops are
refused when saving and when connecting.

### The SSH agent

`auth: { kind: 'agent', agent: 'system' | 'pageant' }`. `system` is the
Windows OpenSSH pipe (`\\.\pipe\openssh-ssh-agent`) or `SSH_AUTH_SOCK`;
`pageant` is Windows only. The renderer chooses a kind, never a socket path.
ssh2 asks the agent to sign; keys never pass through the app, which lists
them by fingerprint only. **Agent forwarding** is a per-host switch, off by
default, with a warning in the host form; it is requested on that host's
shell channel only, from the host's agent (or the system agent). Asking to
confirm each use is left for later.

### OSC 52 and authorized_keys

A host's OSC 52 choice is `ask` / `allow` / `deny`; "remember for this host"
in the dialog sets it. Installing a public key appends one line to
`~/.ssh/authorized_keys` over SFTP when the key is not already there
(options and comments ignored when comparing), creating `~/.ssh` (0700) and
the file (0600) if needed.

## Consequences

- Main's surface grows by one channel (`files:grant`, preload only) and 14
  calls, all schema-checked with hostile-input tests; no call takes a local
  path from the renderer, and the engine-only calls take paths from main.
- A compromised renderer can upload only files the user granted, download
  only into a folder the user chose, and open forwards on loopback unless the
  user ticked the warning. It can still browse and delete what the host's
  login may delete within the file roots; that is the feature.
- A `hold` session costs a login (and maybe a prompt) when no terminal to the
  host is open; it closes when the browser closes and no forward uses it.
- Image paste needs an upload folder the login can write to; the default
  `~/uploads` replaces Jarvis's `/tmp` choice in the backlog.
