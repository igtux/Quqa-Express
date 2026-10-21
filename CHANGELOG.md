# Changelog

All notable changes to quqa-express. Each release's section is also the
start of its GitHub release notes and of what the in-app update panel shows
(`scripts/changelog.mjs`, `.github/workflows/release.yml`).

## [0.1.0-beta.7] - 2026-10-21

The 0.1.0-beta.6 tag was never published: its Windows test showed that
Windows PowerShell 5.1 did not run the update helper the way it was started.
This release has everything planned for beta.6.

### Added

- **The portable exe updates itself.** When a new version is out, **Update
  now** downloads the new portable exe into `quqa-express-data\updates\`
  next to your exe, with a progress bar and a **Cancel download** button,
  and checks it against the release's `SHA256SUMS.txt`; a file that does not
  match is deleted and never run. **Restart to update** then closes the app,
  puts the new exe in place under the same file name (your shortcuts keep
  working), checks it once more and starts it. The old version is kept as
  `quqa-express-data\updates\previous.exe`. If anything goes wrong, the old
  exe is put back and started, and `updates\update.log` says why.
- If the portable exe sits in a folder it cannot write to (a read-only USB
  stick, Program Files), the update panel says so and offers the download
  page instead.

### Changed

- The installer download can be cancelled too.

## [0.1.0-beta.5] - 2026-10-21

The 0.1.0-beta.4 tag was never published: its Windows build failed because
two source files differed only in letter case. This release has everything
planned for beta.4.

### Added

- **Liquid glass**, the new default look: frosted, translucent panels over a
  calm dark indigo-to-teal backdrop, with Windows 11 acrylic behind the window
  where available. The terminal itself stays solid and its colour schemes are
  unchanged. **Classic** is one click away in Look and notifications.
- **Update check.** At start and every 6 hours the app looks for a newer
  release on GitHub. A small badge in the top bar opens the version, its date
  and these notes, with **Update now**, **Later** and **Skip this version**.
  The installed app downloads the new installer, checks it against the
  release's `SHA256SUMS.txt` and runs it. The portable app opens the release
  page. You can turn the check off, or check now, in About. Besides SSH, this
  is the only network connection the app makes.
- **Forgot password? Start over** on the lock screen. You type DELETE, and the
  old vault is moved, not deleted, to a `vault-backups` folder in the app's
  data folder. Your `.ssh` folder is never touched.
- Georgian everywhere: Georgian fonts are bundled, so the app needs no
  download for them. The terminal uses BPG Courier and the UI uses Noto Sans
  Georgian. A Georgian letter takes exactly one terminal cell with both the
  WebGL and the DOM renderer.

### Changed

- After you create the vault the app goes straight to the hosts screen, which
  offers **Add host** and **Import from ~/.ssh**. The import is no longer a
  first-run step.
- Zoom shortcuts (Ctrl+= / Ctrl+- / Ctrl+0) also go by physical key, like the
  other shortcuts, so they work with Georgian, Russian and other layouts.
- The version in `package.json` now carries the pre-release suffix, so files
  are named `quqa-express-0.1.0-beta.5-setup.exe`.

## [0.1.0-beta.3] - 2026-10-21

### Fixed

- The Windows smoke test finds the master-password field exactly (a checkbox
  label contains the same words).
- CI reports Playwright failures as GitHub annotations.

## [0.1.0-beta.2] - 2026-10-21

### Fixed

- The Windows packaging step for the smoke test runs in bash, because
  PowerShell split the `-c.electronFuses…=true` arguments.

## [0.1.0-beta.1] - 2026-10-21

First public beta for Windows 10 and 11 (x64). It has an isolated SSH
engine, an encrypted vault (DPAPI and/or master password), strict host keys,
saved hosts with tabs, panes and resumable tmux sessions, a sessions dock and
switcher, SFTP files with resumable transfers, image paste, port forwards,
jump hosts and SSH agent support. Ships as an unsigned NSIS installer and a
portable exe with `SHA256SUMS.txt`.
