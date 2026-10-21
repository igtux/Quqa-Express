# Rules for contributors and AI agents

Read this before changing code. quqa-express holds the keys to people's
servers; these rules keep them safe. The design is in
`docs/adr/0001-stack-and-security.md`.

## Non-negotiable

1. **Keys never leave the engine.** Private keys, passphrases, passwords and
   the vault data key exist only in the SSH engine (the `utilityProcess`).
   No IPC response, log line, error message or file outside the vault ever
   contains them.
2. **The renderer sends intents, not secrets or commands.** It asks "open a
   terminal on host `h_…`", "upload this file", "trust the key I was shown";
   the engine decides how. The renderer gets public data only
   (fingerprints, public keys, states, terminal bytes).
3. **Validate all IPC with schemas.** Every channel has a schema in one
   place; main and the engine reject anything that does not match. Validate
   identifiers against strict patterns. Response schemas keep internal
   fields from leaking.
4. **Keep the Electron hardening.** `contextIsolation`, `sandbox`, no
   `nodeIntegration`, strict CSP, local content only, navigation and new
   windows denied, fuses set. Never weaken one to make a feature work; add
   an intent instead.
5. **Terminal output is untrusted.** OSC 52 writes need confirmation, reads
   are denied; paste warnings stay; links open only for `http(s)` in the
   system browser. Never let an escape sequence trigger an action outside
   xterm.
6. **Host keys are strict.** Never connect without a pinned or explicitly
   trusted host key; a changed key blocks. No "accept all" switch.
7. **No shell string building.** Use argument arrays (`execFile`), or SSH
   exec with every argument escaped by one helper; tmux and other remote
   commands are built only from validated identifiers.
8. **No telemetry, no network beyond SSH.** No analytics, crash upload,
   remote fonts or CDNs. The only sockets are the SSH connections and
   forwards the user asked for, plus one documented exception: the update
   check (main reads this repository's GitHub releases; on by default, the
   user can turn it off; ADR 0006). Any other exception (AI recap) is off by
   default and needs its own ADR.
9. **No secrets in code, logs or tests.** Test keys are generated in the
   test; logs redact anything that could be a secret.
10. **Errors shown to users are deliberate.** Map engine errors to known
    user messages; anything else shows a generic error and is logged
    locally without secrets.

## Dependencies

- Keep them few. Every new runtime dependency needs a reason in the PR
  (what it does, why not 30 lines of our own code, maintenance status).
- The lockfile is committed; never edit it by hand. `pnpm audit` must be
  clean of high/critical findings.

## Workflow

- `pnpm check` (typecheck, lint, tests) must pass before every commit. CI
  runs the same on `windows-latest` plus the security scans.
- Security-relevant code (vault, IPC schemas, host keys, paste/OSC 52,
  path checks) needs tests, including hostile input.
- Significant design choices get an ADR in `docs/adr/` (numbered, short:
  context, decision, consequences).
- Feature status lives in `docs/FEATURES.md`, the plan in
  `docs/BACKLOG.md`; update them with the change.
- Jarvis NG (`/home/irakli/jarvis_ref`, same owner) is the reference: port
  its behaviour and code freely, adapting server/multi-user parts to a
  single-user desktop app. Keep attribution: a ported file says where it
  came from (e.g. `// Ported from Jarvis NG apps/ssh-gateway/src/ssh/host-keys.ts`).
  Do not port voice/speech, terminal sharing or multi-user features.
- Repository: https://github.com/igtux/Quqa-Express. Licence Apache-2.0;
  contributions are accepted under the same licence.
