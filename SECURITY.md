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
- The engine API proxy injects the API key server-side. `data/config.json` holds
  real secrets (`apiKey`, `hfToken`) in the clear, not just settings — the control
  plane writes it `0600` (owner read/write only) and it must stay out of shared
  locations regardless.
- Closing the window hides to the tray and keeps the engine alive by design — quit
  explicitly from the tray menu to stop the engine.
- **Coding harness shell sandbox (default ON, per-OS mechanism).** `exec` runs
  a real shell (`bash -lc <command>`; on Windows, git-bash when installed, else
    `cmd /d /s /c`; on Windows a `bash` on PATH that is a WSL alias is ignored,
    since it would be a Linux process) wrapped in an OS-level sandbox unless the
    user disables it in Settings → Safety & Permissions (`coderSandbox`, default on):
  - **Linux** — bubblewrap: `/` bind-mounted read-only, the workspace (plus any
    extra `sandboxBinds` roots) read-write, a private `/tmp`, dropped
    capabilities, `--die-with-parent`. Falls back to an unsandboxed shell when
    bwrap is missing or the kernel refuses its namespaces — the sandbox status
    endpoint reports that state and the UI surfaces it, so the fallback is never
    silent.
  - **Windows** — the child is created at **low integrity** (`S-1-16-4`) inside
    a Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assigned atomically at
    `CreateProcessW`). The integrity policy refuses the child's writes to
    medium-integrity host objects — files, the registry, other processes — even
    where the DACL would allow them; the job kills the whole process tree on
    timeout, kill, or abandonment. The workspace (plus `sandboxBinds` roots) is
    made writable by a temporary write-ACE for the low-integrity SID, revoked
    when the run ends. Caveat: pre-existing files created by medium-integrity
    processes keep their label — the sandbox can read but not overwrite them
    until a run touches them (new files it creates are low-labeled and stay
    writable).
  In neither mode is the sandbox a network boundary (builds still fetch), and
  credential-looking environment variables (`*KEY*`, `*SECRET*`, `*TOKEN*`,
  `*PASSWORD*`) are scrubbed from the child's environment on both OSes. Safe
  mode (on by default) is a separate, complementary blocklist of destructive
  command patterns — it is not a security boundary.
- **`web_fetch` only reaches public hosts.** The URL an agent (or content it reads)
  passes to `web_fetch` is resolved and checked against loopback/RFC1918/link-local/
  CGNAT/multicast ranges — including through redirects — before any request is
  made, so it cannot be used to reach the loopback control plane or other services
  on the local network (SSRF). `web_search` is unaffected since its target host
  (DuckDuckGo) isn't attacker-controlled.
- **The built-in `browser` tool has the same SSRF posture, enforced at two
  layers.** `navigate` runs the same URL check as `web_fetch` up front, and the
  Obscura engine's HTTP client independently refuses loopback/RFC1918/link-local
  connections, so JS redirects and in-page `fetch()` calls on a loaded page
  cannot reach internal services either. Note that the browser executes the
  page's JavaScript in-process (V8 via deno_core, on a per-session driver
  thread); the threat model is intentionally the same as `exec` — an
  agent-controlled code-execution surface either way. The page session is torn down
  automatically after 10 minutes of inactivity.
- **Remote Access (`remoteAccessEnabled`, Settings → Safety & Permissions) is
  intentionally unauthenticated.** Turning it on binds a second listener on
  `0.0.0.0:<remoteAccessPort>` (default 1337) serving the identical app and API
  the loopback listener does — the same `exec`/`fs`/`git`/`browser` tool access
  described above, with no login, token, or CORS/Host restriction. Unlike the
  loopback listener, it does not run `guard_local_host`, by design: the whole
  point is letting another device on the network open it directly. This is a
  user-opted-in tradeoff for zero-friction LAN access, not an oversight. Anyone
  who can reach the port — any device on the same network, or the whole
  internet if a router forwards it — gets full agent control of the host
  machine. Enable it only on a trusted network, and turn it off when done; it
  persists across restarts if left on.
