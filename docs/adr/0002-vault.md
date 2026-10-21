# ADR 0002: Vault format, crypto and secret flow

- Status: accepted
- Date: 2026-10-21
- Deciders: AURA (project owner)
- Refines: ADR 0001 §5 (vault), §2 (process model), §7 (paste warnings)

## Context

Phase 2 adds the encrypted vault, stored keys, persistent host-key pins and
password / passphrase prompts. ADR 0001 left open the cipher library, the
file format, how `safeStorage` (main-process only) combines with a key that
must live only in the engine, and how the renderer stops carrying secrets.

## Decision

### Libraries

- **@noble/ciphers** (XChaCha20-Poly1305) and **@noble/hashes** (Argon2id,
  HKDF-SHA256, SHA-256). Pure JavaScript, zero dependencies, audited, by the
  same maintainer; no native modules and no WASM. Node `crypto` lacks
  XChaCha and (on Node 22) Argon2. A 192-bit random nonce removes any nonce
  reuse concern; Argon2id at 64 MiB × 3 takes about 0.7 s in pure JS, which
  is acceptable for an unlock (the async variant keeps terminals responsive).

### File format (`<userData>/vault.json`, version 1)

```json
{ "format": "quqa-vault", "version": 1,
  "wrap":  { "mode": "os | password | os+password", "salt": "…",
             "kdf": { "name": "argon2id", "memoryKiB": 65536, "iterations": 3, "parallelism": 1 } | null,
             "osBlob": "…" | null, "nonce": "…", "sealed": "…" },
  "items": { "<kind>/<id>": { "nonce": "…", "sealed": "…" } } }
```

- A random 256-bit **data key** seals each item with XChaCha20-Poly1305;
  the associated data is `quqa-vault/v1/item/<kind>/<id>`, so an item moved
  to another id or kind fails to open (tested). Kinds: `key`, `password`,
  `known-hosts`, `settings`. Saved-password ids are a hash, not host names.
- The data key is sealed by a **KEK** = HKDF-SHA256 over the secrets the mode
  needs, with the wrap's salt and `quqa-vault/v1/kek/<mode>` as info, and
  `quqa-vault/v1/data-key/<mode>` as associated data (so editing `mode` in
  the file cannot downgrade it):
  - `os`: a random 32-byte **OS key**, stored in the file only as
    `osBlob = safeStorage.encryptString(osKey)` (DPAPI on Windows).
  - `password`: Argon2id(master password, salt, stored params) — the
    "portable" vault.
  - `os+password`: both.
- A wrong password fails the AEAD tag check; there is no password
  comparison and so no partial-match timing.
- KDF parameters are stored and bounded (a tampered file cannot make them
  trivial or exhaust memory); unlocking a vault with weaker parameters than
  today's re-wraps it with today's (tested as the first migration path).
- `version` is checked; a newer file is refused with "update the app";
  older versions pass through `MIGRATIONS` steps (none exist yet).
- Writes: temp file (`O_EXCL`, mode 0600) + fsync + rename, after copying
  the previous file to `vault.json.bak`. An unparseable main file opens the
  backup; a tampered or newer file does not fall back.
- Linux with the `basic_text` safeStorage backend counts as "no OS key
  store": a master password is required.

### Who holds what

- **Engine** (utilityProcess): reads and writes the vault file itself
  (ciphertext only crosses its boundary), holds the data key while unlocked,
  decrypts items, keeps typed passwords/passphrases for the session's
  reconnects. `lock()` zeroes the data key and drops every cached secret,
  pin and pending prompt; open sessions keep running.
- **Main**: generates the OS key, calls `safeStorage`, and passes the OS key
  (never the data key) to the engine to unlock; shows file dialogs and hands
  the engine the chosen path; locks on system idle time (setting, default
  15 min), sleep and screen lock (setting, default on). An `os` vault
  unlocks itself at start and after an engine restart, unless the user or
  the idle timer locked it.
- **Renderer**: sends intents only. `connect` carries `{kind:'password'}` or
  `{kind:'key', keyId}` — no secret fields exist in the schema. Every call
  goes through one `app:call` channel whose parameters and results have
  strict schemas (`AppCalls`); main checks the result too, and a test walks
  every result schema for secret-like fields.

### Password and passphrase prompts (Phase 1 gap)

Chosen: **engine-side prompts**. The engine's ssh2 `authHandler` asks via a
`prompt` event after the host key is verified; the renderer shows a dialog
with uncontrolled inputs, reads them once on submit, sends
`prompt-answer`, and clears the fields. No secret is kept in React state.
Password logins try the saved password, then ask (up to 3 times, saying why),
then fall back to keyboard-interactive with the server's prompts shown.
"Save in the vault" stores a password only after the server accepted it.
Key passphrases not saved with the key are asked once per unlock.
Pasted key text is the one exception: it is sent once with `keys.import`
and sealed; importing from a file lets the engine read the file directly.

### Host-key changes

On a mismatch the engine keeps the presented key and emits
`host-key-changed` (old and new fingerprints, a token valid 10 minutes,
superseded by a newer attempt). The renderer shows a blocking screen;
"Replace pin" needs a second step with an explicit "I checked the
fingerprint" box, then `hostKeys.replace(token)` pins the key the engine
saw. known_hosts imports (plain and `|1|` hashed) never widen a host the
user pinned in the app.

### Smaller Phase 1 gaps

- The renderer loads from `app://quqa/` (a privileged standard scheme served
  by `protocol.handle` from `out/renderer`, with path containment and a CSP
  header); `file://` is no longer allowed and the
  `grantFileProtocolExtraPrivileges` fuse is off.
- Paste warnings: multi-line text outside bracketed paste, any control or
  bidi-override character (always, since ESC can end bracketed paste), and
  pastes over 64 KiB ask first, for every paste path (keys, right click,
  native paste events).
- **Audit**: `pnpm audit` reported `sprintf-js` (GHSA-hp3w-g68c-fv3c,
  moderate, no patched release) via electron-builder's `@electron/get` →
  `global-agent` → `roarr`, a build-time tool. It is ignored in
  `pnpm-workspace.yaml` with this reason; nothing in the shipped app uses it.

## Consequences

- Main briefly sees the OS key; anyone who can run code as the user can ask
  DPAPI too, which is why `os+password` and `password` modes exist.
- Item deletion or rollback of the whole file by someone with write access
  is not detected (there is no file-wide MAC); confidentiality and
  per-item integrity are.
- Two new runtime dependencies (@noble/ciphers, @noble/hashes).
- "Delete key: used by N hosts" waits for saved hosts (Phase 3); the dialog
  warns generally for now.
