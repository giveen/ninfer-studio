# NInfer Studio

A from-scratch, **native Linux & Windows desktop app** (Tauri 2 — WebKitGTK on
Linux, WebView2 on Windows) for the
[NInfer](https://github.com/Neroued/ninfer) local LLM inference engine — turning a raw
`ninfer-serve` binary into a product.

> NInfer Studio is the **desktop shell**: engine configuration with per-GPU presets,
> model management with Hugging Face downloads, streaming chat with vision, an agentic
> coding harness, and live token/throughput/VRAM metrics — with the control plane
> running in-process. The inference engine itself (`ninfer-serve`) is a separate
> project you point Studio at.

## Screenshots

| Chat | Engine |
|------|--------|
| ![Chat](screenshots/chat.png) | ![Engine](screenshots/engine.png) |
| **Models** | **Settings** |
| ![Models](screenshots/models.png) | ![Settings](screenshots/settings.png) |

## Features

- **Engine configuration** — every `ninfer-serve` option as a labeled, documented
  control: context/KV capacity & dtype (`bf16` / `int8` / `fp8` / `nvfp4` / `k8v4`),
  concurrency, speculative decoding (MTP / DFlash / DFlash2), vision & media budgets,
  context-cache tiers, sampling defaults, logging — plus a live **generated launch
  command** and one-click **presets**, including RTX 5090 presets calibrated
  from the engine's own measured KV density across the registered artifacts
  (192k long-context MTP, 128k bf16, C=4 nvfp4 serving, 96k low-latency, 128k MoE,
  and two 256k ultra-context presets at the variants' full 262,144-token native
  window — k8v4 dual-lane and NVFP4 single-lane) plus a **community-validated**
  262k fp8 profile ported from `headpiece747/ninfer-5090-windows` (MTP5, prefill
  chunk 1024). The engine does no rope scaling, so `max_context` above a variant's
  native 262,144 fails at startup.
- **Community ecosystem** — the engine (`Neroued/ninfer`) has an active community:
  63 GitHub repos and ~20 Hugging Face `.ninfer` artifact repos. Notable forks add
  features upstream lacks (splickz's `rk4v4-e8` E8-lattice 4-bit KV with YaRN-style
  rope scaling for ~600k-token contexts; Azhu9701's NVMe disk cache and MTP7).
  Studio targets upstream and deliberately does not emit fork-only flags — they
  fail upstream validation. Upstream `--spec mtp` accepts draft tokens 1–5 only;
  dflash/dflash2 accept 1–15. At 262k context on a 32 GB card, keep
  `--max-concurrency` at 1–4 (community-verified: C=8 fails startup).
- **VRAM safety floor** — after load, Studio tails the engine's `capacity` log line
  (its own runtime/free VRAM accounting) and warns when free VRAM drops under the
  1.8 GiB safety floor, before an OOM can kill the run mid-generation. Works for
  adopted engines too.
- **Model management** — scans the models directory for downloaded `.ninfer` artifacts,
  shows the registered catalog with local/download states, and downloads artifacts from
  Hugging Face via the `hf` CLI. An optional **Hugging Face token** (masked in the UI,
  passed via the `HF_TOKEN` env var — never argv) unlocks faster, non-rate-limited
  downloads.
- **Chat** — streaming chat over the engine's OpenAI-compatible API: reasoning shown in
  a collapsible thinking block, per-message engine metrics (TTFT, prompt/decode tok/s,
  cached tokens, MTP draft acceptance), sampling/thinking overrides per conversation,
  image/video attachments rendered **inline in the transcript** (vision engines),
  model-emitted markdown images, live context-usage gauge (context window read straight
  from the engine, no manual `--max-context` bookkeeping), stop button, and persisted
  conversation history. Type `/compact` to ask the engine to condense the whole
  conversation into a structured checkpoint summary, which replaces the thread and
  becomes its starting context (handy before a context-limit warning).
- **Coder mode** — an agentic coding harness over the same engine: plan/act loop with
  file read/write/edit, grep/glob, shell exec with sessions and background jobs, git
  integration, **Scout / Verify / Critic** harness passes (opt-in, labeled, collapsible),
  worker/subagent delegation with depth and step budgets, conversation **checkpoints**
  with restore, human-approval (HITL) gates, sandboxed vs. live execution modes, and a
  per-workspace memory bank — with a live **prefill/decode indicator** so the model
  thinking is never invisible.
- **Engine supervision** — starts/stops `ninfer-serve` from the UI, adopts
  already-running engines (never double-spawns), tails the engine log, reports GPU
  state via `nvidia-smi`, and **stops a running engine before Rebuild** so a fresh
  binary can link cleanly.
- **Context-limit awareness** — the chat view shows live "% of max-context" usage and
  warns before the engine would truncate (approaching >75%, near-full >90%).
- **Desktop polish** — tray icon + **close-to-hide** (closing the window hides to the
  tray and keeps a spawned engine alive, rather than killing it), **single-instance**
  launch (a second launch focuses the existing window), and **native OS notifications**
  for engine ready/stopped, download finished, and build finished. Custom app icon
  across AppImage, Windows exe, and tray.
- **Hardened localhost API** — CORS is an explicit allow-list (Tauri webview + dev
  Vite) and foreign `Host` headers are rejected, closing the DNS-rebinding vector
  against the loopback control plane.
- **Per-user persistence** — app settings, the engine profile, saved named profiles, and
  chat conversations all persist to a per-user config dir (`~/.config/ninfier-studio` on
  Linux, `AppData/Roaming/ninfier-studio` on Windows) so they survive a restart and roam
  with the user's home. Override the location with `NINFIER_STUDIO_DATA`.

## Architecture

```
desktop/         Rust control plane + Tauri 2 desktop shell
  control/       ninfier-control: engine supervision, model scan, hf downloads,
                 coder endpoints, VRAM accounting, nvidia-smi stats, SSE-safe
                 engine API proxy, static hosting
  app/           ninfier-studio: Tauri 2 window hosting the control plane
apps/web         React 19 + Vite + Tailwind 4 frontend
                 (Chat / Coder / Engine / Models / Settings)
apps/sidecar     zero-dependency Node 22 dev-mode server implementing the same control-plane API
start-stack.sh   dev convenience: boot the sidecar, seed config from env vars,
                 start/adopt the engine
~/.config/ninfier-studio/   per-user runtime state (CONFIG_HOME); AppData/Roaming/ninfier-studio
                 on Windows — config.json, profile.json, chats.json, last-start.json,
                 engine-<port>.log. Override location with NINFIER_STUDIO_DATA.
```

The **control plane** (`desktop/control`, or `apps/sidecar` in browser dev mode) is the
only process that touches the engine. In the desktop app it runs inside the Tauri core,
so the engine's parent is the app itself — a single process supervises the engine.

| API | Purpose |
|---|---|
| `GET /api/status` | engine state (incl. adopted external pids, max context window), GPU, VRAM accounting, models, downloads, config (secrets redacted) |
| `POST /api/engine/start` | profile + artifact → `ninfer-serve` argv; spawn, health-poll, log capture |
| `POST /api/engine/stop` | SIGTERM the child (8 s grace) or the adopted external pid |
| `POST /api/engine/update` | `pull` (git pull --ff-only) or `build` (stops a running engine first, then cmake/Ninja) |
| `GET /api/logs?n=400` | tail of the spawned engine's log |
| `GET /api/models` | scan `modelsDir` for `*.ninfer` + registered catalog |
| `POST /api/models/download` | `hf download <repo> <file> --local-dir` (uses `HF_TOKEN` when set) |
| `GET /api/gpu` | `nvidia-smi` memory/util/process list |
| `GET/POST /api/config` | app settings (config dir / config.json) |
| `GET/POST /api/profile-state` | engine profile, chosen artifact, saved named profiles (profile.json) |
| `GET/POST /api/conversations` | chat conversations + per-conversation params (chats.json) |
| `/api/coder/*` | coder harness: workspace, tree/dirs/read/write/edit/patch, grep/glob, exec + jobs, safe mode, memory, git diff/log |
| `GET /health`, `/v1/*` | SSE-safe proxy to the engine port (injects API key) |

All state-changing endpoints accept only loopback `Host`/`Origin` values (browser
cross-origin calls are limited to the allow-listed Tauri/Vite origins) — see
[Security](#security).

## Prerequisites

- A built **NInfer** engine (`ninfer-serve`) and (for GPU stats) an NVIDIA driver +
  `nvidia-smi`. Point Studio at it via Settings (`ninferPath`, `modelsDir`).
- **Rust** toolchain (stable) and **Node ≥ 22 + pnpm** (only needed to build the web bundle).
- **Tauri 2 system dependencies** on Linux (Debian/Ubuntu):

  ```bash
  sudo apt-get install -y \
    libwebkit2gtk-4.1-dev libgtk-3-dev libjavascriptcoregtk-4.1-dev \
    libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev
  ```

  > On some rolling/derivative distros the WebKit/GLib runtime and `-dev` packages can
  > drift out of sync (a `-dev` package wanting an older runtime). If `apt` refuses with
  > a version-skew error, allow the runtime downgrades:
  > `sudo apt-get install -y --allow-downgrades libwebkit2gtk-4.1-dev …`.
- Optional: the `hf` CLI for in-app model downloads, and `rg` (ripgrep) for the Coder
  repo-map.

## Build & Run

```bash
git clone <this-repo> && cd ninfier-ui
pnpm install && pnpm build          # build the web bundle → apps/web/dist
```

**Desktop app (debug):**

```bash
pnpm desktop:run                   # native WebKitGTK window (debug) on :8787
```

**Desktop app (release binary):**

```bash
pnpm desktop:build                 # cargo build --release (no tray feature)
# or with the tray icon:
pnpm desktop:build:tray            # adds --features tray (needs libayatana-appindicator3-dev)
desktop/target/release/ninfier-studio
```

**Bundled installer / portable image:**

```bash
pnpm desktop:bundle                # pnpm tauri build --features tray --bundles deb appimage
```

Produces `.deb` + `.AppImage` in `desktop/target/release/bundle/`.

**Development modes:**

```bash
pnpm dev            # web dev: Vite :5173 (HMR) + Node sidecar :8787 (browser UI)
pnpm control:run    # headless: Rust control plane only, no window
pnpm desktop:run    # native window + Rust control plane (dist from apps/web/dist)
```

`NINFIER_STUDIO_DATA` overrides the per-user config dir (default
`~/.config/ninfier-studio` on Linux, `AppData/Roaming/ninfier-studio` on Windows) and
`NINFIER_STUDIO_DIST` (default `apps/web/dist`) overrides the dist location.

`start-stack.sh` (dev) boots the sidecar and optionally seeds config + starts the
engine, taking all paths from the environment — `NINFER_DIR`, `MODELS_DIR`,
`CODER_WORKSPACE`, `ARTIFACT`, `ENGINE_PORT`; settings persist in `config.json`
after the first run.

## Packaging & CI Releases

`.github/workflows/release.yml` builds and releases on **ubuntu-24.04** (`.deb` +
`.AppImage`) and **windows-latest** (`.exe`/nsis) — a draft GitHub Release is created
and each platform uploads its artifact into it.

Trigger a release by pushing a version tag:

```bash
git tag v0.2.6 && git push origin v0.2.6
```

(or run the workflow manually from the Actions tab). Windows artifacts are currently
**unsigned** — expect a SmartScreen warning until code-signing is wired in.

## Configuration

Settings, the engine profile, saved profiles, and conversations all live in the
per-user config dir (default `~/.config/ninfier-studio` on Linux,
`AppData/Roaming/ninfier-studio` on Windows; override with `NINFIER_STUDIO_DATA`),
created on first save. Key files:

| File | Meaning |
|---|---|
| `config.json` | app settings — key fields below |
| `profile.json` | engine profile, chosen artifact, and saved named profiles |
| `chats.json` | chat conversations + per-conversation sampling/thinking params |
| `last-start.json` | last engine start record (dirty indicator for the Engine tab) |
| `engine-<port>.log` | tailed engine stdout/stderr (also the source of the VRAM capacity line) |

`config.json` key fields (camelCase as written by the app):

| Field | Default | Meaning |
|---|---|---|
| `ninferPath` | (none — set per machine) | NInfer checkout: `ninfer-serve` binary, CLI, git source |
| `modelsDir` | (none — set per machine) | directory scanned for `*.ninfer` artifacts |
| `enginePort` | `8080` | port the engine / proxy listens on |
| `apiKey` | (empty) | API key injected into proxied `/v1/*` requests |
| `hfCli` | `hf` | Hugging Face CLI binary |
| `hfToken` | (empty) | optional HF token for downloads; redacted to `********` in API responses |
| `buildCommand` | cmake/Ninja one-liner | engine rebuild command (Rebuild engine button) |
| `coderWorkspace` | (empty) | default Coder mode workspace |

## Security

The control plane binds to loopback and validates every request's `Host` and `Origin`
against loopback names and the allow-listed Tauri/Vite origins — a malicious website
can neither call the API cross-origin nor rebind its DNS to `127.0.0.1` to reach it.
Secrets (the HF token) are never returned by the API: clients see only a `********`
mask, and writes of the mask preserve the stored value. Coder file operations are
confined to the configured workspace.

See [SECURITY.md](SECURITY.md) for the vulnerability-reporting policy and the current
dependency/audit status.

## Further reading

- [RESEARCH.md](RESEARCH.md) — stack & reference-project research.
- [DESIGN.md](DESIGN.md) — full architecture, screen specs, option→control mapping,
  and the verification log.
