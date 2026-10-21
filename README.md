# quqa-express

A desktop SSH terminal: fast, private and fully offline. Windows first;
macOS and Linux later. Single user, no accounts, no server, no telemetry.
Free and open source under the Apache-2.0 licence.

**Status: pre-alpha.** Nothing to install yet; the code is being written.

## Planned for v1

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
  drop files to upload them; local port forwarding; jump hosts.
- Careful clipboard: copy on select, chunked paste with cancel, paste
  warnings, OSC 52 writes only after you allow them.
- Bell and "agent finished" notifications for long-running programs such as
  Claude Code.

Full list: [docs/FEATURES.md](docs/FEATURES.md). Plan:
[docs/BACKLOG.md](docs/BACKLOG.md). Design and security:
[docs/adr/0001-stack-and-security.md](docs/adr/0001-stack-and-security.md).

Built with Electron, React, xterm.js and the `ssh2` library. Private keys
stay in a separate engine process and never reach the UI. It ports the
terminal side of Jarvis NG, AURA's web platform.

## Downloads (when released)

Releases will be on
[GitHub Releases](https://github.com/igtux/Quqa-Express/releases): an
installer and a portable build. They are **not code-signed**, so Windows
SmartScreen will warn on first run ("More info" → "Run anyway"). Check the
download against `SHA256SUMS.txt` from the same release first:

```powershell
Get-FileHash .\quqa-express-Setup-<version>.exe -Algorithm SHA256
```

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
pnpm dist:win     # unsigned NSIS installer + portable build (Windows)
```

Script names may change while the project is pre-alpha; `package.json` is
authoritative.

## Contributing

Read [AGENTS.md](AGENTS.md) first: it holds the security rules every change
must follow.

## License

Copyright 2026 AURA. Licensed under the [Apache License 2.0](LICENSE).
