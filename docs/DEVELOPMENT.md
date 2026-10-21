# Development

Everything builds and tests inside a container, so the host needs only
Docker. The image (`docker/dev.Dockerfile`) is the Playwright base image with
Node 22, pnpm and Xvfb; `docker/compose.yml` adds two disposable OpenSSH
servers (`docker/test-sshd`) for the end-to-end tests: `test-sshd` on the dev
network, and `test-sshd-inner` on an internal network that only `test-sshd`
joins, so the dev container reaches it only through a jump host. Each server
makes fresh host keys when it starts.

```sh
# Once
docker compose -f docker/compose.yml build
docker compose -f docker/compose.yml run --rm dev pnpm install

# Every change: lint + typecheck + unit and end-to-end SSH tests
docker compose -f docker/compose.yml run --rm dev pnpm check

# UI tests (Playwright drives the built Electron app under Xvfb). Keep the
# `sh -c`: xvfb-run as the container's PID 1 can miss Xvfb's ready signal
# and wait forever.
docker compose -f docker/compose.yml run --rm dev sh -c 'xvfb-run -a pnpm test:ui'
```

`test/ui/look.spec.ts` screenshots every screen in both app themes (and
Georgian in the terminal with the WebGL and the DOM renderer) into
`ui-screenshots/` (git-ignored; CI uploads it as an artifact). Look at
them after any UI change. It starts Electron with SwiftShader WebGL
(`--ignore-gpu-blocklist --enable-unsafe-swiftshader`), because Xvfb has no
GPU. The update badge is tested with a fake releases list
(`QUQA_TEST_RELEASES`, honoured only with `QUQA_TEST_HOOKS=1`). Under test
hooks main never contacts GitHub.

The container runs as uid 1000, so files it writes into the checkout stay
yours. `pnpm check` must pass before every commit; CI runs it on Ubuntu and
Windows.

## Commands

| Command          | What it does                                                   |
| ---------------- | -------------------------------------------------------------- |
| `pnpm dev`       | electron-vite dev server with hot reload (needs a display)     |
| `pnpm build`     | builds main, engine, preload and renderer into `out/`          |
| `pnpm start`     | runs the built app                                             |
| `pnpm check`     | `lint` (ESLint + Prettier), `typecheck`, `test`                |
| `pnpm test`      | Vitest: unit tests, plus `test/e2e` when an SSH server is set  |
| `pnpm test:e2e`  | only the SSH engine end-to-end tests                           |
| `pnpm test:ui`   | builds, then every Playwright `_electron` test in `test/ui`    |
| `pnpm test:smoke`| only `test/ui/smoke.spec.ts` (start-up, vault, a local terminal, About, restart) |
| `pnpm dist:win`  | unsigned installer + portable `.exe` + `SHA256SUMS.txt` in `release/<ver>/` |
| `pnpm format`    | Prettier, writing                                              |

`pnpm dev` and `pnpm start` open a window, so run them on your desktop
(Windows, macOS or Linux with Node 22 and pnpm), not in the container: the
container has no user namespaces for Chromium's sandbox (for a quick look
there, `xvfb-run -a pnpm dev --noSandbox`). `pnpm install` downloads the
Electron binary (postinstall).

## End-to-end tests

`test/e2e` connects the real engine to an OpenSSH server (with tmux, for the
resumable-session tests). It runs when
`QUQA_TEST_SSH_HOST` is set (the compose file sets it, and the other
`QUQA_TEST_SSH_*` variables, for the `dev` service) and is skipped otherwise.
`test/e2e/phase4.e2e.test.ts` covers SFTP (browse, edit, upload, download,
resume after a dropped connection, cancel, file roots against `..` and
symlink escapes), key install, jump hosts through `test-sshd-inner`
(`QUQA_TEST_SSH_INNER_HOST`), and -L, -R and SOCKS forwards. Transfer tests
slow transfers down with the engine's test-only `transferThrottle` so a drop
lands mid-file. The SSH agent is tested in `src/engine/agent.test.ts` with a
fake agent on a Unix socket and an in-process ssh2 server.
The test server accepts the user `quqa` with the publicly known password
`quqa-test-password`; never expose it. Key-login tests generate their keys at
run time and install them over a password session.

`test/e2e/local.e2e.test.ts` needs no server and always runs. It starts
the shells main would detect, through the real node-pty, with main's
arguments and environment. On Linux that is the login shell: Georgian output
as UTF-8 bytes, `stty size` after a resize, `TERM`/`COLORTERM` and the exit
code. On Windows (CI) it runs PowerShell 7, Windows PowerShell and cmd through
ConPTY: `Write-Output` of Georgian, console encodings `utf-8/utf-8`, code page
65001 and exit codes. node-pty ships prebuilt N-API binaries for every
platform (`allowBuilds: node-pty: false`), so neither the container nor the
Wine cross-build compiles anything. The Wine build packs the same
`prebuilds/win32-x64` files as the Windows CI build.

Engine and vault tests create their vaults in temporary folders with small
Argon2id parameters; nothing touches your real app data.

The UI test also uses the server when the variables are set: it adds a host,
opens two tabs and a split, uses the switcher and the sessions dock, closes a
tmux tab and re-attaches it, browses files (new folder, upload and download
with main's dialogs stubbed, rename, delete), pastes an image into a
terminal, starts a port forward and stops it on the Tunnels screen, restarts
the app to check the restored layout, and finally ends the tmux sessions it
created on the server. A run that was interrupted can leave tmux sessions
behind, which the switcher counts; end them with
`docker exec quqa-express-dev-test-sshd-1 su quqa -c 'tmux kill-server'`. It starts the
app with `QUQA_TEST_HOOKS=1`, a throw-away profile (`QUQA_USER_DATA`) and
`QUQA_TEST_NO_OS_KEYSTORE=1` (act as if there were no OS key store, so the
vault needs a master password); main honours the last two only together with
the first. On Linux,
Playwright starts Electron with `--no-sandbox` (Chromium's OS-level sandbox;
the renderer's `sandbox`/`contextIsolation` preferences still apply and are
checked). To test a packaged build, point
`QUQA_APP_EXECUTABLE` at it; it must be built with
`-c.electronFuses.enableNodeCliInspectArguments=true`, because Playwright
attaches through the inspector.

## Windows builds

`pnpm dist:win` uses electron-builder (`electron-builder.yml`, ADR 0005):
`quqa-express-<version>-setup.exe` (NSIS, per user, no admin) and
`quqa-express-<version>-portable.exe` for x64, no code signing (SmartScreen
warns on first start), then `scripts/checksums.mjs` writes
`SHA256SUMS.txt`. It works natively on Windows and cross-builds from Linux
in the Wine image:

```sh
docker compose -f docker/compose.yml run --rm dev pnpm build
docker run --rm -u 1000:1000 -e HOME=/tmp/home -e CSC_IDENTITY_AUTO_DISCOVERY=false \
  -v "$PWD":/project -w /project electronuserland/builder:wine \
  sh -c 'node node_modules/electron-builder/cli.js --win nsis portable --x64 && node scripts/checksums.mjs'
```

The uninstaller's "also delete your data?" question is in
`build/installer.nsh`. The icon is drawn in `build/icon.svg`;
`node scripts/icons.mjs` (needs `rsvg-convert`) renders `build/icon.png` and
`build/icon.ico` from it, and both are committed.

To smoke-test a packaged build (CI does this on Windows), package it with the
inspect fuse on, which Playwright needs, and point the test at the exe:

```sh
pnpm exec electron-builder --win dir --x64 \
  -c.electronFuses.enableNodeCliInspectArguments=true -c.directories.output=release/smoke
QUQA_APP_EXECUTABLE=release/smoke/win-unpacked/quqa-express.exe pnpm test:smoke
```

## CI and releases

`.github/workflows/ci.yml` runs on every push to `main` and on pull requests:
`pnpm check` on Ubuntu (with the Docker SSH server, so the end-to-end tests
run; plus `pnpm audit --audit-level high` and the UI tests under Xvfb) and on
Windows (the SSH end-to-end tests skip there; the local terminal ones run
pwsh, Windows PowerShell and cmd), then a Windows job packages the app, runs
the smoke test against it (which opens a local PowerShell tab, so the
unpacked node-pty is exercised in the shipped layout) and uploads the installer, the portable
exe and the checksums as an artifact. Job logs need a GitHub login, so a
failing test run also writes one annotation listing every failed test
(`scripts/ci-failures.mjs`), readable through the public API:
`/repos/igtux/Quqa-Express/check-runs/<job id>/annotations`.

To release:

1. Set the full version in `package.json`, suffix included (`0.1.0-beta.5`).
2. Add its section to `CHANGELOG.md` (`## [0.1.0-beta.5] - <date>`).
   `node scripts/changelog.mjs v0.1.0-beta.5` prints what the release body
   and the app's update panel will show. A tag without a section fails.
3. Commit, then push an annotated tag:

```sh
git tag -a v0.1.0-beta.5 -m "quqa-express 0.1.0 beta 5"
git push origin v0.1.0-beta.5
```

`.github/workflows/release.yml` checks that the tag matches the version (a
suffix such as `-beta.1` is allowed and makes a pre-release), runs
`pnpm check` and the packaged smoke test on windows-latest, builds, and
publishes the setup exe, the portable exe and `SHA256SUMS.txt`. The notes
start with the changelog section, followed by the SmartScreen and checksum
notes. It uses only `GITHUB_TOKEN`. Installed apps find the release through
the update check (ADR 0006). The installed build verifies the setup exe
against `SHA256SUMS.txt` before it runs it, and the portable build verifies
the portable exe before it swaps itself for it, so all three files must be
attached.

The portable swap helper (`src/main/portable-update.ts`) is a PowerShell
script, so it is only really tested on Windows:
`test/windows/portable-swap.test.ts` runs it in a folder named with spaces,
Georgian letters, an apostrophe and brackets (skipped elsewhere). CI's
Windows build job runs it again with the freshly built portable exe
(`QUQA_TEST_PORTABLE_EXE`). If a user reports a failed update, their
`quqa-express-data\updates\update.log` says which step failed.

## Layout

```
src/main/      Electron main: window, hardening, IPC relay (validates everything)
src/preload/   contextBridge API (window.quqa), CommonJS for the sandbox
src/engine/    SSH engine (ssh2) run as a utilityProcess; plain Node, unit-testable;
               remote-files / transfers (SFTP), forwards + socks, jump, agent
src/engine/vault/  encrypted vault (format and crypto: docs/adr/0002-vault.md)
src/pty/       local terminals (node-pty) run as a second utilityProcess (ADR 0007)
src/shared/    IPC contract: protocol.ts (no deps), ipc.ts (renderer ↔ main schemas, AppCalls),
               engine-protocol.ts (main ↔ engine), csp.ts
src/renderer/  React UI: hosts/ (hosts screen, forms, ssh config import),
               terminal/ (xterm session, workspace, dock model, themes), components/
test/e2e/      engine against a real SSH server; local.e2e: real shells through node-pty
test/ui/       Playwright: smoke (also on the packaged Windows build), app (with SSH),
               look (screenshots of both themes, Georgian, update panel)
docker/        dev image, compose stack, test SSH server
build/         icon (SVG source, .ico, .png) and the NSIS uninstaller hook
scripts/       icons, SHA256SUMS.txt, CI failure summary
```
