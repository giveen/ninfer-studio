# Security Policy

## Supported Versions

Only the **latest tagged release** receives security fixes. Track `v*` tags on the
Releases page; the `main` branch is development and may contain breaking changes.

## Reporting a Vulnerability

Please report security issues **privately**:

- Open a [GitHub Security Advisory](https://github.com/giveen/ninfer-studio/security/advisories/new)
  (preferred — keeps details confidential until a fix ships), or
- Email the maintainer (see the profile on the repo) if you cannot use the advisory form.

Do **not** open a public issue for security reports. You can expect an acknowledgement
within a few days; we'll coordinate a fix and (if warranted) a coordinated disclosure date.

## Dependency & Supply-Chain Status

This project takes a pragmatic stance on third-party advisories:

- **JavaScript dependencies** (`pnpm audit`): **clean** — no known vulnerabilities.
- **Rust dependencies** (`cargo audit`): 7 advisories, **all of them transitive
  dependencies of Tauri 2.11.5**, none in first-party code:

  | Crate (transitive) | Advisory | Type | Reaches us via |
  |---|---|---|---|
  | `glib` 0.18.5 | RUSTSEC-2024-0429 | unsound (`VariantStrIter`) | `gtk` 0.18 → `muda` / `webkit2gtk` ← `tauri` |
  | `proc-macro-error` 1.0.4 | RUSTSEC-2024-0370 | unmaintained | `glib-macros` ← `glib` |
  | `unic-char-property`, `unic-char-range`, `unic-common`, `unic-ucd-ident`, `unic-ucd-version` (all 0.9.0) | RUSTSEC-2025-0075 / 0080 / 0081 / 0098 / 0100 | unmaintained | `urlpattern` ← `tauri-utils` ← `tauri` |

  The lone `glib` unsoundness is reachable only through the tray menu's GVariant
  string iteration and is not remotely exploitable in normal use. Because these are
  pinned by Tauri's GNOME 0.18 / `urlpattern` stacks, **they cannot be patched
  locally** — `[patch]` cannot rename a crate. The real fix is upstream: Tauri
  moving to newer GTK/`glib` bindings (clears `glib` + `proc-macro-error`) and
  `urlpattern` adopting `idna` 1.0 / `unicode-ident` (clears the `unic-*` set).

  The Dependabot alert for `glib` was reviewed and **dismissed as `tolerable_risk`**
  (it is an upstream transitive dependency, not directly used, and not locally
  patchable). These advisories are tracked upstream rather than blocking releases.

- **Build provenance**: releases are produced by the in-repo GitHub Actions workflow
  (`.github/workflows/release.yml`) on GitHub-hosted runners; artifacts are attached
  to a draft GitHub Release for review before publishing. Windows artifacts are
  currently **unsigned** — expect a SmartScreen warning until code-signing is added.

## Hardening Notes

- The control plane (`desktop/control`) is the only process that touches the engine;
  in the desktop app it runs inside the Tauri core, so the engine's parent is the app
  itself (single-process supervision, no orphaned engines).
- The engine API proxy injects the API key server-side; keep `data/config.json`
  (which holds settings, not secrets) out of shared locations.
- Closing the window hides to the tray and keeps the engine alive by design — quit
  explicitly from the tray menu to stop the engine.
- **Coding harness confinement is asymmetric by design.** The `fs/*`, `grep`, and
  `glob` endpoints (`desktop/control/src/coder.rs`) lexically confine every path to
  the configured workspace. `exec`, however, runs a real `bash -lc <command>` whose
  *starting* directory is confined but whose shell is not sandboxed (no chroot/
  namespace/seccomp) — `cd /`, an absolute path, or a symlink reaches anywhere the
  OS user can. Safe mode (on by default) blocks a fixed set of destructive patterns
  before spawning, but that's a blocklist, not a security boundary — it does not
  make `exec` workspace-confined the way the file tools are.
- **`web_fetch` only reaches public hosts.** The URL an agent (or content it reads)
  passes to `web_fetch` is resolved and checked against loopback/RFC1918/link-local/
  CGNAT/multicast ranges — including through redirects — before any request is
  made, so it cannot be used to reach the loopback control plane or other services
  on the local network (SSRF). `web_search` is unaffected since its target host
  (DuckDuckGo) isn't attacker-controlled.
