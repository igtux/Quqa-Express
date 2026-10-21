# quqa-express

A desktop SSH terminal: fast, private and fully offline. Windows first;
macOS and Linux later. Single user, no accounts, no server, no telemetry.
Free and open source under the Apache-2.0 licence.

**Status: beta.** Windows 10 and 11 (x64) builds are on
[GitHub Releases](https://github.com/igtux/Quqa-Express/releases).

## What it does

- Tabs and split panes; xterm.js with WebGL, 20 colour schemes, 12 fonts,
  zoom, search.
- Resumable sessions through tmux on the host; sessions dock, favorites and
  a switcher (Ctrl+Shift+K); automatic reconnect.
- Hosts with groups, tags and live latency; Quick Connect; import from
  `~/.ssh/config`.
- An encrypted vault for keys and passwords (Windows DPAPI, optional master
  password); Ed25519 key generation and import; SSH agent (Windows OpenSSH,
  Pageant).
- Strict host keys: fingerprint prompt on first connect, changed keys
  blocked, known_hosts import.
- SFTP file browser with resumable uploads and downloads; paste an image or
  drop files to upload them; local, remote and SOCKS port forwarding; jump
  hosts.
- Careful clipboard: copy on select, chunked paste with cancel, paste
  warnings, OSC 52 writes only after you allow them.
- Bell and "agent finished" notifications for long-running programs such as
  Claude Code.
- Local terminals: PowerShell 7, Windows PowerShell, Command Prompt or WSL
  in a tab (Ctrl+Shift+\`), with the same look, paste, splits and
  notifications, for running agents such as Claude Code or Codex locally.

Full list: [docs/FEATURES.md](docs/FEATURES.md). Plan:
[docs/BACKLOG.md](docs/BACKLOG.md). Design and security:
[docs/adr/0001-stack-and-security.md](docs/adr/0001-stack-and-security.md).

Built with Electron, React, xterm.js, the `ssh2` library and `node-pty`. Private keys
stay in a separate engine process and never reach the UI. It ports the
terminal side of Jarvis NG, AURA's web platform.

## Download and install (Windows)

Each [release](https://github.com/igtux/Quqa-Express/releases) has three
files:

| File | What it is |
| --- | --- |
| `quqa-express-<version>-setup.exe` | Installer. Installs for your user only (no administrator rights), adds Start menu and desktop shortcuts. |
| `quqa-express-<version>-portable.exe` | No installation. Keeps its data in a `quqa-express-data` folder next to the exe. |
| `SHA256SUMS.txt` | SHA-256 checksums of both. |

**1. Verify the download.** In PowerShell, in your Downloads folder:

```powershell
Get-FileHash .\quqa-express-<version>-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

The `Hash` must equal the line for that file in `SHA256SUMS.txt` (case does
not matter). If it does not, delete the file and download it again.

**2. Run it.** The builds are **not code-signed**, so Windows SmartScreen
says "Windows protected your PC" the first time: click **More info**, then
**Run anyway**. (If the file was blocked as downloaded from the internet,
right-click it → Properties → tick **Unblock**.)

**3. First start.** quqa-express creates an encrypted vault for your keys,
passwords and trusted host keys, protected by your Windows account (DPAPI);
you can add a master password. Then add hosts, or use **Import from
~/.ssh** on the hosts screen to bring over `%USERPROFILE%\.ssh\config`
(with their key files), your `known_hosts` and other keys. Nothing in your
`.ssh` folder is changed. If you forget the master password, **Forgot
password? Start over** on the lock screen moves the old vault to a
`vault-backups` folder and lets you create a new one.

**Uninstall** from Settings → Apps. Your vault in `%APPDATA%\quqa-express`
is kept unless you answer **Yes** when the uninstaller asks. The portable
build leaves nothing behind except its `quqa-express-data` folder; with the
default Windows protection that vault opens only for your Windows account,
so to carry it to another PC create it with a master password and tick
**Portable**.

**Updates.** At start and every 6 hours the app asks GitHub whether a newer
release is out. If one is, a small badge in the top bar shows what's new.
**Update now** downloads the installer, checks it against the release's
`SHA256SUMS.txt` and runs it. The portable exe downloads the new portable
exe, checks it the same way and, on **Restart to update**, replaces itself
under the same file name (the old one stays in
`quqa-express-data\updates\previous.exe`). In a folder it cannot write to
(a read-only stick, Program Files) it opens the download page instead. Turn
the check off in F1 → About.

Apart from that update check, the app makes no network connections of its
own and has no telemetry. The only other connections are the SSH sessions
and tunnels you open.

## Build from source

Requirements: Node.js 22.12 or newer, pnpm (the version in `package.json`,
via `corepack enable`), Git. No compiler is needed: ssh2 runs in pure
JavaScript.

```sh
git clone https://github.com/igtux/Quqa-Express.git
cd Quqa-Express
pnpm install --frozen-lockfile
pnpm check        # lint, typecheck, tests
pnpm dev          # run the app
pnpm dist:win     # unsigned installer + portable exe + SHA256SUMS.txt in release/<version>/
```

`package.json` lists every script; `docs/DEVELOPMENT.md` explains the
container setup, the tests and the release process.

## Contributing

Read [AGENTS.md](AGENTS.md) first: it holds the security rules every change
must follow.

## License

Copyright 2026 AURA. Licensed under the [Apache License 2.0](LICENSE).
