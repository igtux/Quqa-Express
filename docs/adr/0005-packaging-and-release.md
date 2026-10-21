# ADR 0005: Packaging and release

- Status: accepted
- Date: 2026-10-21
- Deciders: AURA (project owner)
- Refines: ADR 0001 (hardening, fuses, no update pings)

## Context

quqa-express ships to Windows first. The owner wants releases kept simple:
no code signing, no Microsoft Store, nothing that needs an administrator,
and a build anyone can check. The app holds SSH keys, so the packaged build
must keep the Electron hardening of ADR 0001 and must not lose the user's
vault on an update or an uninstall by accident.

## Decision

- **Builds.** electron-builder makes two x64 artifacts from the same
  `app.asar`: `quqa-express-<version>-setup.exe` (NSIS) and
  `quqa-express-<version>-portable.exe`. Product name and profile folder are
  `quqa-express`; version from `package.json`.
- **Unsigned.** No certificate, no signing step. SmartScreen warns on first
  start ("More info" → "Run anyway"); README and the release notes say so
  and show how to compare the download with `SHA256SUMS.txt`
  (`Get-FileHash … -Algorithm SHA256`). The checksums are written by
  `scripts/checksums.mjs` in the same job that builds the files.
- **Installer.** Per user (`%LOCALAPPDATA%\Programs\quqa-express`), no
  elevation, directory choice allowed, Start menu and desktop shortcuts.
  The vault lives in `%APPDATA%\quqa-express`, outside the install folder.
  The uninstaller asks whether to delete it (default No; silent uninstalls
  and updates keep it), `build/installer.nsh`.
- **Portable.** Keeps its profile, vault included, in `quqa-express-data\`
  next to the exe (electron-builder sets `PORTABLE_EXECUTABLE_DIR`). With
  the default OS protection (DPAPI) that vault opens only for the same
  Windows account; a master password with "Portable" makes it movable.
- **Fuses and asar.** The fuses of Phase 1 stay (RunAsNode, NODE_OPTIONS
  and inspect arguments off, asar integrity on, load only from the asar).
  `ssh2/util/pagent.exe` (Pageant bridge) is unpacked, and on Windows the
  engine points `child_process.spawn` at the unpacked copy before it loads
  ssh2 (`src/engine/asar.ts`); only `execFile` follows the asar redirect.
- **CI and release.** `ci.yml` runs `pnpm check` on Ubuntu (Docker SSH
  servers, audit, UI tests) and Windows, then packages on Windows and
  smoke-tests the packaged app with Playwright. That package is built with
  the inspect fuse on (Playwright attaches through it); the artifacts users
  download are built separately with every fuse as above. `release.yml`
  runs on `v*` tags on windows-latest and publishes with `gh release
  create` using only `GITHUB_TOKEN` (`contents: write`); a tag with a suffix
  (`v0.1.0-beta.1`) becomes a pre-release. The tag must match the
  `package.json` version (suffix allowed).
- **Left out for now:** SBOM, provenance attestations, code signing,
  auto-update (an opt-in update check stays "later", AGENTS.md rule 8).

## Addendum (2026-10-21, 0.1.0-beta.5)

`package.json` now carries the pre-release suffix (`0.1.0-beta.5`), so file
names include it and the update check can compare betas. A release's notes
start with its `CHANGELOG.md` section, and a tag without one fails.
`THIRD_PARTY_NOTICES.md`, `LICENSE` and `licenses/` ship in `resources/`.
See [ADR 0006](0006-update-check-themes-georgian.md).

## Consequences

- Users see a SmartScreen warning until the app has reputation or is
  signed; checksums are the integrity check, and they come from the same
  GitHub run, so they protect against a broken or swapped download, not
  against a compromised repository.
- Several beta tags of one version produce files with the same names (the
  version in `package.json` stays `0.1.0`); each release keeps its own.
- The Windows smoke test covers the packaged app, DPAPI and start-up, not
  SSH (no Docker on Windows runners); SSH is covered on Linux.
