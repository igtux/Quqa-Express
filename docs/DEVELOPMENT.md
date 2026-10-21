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

# UI smoke test (Playwright drives the built Electron app under Xvfb)
docker compose -f docker/compose.yml run --rm dev xvfb-run -a pnpm test:ui
```

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
| `pnpm test:ui`   | builds, then the Playwright `_electron` smoke test             |
| `pnpm dist:win`  | unsigned NSIS installer + portable `.exe` in `release/<ver>/`  |
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

`pnpm dist:win` uses electron-builder (`electron-builder.yml`): NSIS
installer and portable executable for x64, no code signing (SmartScreen warns
on first start). It works natively on Windows and cross-builds from Linux in
the Wine image:

```sh
pnpm build   # in the dev container
docker run --rm -u 1000:1000 -e HOME=/tmp/home \
  -v "$PWD":/project -w /project electronuserland/builder:wine \
  node node_modules/electron-builder/cli.js --win nsis portable --x64
```

CI builds the Windows artifacts on `windows-latest` and uploads them.

## Layout

```
src/main/      Electron main: window, hardening, IPC relay (validates everything)
src/preload/   contextBridge API (window.quqa), CommonJS for the sandbox
src/engine/    SSH engine (ssh2) run as a utilityProcess; plain Node, unit-testable;
               remote-files / transfers (SFTP), forwards + socks, jump, agent
src/engine/vault/  encrypted vault (format and crypto: docs/adr/0002-vault.md)
src/shared/    IPC contract: protocol.ts (no deps), ipc.ts (renderer ↔ main schemas, AppCalls),
               engine-protocol.ts (main ↔ engine), csp.ts
src/renderer/  React UI: hosts/ (hosts screen, forms, ssh config import),
               terminal/ (xterm session, workspace, dock model, themes), components/
test/e2e/      engine against a real SSH server
test/ui/       Playwright smoke test of the Electron app
docker/        dev image, compose stack, test SSH server
```
