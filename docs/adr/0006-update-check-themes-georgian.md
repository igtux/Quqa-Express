# ADR 0006: Update check, glass theme, Georgian fonts, starting over

- Status: accepted
- Date: 2026-10-21
- Deciders: AURA (project owner)
- Refines: ADR 0001 §8 (no update pings), ADR 0005 (release), ADR 0002 (vault)

## Context

The owner tested beta.3 on Windows and asked for five changes in 0.1.0-beta.5:

- Georgian has to look right in the terminal and in the UI.
- There should be no forced first-run import.
- Users should hear about new releases.
- A modern default look.
- A way out when the master password is lost.

Two of these touch earlier decisions. ADR 0001 said the update check would
be off by default. ADR 0005 said the vault is never touched without the
password.

## Decision

### Update check: the one network call besides SSH (default on, opt-out)

- **What.** Main (not the renderer, whose network stays blocked) sends
  `GET https://api.github.com/repos/igtux/Quqa-Express/releases?per_page=30`
  about 8 s after start and then every 6 hours while the app runs. It sends
  no identifiers, only a `User-Agent: quqa-express/<version>`. Redirects are
  refused and the answer is capped at 4 MiB.
- **Default on, opt-out.** The owner's choice reverses ADR 0001 §8 for this
  one call. The switch is About → "Check for updates automatically", next to
  "Check now". It is stored in `settings.json` in the profile folder, not in
  the vault, so it works before unlock. Tests never reach GitHub: under the
  test hooks main is offline, or reads a releases file given by
  `QUQA_TEST_RELEASES`.
- **What counts as newer.** Releases go through semantic-versioning order
  against the build's own version, `0.1.0-beta.N` included (`src/main/updates.ts`).
  Pre-releases count only while the running app is a pre-release. Every
  field from GitHub is checked: the tag pattern, `html_url` and asset URLs
  must point into this repository, drafts are skipped, notes are cut at
  `## Download` and stripped of control and bidi characters. "Skip this
  version" hides that version until a newer one appears.
- **Showing it.** A small badge in the top bar, shown only when there is a
  newer release, opens a compact panel with the version, its date and the
  notes, plus **Update now**, **Later** and **Skip this version**. The notes
  are rendered by our own small Markdown parser into React elements. HTML
  is never parsed, and only `http(s)` links work. A link asks first, then
  opens in the system browser (main re-checks it).
- **Updating.** The NSIS install downloads the setup exe from the release
  and checks it:
  - the final download host must be GitHub's,
  - the size must equal the asset size,
  - the SHA-256 must equal the line in the release's `SHA256SUMS.txt`.

  Only then is it started, detached, and the app quits. The vault is outside
  the install folder, so it stays. The portable exe, and any build that
  cannot update itself, opens the release page instead (superseded for the
  portable exe in 0.1.0-beta.7: see the addendum below). electron-updater
  was not used: it adds a runtime dependency and wants `latest.yml`
  metadata, and a small downloader with a checksum check is about 150 lines
  of our own code.
- **What the checksum proves.** `SHA256SUMS.txt` comes from the same
  release, so it catches a broken or swapped download and a wrong redirect,
  not a compromised repository (as in ADR 0005). The builds stay unsigned.
- **Release notes.** `release.yml` starts the release body with the tag's
  section of `CHANGELOG.md` (`scripts/changelog.mjs`). A tag without a
  section fails before anything is built.
- **Version.** `package.json` now carries the full version
  (`0.1.0-beta.5`). Before this, every beta was `0.1.0`, so the app could
  not tell betas apart. File names include the suffix.

### Liquid glass theme (default), Classic kept

- The app theme is `glass` (default) or `classic`, kept in `settings.json`,
  set on `<html data-theme>`. All glass rules are in `styles/glass.css`
  under `:root[data-theme='glass']`. Classic is the unscoped CSS from
  earlier phases, unchanged.
- Glass is a dark indigo/teal gradient scene behind translucent panels
  (`backdrop-filter: blur() saturate()`), with 1 px light borders, inner top
  highlights, layered shadows and 10 to 20 px radii. It covers the top bar,
  favorites, hosts, dialogs, menus, switcher, dock, file browser and
  notices.
- The terminal area stays solid, and colour schemes are untouched.
- Contrast is AA or better: secondary text ≥ 7:1, and white on the primary
  gradient ≥ 5.4:1 (#4f46e5 → #0f766e).
- On Windows 11 22H2+ (build ≥ 22621) the window uses
  `backgroundMaterial: 'acrylic'` with a transparent background colour, and
  the CSS scene becomes a translucent tint (`data-material="on"`). Elsewhere
  the CSS gradient stands in. Changing the theme switches the material live.

### Georgian

- Two fonts are bundled, so the app stays offline. Their licences are in
  `THIRD_PARTY_NOTICES.md` and ship in `resources/`.
  - **BPG Courier** (GPL, redistribution allowed, unmodified separate file),
    as in Jarvis NG, is first in every terminal stack.
  - **Noto Sans Georgian** (OFL 1.1, family name "Quqa Georgian Sans") is
    first in the UI stacks and last in the terminal stacks, for Mtavruli.
- Both are declared with a Georgian-only `unicode-range`, so Latin text
  keeps the system or chosen font.
- The fonts are loaded before terminals cache glyphs. When any font finishes
  loading, each terminal clears its WebGL texture atlas, so no fallback
  glyph stays in the atlas.
- Cell widths: xterm measures the Latin font. BPG Courier's Georgian advance
  (0.598 em) is close to Cascadia Mono's (0.586 em).
  - WebGL: `rescaleOverlappingGlyphs` squeezes anything wider.
  - DOM renderer: per-glyph letter spacing aligns it.
  - The UI test checks that 30 Georgian characters span the same width as
    30 ASCII characters.

### Starting over without the password

- On the lock screen (and when the vault file is unreadable): "Forgot
  password? Start over" opens a dialog. It lists what is lost (hosts,
  vault-only keys, saved passwords and passphrases, pinned host keys,
  vault settings), says that `.ssh` is untouched, and needs `DELETE` typed.
  The IPC parameter itself is the literal `"DELETE"`.
- The engine refuses while unlocked. Otherwise it moves `vault.json`,
  `vault.json.bak` and leftover temp files of an interrupted write into
  `vault-backups/<UTC time>/` in the profile folder. Nothing is deleted,
  and the folder is shown afterwards. Then it reopens an empty vault.
  Open terminals are closed first.

### Smaller

- No first-run import screen. The hosts screen's empty state offers
  **Add host** and **Import from ~/.ssh**. The latter is the former
  welcome dialog, also in the hosts toolbar.
- Zoom shortcuts also match by physical key (`keys.ts`, ported from Jarvis
  NG `apps/web/src/kit/keys.ts`).

## Consequences

- The app now contacts api.github.com and, on "Update now",
  github.com / release-assets.githubusercontent.com. README, About and
  AGENTS.md rule 8 say so.
- Unsigned installers are run by the app after a checksum check. Users who
  want to check provenance themselves can turn the check off and download
  by hand.
- The glass theme costs some GPU time for blur. Classic is available for
  slow machines.
- The BPG Courier GPL notice must ship with every build (it does, via
  `extraResources`).

## Addendum (0.1.0-beta.7): portable self-update

### Context

The owner wants the portable exe to update itself, like the installed build.
electron-builder's portable target is an NSIS stub: it unpacks the app to a
temp folder, sets `PORTABLE_EXECUTABLE_FILE` (the real exe) and
`PORTABLE_EXECUTABLE_DIR`, runs the app with `ExecWait` and deletes the temp
folder afterwards. So the user's exe stays open, held by the stub, for as
long as the app runs, and a running exe cannot be overwritten.

### Decision

- **Where.** `src/main/portable-update.ts` (plain Node, no Electron). The
  real exe path is resolved to its final long form (`realpathSync.native`,
  so an 8.3 short name never renames the file) and checked: a drive-letter
  or UNC path, no device paths (`\\?\`, `\\.\`), no `.`/`..` segments,
  no characters Windows forbids, no streams, no bidi controls, at most 259
  characters (Windows PowerShell 5.1 still trips over `MAX_PATH`), and its
  folder must equal `PORTABLE_EXECUTABLE_DIR`. A path that fails gets the
  download page with the reason.
- **Writable?** After a check finds a release, main creates
  `quqa-express-data\updates\` and writes and deletes a probe file there and
  next to the exe. If that fails (read-only stick, Program Files), "Update
  now" becomes "Open download page" with an explanation.
- **Download.** The release's `quqa-express-<ver>-portable.exe` (same URL,
  redirect-host, size and `SHA256SUMS.txt` checks as the installer) goes to
  `updates\<name>.partial` and is renamed only after it matches. The new exe
  is on the same drive as the old one, so the swap is a rename. Progress is
  shown; **Cancel download** aborts the request and deletes the partial file.
  The phase becomes `ready`: **Restart to update** or **Discard download**.
- **Restart.** Main hashes the file once more, writes the helper script
  `updates\apply-update.ps1` (a constant text) and starts Windows PowerShell
  5.1 by its full `System32` path with a hidden console, then quits. It is
  not started `detached`: Node gives a detached child no console
  (DETACHED_PROCESS), and PowerShell 5.1 then does not run at all. A plain
  child sits in the job object Node (libuv) puts its children in, which is
  killed when the app exits; the job allows silent breakaway, so the
  script's first copy only starts a second PowerShell (same exe, constant
  arguments, no window, inheriting the environment) and waits for it. The
  second one does the work and survives the app (tested on Windows). The script
  returns its result code and the command line exits with it, because 5.1
  does not pass `exit` out of a script block run by `-Command`. The
  command line is a constant too: `-Command` runs
  `[scriptblock]::Create([IO.File]::ReadAllText($env:QUQA_UPDATE_SCRIPT))`.
  Every value (exe path, download, `previous.exe`, SHA-256, log, the app's
  and the stub's process ids) travels in `QUQA_UPDATE_*` environment
  variables, so no path is ever quoted into a command line or script, and
  spaces, Georgian letters, apostrophes and brackets need no escaping. The
  script uses literal .NET file calls (`[IO.File]::Move`, `Get-FileHash
  -LiteralPath`), never wildcard paths, `Invoke-Expression` or `cmd`.
  Electron, Node, portable-stub and test variables are not handed on.
- **The helper** waits (up to 90 s each) for the app and the stub to exit,
  checks the SHA-256 again, deletes the old `previous.exe`, moves the exe to
  `updates\previous.exe`, moves the new exe to the exe's exact path and name,
  checks the SHA-256 of the file now in place and starts it. Each move is
  retried for 30 s (antivirus scans and the stub's clean-up hold files
  briefly). If any step fails, the old exe is moved back and started; if
  the new exe does not start, it is moved away and the old one restored.
  It logs each step, without secrets, to `updates\update.log`.
- **Clean-up.** At start the app deletes everything in `updates\` except
  `previous.exe` and a log under 256 KiB. `previous.exe` stays for a manual
  roll back (run it, or put it back by hand); there is no roll-back button.
- **Tests.** Unit tests for path checks, the download and checksum flow
  (mismatch, missing line, cancel, a file changed after the check, read-only
  folder) and the launch (constant arguments; values with spaces, Georgian
  letters and apostrophes passed byte for byte). On `windows-latest`,
  `test/windows/portable-swap.test.ts` runs the real helper in such a
  folder against a running exe (swap, checksum refusal, roll back), and the
  Windows build job repeats it with the freshly built portable exe.

### Consequences

- The portable build now runs, after a checksum check, an unsigned exe it
  downloaded, with the same trust as the installer path (the checksum comes
  from the same release).
- A PowerShell window never shows, but PowerShell must be present and not
  blocked by policy (it is on every Windows 10 and 11; `-ExecutionPolicy
  Bypass` covers the default policy; a Group Policy that forbids PowerShell
  makes the update fail safely, keeping the old exe).
- The first run of the new exe is again an unsigned exe from a new path for
  SmartScreen, but it carries no mark of the web (main downloaded it), so
  Windows does not prompt.
