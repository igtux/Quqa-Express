# ADR 0001: Stack and security model

- Status: accepted
- Date: 2026-10-21
- Deciders: AURA (project owner)

## Context

quqa-express is a standalone desktop SSH terminal: Windows first, macOS and
Linux later, fully offline, single user, Apache-2.0, built in the open at
https://github.com/igtux/Quqa-Express.

It ports the terminal and SSH side of Jarvis NG, AURA's web platform
(reference at `/home/irakli/jarvis_ref`): React + xterm.js in the browser and
a separate SSH gateway on Node with the `ssh2` library, where private keys
live and never leave. Voice/speech, terminal sharing and everything
multi-user stay behind (see `docs/FEATURES.md`).

An SSH client holds the keys to the user's servers. The stack has to keep
those keys out of reach of whatever renders untrusted terminal output, and
the project has to stay simple enough for one person to build and release
without paid services.

## Decision

### 1. Electron, not Tauri

- **Shell:** Electron, with React for the UI and xterm.js (WebGL renderer)
  for the terminal.
- **SSH engine:** the Node `ssh2` library running in an Electron
  `utilityProcess`, separate from both the main process and the renderer.

Why Electron over Tauri:

- **xterm.js reliability.** xterm.js is built and tested on Chromium (VS
  Code ships it on Electron). Tauri uses the system webview: WebView2
  (Chromium) on Windows but WebKitGTK on Linux and WKWebView on macOS, where
  the WebGL renderer, IME, clipboard and font measurement differ. One engine
  on every platform means one set of bugs.
- **Reuse.** Jarvis's SSH code (connection pool, host-key pinning and scan,
  key generation, SFTP with resumable uploads, tmux attach/history) is
  TypeScript on `ssh2`. In Electron it runs unchanged in a Node process; in
  Tauri it would need a Rust rewrite (russh) or a bundled Node sidecar,
  which loses Tauri's size advantage anyway. The React terminal code
  (`connection.ts`, dock, switcher, themes) ports with its transport swapped
  from WebSocket to IPC.
- **Cost accepted:** a larger download (~100 MB installed) and the duty to
  follow Electron security releases. Both are acceptable for a terminal
  that people keep open all day.

### 2. Process model

```
renderer (React, xterm.js)   -- sandboxed, no Node, untrusted output lives here
   | contextBridge: typed intents only (connect host H, send bytes, resize, upload file F)
preload (minimal)
   | ipcRenderer.invoke / MessagePort
main (window, menus, dialogs, safeStorage, settings, IPC validation)
   | MessagePort
engine (utilityProcess: ssh2, vault, keys, SFTP, tmux commands)
```

- The renderer never sees a private key, passphrase, password or the vault
  data key. It sends **intents** ("open a terminal on host `h_…`", "import
  the key at this path", "answer this keyboard-interactive prompt") and gets
  back public data (fingerprints, public keys, states, terminal bytes).
- Terminal bytes flow over a dedicated `MessagePort` per terminal between
  renderer and engine, so the main process is not on the hot path.
- Every IPC message, in both directions across a trust boundary, is
  validated against a schema (TypeBox/JSON Schema, generated types); unknown
  channels and fields are rejected. Identifiers (host ids, session names)
  are matched against strict patterns before use.

### 3. Electron hardening

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  `webSecurity: true`, no `webviewTag`, `enableRemoteModule` absent.
- Only local content: the app loads its own bundled files through a custom
  `app://` protocol; `will-navigate` and `setWindowOpenHandler` deny
  everything; links from terminal output (`http`/`https` only) open in the
  system browser after a check in main.
- Strict CSP: `default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'` (xterm sets inline styles); `connect-src 'self'`; no
  `unsafe-eval`, no remote origins.
- Permission requests (camera, mic, geolocation, notifications beyond our
  own) are denied by a `setPermissionRequestHandler`.
- **Electron fuses** flipped at package time: `RunAsNode` off,
  `EnableNodeOptionsEnvironmentVariable` off,
  `EnableNodeCliInspectArguments` off,
  `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on,
  `EnableCookieEncryption` on.
- DevTools are disabled in release builds.

### 4. Supply chain

- Few dependencies, each one justified in its PR. Runtime set: electron,
  react, react-dom, @xterm/* addons, ssh2, a schema validator, an Argon2id
  implementation and a libsodium binding (or Node `crypto` only, see §5).
- `pnpm` with a committed lockfile; CI installs with `--frozen-lockfile`.
  Install scripts are allowed only for an explicit allow-list
  (`allowBuilds` in `pnpm-workspace.yaml`); ssh2's optional native add-ons
  stay off, so no compiler or native code enters the build.
- CI runs `pnpm audit` (fails on high/critical), generates an SBOM
  (CycloneDX) attached to every release, and runs secret scanning.
- Dependabot/Renovate for updates; Electron is kept on a supported major.

### 5. Vault

- Everything secret (private keys, passphrases, saved passwords) lives in
  one encrypted vault file in the app data folder.
- Each item is encrypted with **XChaCha20-Poly1305** (libsodium) or, if we
  stay on Node `crypto` only, **AES-256-GCM** with a random 96-bit nonce;
  the item's id and kind are the associated data, so a ciphertext moved to
  another item fails to decrypt (the same idea as Jarvis's
  `packages/crypto/src/secret-box.ts`).
- A random 256-bit **data key** encrypts the items. The data key is
  wrapped by:
  - **Electron `safeStorage`** (DPAPI on Windows, Keychain on macOS,
    libsecret on Linux) by default, so the vault opens without a prompt for
    the logged-in OS user; and optionally
  - a **master password** via **Argon2id** (memory-hard; parameters stored
    with the vault and raised over time). With a master password set, the
    vault needs both, or the password alone if the user chooses "portable
    vault" (needed for the portable zip on another machine).
- On Linux without a keyring `safeStorage` falls back to a weak key; then a
  master password is required.
- The data key lives only in the engine process, and only while unlocked.
  Auto-lock after idle time is a setting.

### 6. Keys, hosts and host keys

- Keys are generated (Ed25519 by default) and imported only in the engine.
  Imported key text is parsed, sealed and dropped; it is never written in
  plain text and never returned.
- **Strict host keys.** Every connection verifies the presented host key
  against the host's pins. An unknown host shows a trust prompt with the
  SHA256 fingerprint (explicit TOFU: nothing is trusted without a click);
  a **changed key blocks the connection** until the user deliberately
  trusts the replacement. Pins can be imported from `~/.ssh/known_hosts`.
  The engine pins what it scanned, never key material from the renderer.
- **Agent forwarding is off by default** and per-host opt-in with a
  warning. Using a local agent (Windows OpenSSH pipe, Pageant) for
  authentication is fine; forwarding it to a server is a separate switch.
- Port forwards bind to `127.0.0.1` unless the user changes it.

### 7. Terminal output is untrusted

- **OSC 52**: clipboard *writes* need a confirmation per host (which may be
  remembered); clipboard *reads* are always denied.
- **Paste warnings**: multi-line text outside bracketed paste, very large
  pastes and pastes with control characters ask before sending.
- Links open only for `http(s)`, in the system browser.
- No other escape sequence reaches anything beyond xterm (no OSC 8 file
  links to local paths, no title-driven actions).

### 8. Offline: no telemetry, no network except SSH

- No telemetry, crash reporting, analytics, remote fonts, CDN or update
  pings. The only sockets the app opens are the SSH connections (and port
  forwards) the user asked for.
- An optional self-update check (later) is **off by default**; when on, it
  only reads the GitHub Releases API for this repository and tells the user;
  it does not download or run anything by itself.
- The optional AI recap (later, see `docs/FEATURES.md` §13) is off by
  default, needs the user's own API key, and is the one documented
  exception, made only when the user turns it on.

### 9. No code signing

- No Authenticode certificate, no Microsoft Store, no notarization, no paid
  service of any kind. Releases are a plain **NSIS installer** (unsigned)
  and an optional **portable zip**, built by GitHub Actions on
  `windows-latest` and published on GitHub Releases.
- **Consequence:** Windows SmartScreen shows "Windows protected your PC" on
  first run of the installer ("More info" → "Run anyway"), and some
  antivirus tools may be more suspicious of an unsigned binary. We say so
  plainly in the README and the release notes.
- **Verification instead of signing:** every release publishes
  `SHA256SUMS.txt` next to the assets, produced by the same CI run, and the
  release page shows the CI run that built it. Users verify with:

  ```powershell
  Get-FileHash .\quqa-express-Setup-0.1.0.exe -Algorithm SHA256
  # compare with the line in SHA256SUMS.txt
  ```

  ```sh
  sha256sum -c SHA256SUMS.txt --ignore-missing
  ```

  Building from source with the locked dependencies gives the same app.
  GitHub artifact attestations (`actions/attest-build-provenance`, free for
  public repositories) are added to the release when available, so
  `gh attestation verify <file> --repo igtux/Quqa-Express` can confirm the
  file came from this repository's CI.

## Consequences

- Keys are only ever in one process (the engine); a renderer compromise
  through hostile terminal output can ask the engine to do what the UI can
  do, but cannot read keys or the vault.
- All IPC needs schemas and tests; adding a feature means adding an intent,
  not giving the renderer more power.
- The download is bigger than a native app, and we must ship Electron
  security updates promptly.
- Unsigned releases mean a SmartScreen warning on Windows until (if ever)
  free signing becomes available; checksums and provenance are the trust
  path.
