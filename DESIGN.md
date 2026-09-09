# DESIGN — NInfer Studio

A from-scratch, Linux-first desktop UI for the **NInfer** C++/CUDA inference engine
(the NInfer source checkout). Three product goals:

1. **Every engine option is visible and toggleable** — the whole `ninfer-serve` option surface,
   grouped, documented per control, with presets and a live generated launch command.
2. **Models are visible** — downloaded `.ninfer` artifacts, the registered catalog, and one-click
   Hugging Face downloads.
3. **Chat is first-class** — a streaming chat window with reasoning display, per-message engine
   metrics, sampling overrides, and image/video attachments.

## 1. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  UI (React 19 + Vite + Tailwind 4 + Radix + Lucide)                │
│  ┌──────────┬──────────────────┬───────────┬────────────────────┐  │
│  │ Chat     │ Engine           │ Models    │ Settings           │  │
│  └──────────┴──────────────────┴───────────┴────────────────────┘  │
│         │ fetch /api/*  +  fetch /v1/chat/completions (SSE)        │
└─────────┼──────────────────────────────────────────────────────────┘
          │  loopback
┌─────────▼──────────────────────────────────────────────────────────┐
│  CONTROL PLANE — Rust `ninfier-control` crate (axum + tokio)       │
│  inside the Tauri 2 desktop app (WebKitGTK window)                 │
│  (dev-mode equivalent: zero-dep Node 22 sidecar, same API)        │
│  • engine lifecycle: spawn / poll /health / SIGTERM / adopt        │
│  • profile → CLI args (build_serve_args, 1:1 with ninfer-serve)    │
│  • models dir scan, hf download supervisor, nvidia-smi stats       │
│  • engine log tail, SSE-safe API proxy                             │
│  • static hosting of the built UI (single process, no Node)        │
└─────────┼──────────────────────────────────────────────────────────┘
          │ spawn + stdout/stderr pipe · HTTP :8080
┌─────────▼──────────────────────────────────────────────────────────┐
│  NInfer engine (ninfer-serve, C++/CUDA, RTX 5090 / sm_120a)        │
│  OpenAI Chat Completions + Responses + Anthropic Messages + /health│
│  one resident .ninfer artifact · 1–8 lanes · KV cache tiers        │
└────────────────────────────────────────────────────────────────────┘
```

**Why this shape** (research-backed, see `RESEARCH.md`):
- The engine is a specialized single-GPU C++/CUDA binary — the UI must never import or
  interpret model code. It talks **only** the engine's documented HTTP contract.
- FreeToken's core lesson: keep a **thin, crash-proof supervisor** between UI and engine. A
  CUDA fault in the engine must not take down the control plane. The supervisor is now the
  Rust `ninfier-control` crate running inside the Tauri 2 desktop core: the engine's parent
  process is the app itself, so a native window + a single Rust process supervise everything.
  The Node sidecar (`apps/sidecar`) implements the identical API contract for browser dev
  mode with HMR. The UI code is byte-identical in both because it only speaks the loopback
  HTTP contract.
- The proxy (`/v1/*`, `/health` → engine port) keeps the UI on a single origin (no CORS),
  injects the configured API key, and is SSE-safe (chunks piped as they arrive).

**Key lifecycle behaviors** (all implemented and verified):
- **adopt-don't-kill**: if the configured port already serves `/health: ok`, the sidecar marks
  the engine **external** (scans `/proc` for the `ninfer-serve` pid) and never double-spawns.
  The UI shows `external · not spawned by studio` and can still SIGTERM it.
- **start**: builds args from the profile, spawns with cwd = engine dir, appends
  stdout+stderr to `data/engine-<port>.log`, polls `/health` every 2 s (3-min deadline),
  records fail reasons (e.g. VRAM shortfall) from the log.
- **stop**: SIGTERM the child (8 s grace → SIGKILL); for external engines SIGTERM the discovered
  pid. Crashes are recorded with a log pointer, not auto-restarted (FreeToken policy).
- **native desktop shell**: `desktop/app` (Tauri 2, WebKitGTK) opens a window pointed at
  `http://127.0.0.1:8787`; the control plane binds that port inside the app's own tokio
  runtime before the window loads (setup hook with a readiness channel), then serves
  `apps/web/dist` (SPA fallback). One native process hosts UI + control plane + engine parent.
- **production hosting**: `pnpm build` → the app serves `apps/web/dist` at `:8787`;
  dev uses Vite `:5173` with proxies (browser mode) or `pnpm control:start` (headless Rust
  control plane, no window).

## 2. Screens

### 2.1 Chat (default)

- **Left rail**: conversation list (persisted in `localStorage`, newest first, title = first user
  line, model + message count, delete).
- **Header**: model select (the engine's public `model_id`), engine-ready indicator, active-param
  badges (thinking mode/effort, max tokens, greedy).
- **Messages**:
  - user bubble (right) with attachment chips;
  - assistant turn (left): collapsible **thinking** block (raw `reasoning_content`, accent icon),
    markdown body (GFM), streaming caret while in flight;
  - **meta footer per message** parsed from the engine's `timings` + `usage`: finish reason,
    TTFT, prompt tok/s, decode tok/s, cached tokens (prefix reuse), in/out tokens, thinking
    tokens, speculative `draft accepted/total (%)`.
- **Composer**: auto-grow textarea (Enter send / Shift+Enter newline), image/video attachment
  (→ base64 data-URI parts; requires engine `--vision`), stop button (AbortController) while
  streaming, and a **params popover**: thinking on/off, reasoning effort
  (template default/low/medium/xhigh), max output tokens, temperature, top-p, top-k, min-p,
  presence/frequency penalties, seed, greedy, system prompt, preserve-thinking.
- **Request mapping** (OpenAI-compatible): `enable_thinking` + `reasoning_effort` derived from
  one intent (contradictory pairs are rejected by the engine, so the UI never sends them);
  `stream_options.include_usage`; thinking history replayed via `reasoning_content`;
  media as `image_url` / `video_url` (NInfer extension) parts.
- **Offline banner**: if the engine is down, chat shows a warning with a jump-to-Engine action
  instead of failing silently.

### 2.2 Engine

Top: **status row** — engine state (stopped/starting/running/stopping/failed/external), loaded
model + uptime + port, GPU memory bar + utilization + process list, Start/Stop action.
Fail reasons surface inline (e.g. "weights require 18 GiB, only 3 GiB free" from the engine's own
FATAL line).

**Generated launch command** card: exactly the argv passed to `ninfer-serve` (flags omitted when
unset → executable defaults), copy button, "long-context preset" shortcut.

**Presets** (one-click, replace the profile, review-before-start):
| Preset | Purpose |
|---|---|
| Default | executable defaults (bf16 KV, no spec, C=1, 8k ctx) |
| **Long context MTP3** | the published RTX 5090 profile: 240k ctx, FP8 KV, C=2, 2 dev + 8 host state slots, 8 GiB host KV, MTP3 + optimized head, vision, preserve-thinking |
| Chat MTP3 | 32k ctx, auto KV, MTP3, C=2 |
| Vision multimodal | 81,920 ctx, vision + media budgets, MTP3 |
| Max concurrency (C=8) | 8 lanes + matching state slots for aggregate decode |
| 35B-A3B DFlash / 3.8-27B DFlash2 | the per-architecture speculative backends (7 drafts) |

**Option sections** (every control carries a tooltip quoting the engine docs; every omitted
value means "engine executable default"):
- **Artifact & network** — artifact pick (from Models scan), `--model-id`, `--api-key`,
  `--host`, `--port`, `--device`.
- **Context & memory** — `--max-context`, `--kv-capacity` (follow-ctx / **auto** / fixed),
  `--prefill-chunk`, `--default-max-tokens`, `--default-thinking-budget`.
- **Scheduling** — `--max-concurrency` (1–8), `--max-pending-requests`, `--pending-timeout-ms`.
- **KV cache & context cache** — `--kv-dtype` (bf16/int8/fp8/nvfp4/k8v4 segmented),
  `--no-prefix-reuse`, `--no-cuda-graph`, device/host state slots, `--host-kv-mib`,
  max private continuations / shared prefixes / long anchors (auto-disabled with no-prefix-reuse).
- **Speculative decoding** — `--spec` (off/MTP/DFlash/DFlash2), `--draft-tokens`
  (range-aware: 1–5 for MTP, 1–15 otherwise), `--lm-head-draft`; per-artifact capability check
  (mtp ✓ / dflash ✗ / dflash2 ✓ for a 27B artifact) computed from the catalog.
- **Vision & media** — `--vision` (residency frozen at startup), `--media-cache-mib`,
  `--media-live-mib`, `--media-preprocess-threads`, `--max-request-mib`.
- **Sampling defaults** — `--no-thinking`, `--preserve-thinking`, `--greedy`,
  `--temperature/--top-p/--top-k/--min-p/--presence-penalty/--frequency-penalty/--seed`
  (process-level; request fields override, documented in the tooltip).
- **Logging, storage & misc** — `--log-level`, `--log-stats-interval-ms`,
  `--request-log-jsonl`, `--response-store-max-records/-mib`, `--context-cost-presets`, `--cors`.

**Profiles**: save/load named profiles (browser-persisted, 1:1 with flags).
**Downloads**: HF repo + file → `hf download … --local-dir <modelsDir>` with live output tail.
**Engine log**: live tail (2 s poll, auto-stick scroll, severity coloring) of the spawned
engine's stderr — the startup sequence (weights → host state/KV pinning → CUDA graphs →
`engine ready` → `listening`) is readable in-app.

### 2.3 Models

- **Downloaded artifacts** cards: filename, model/weights badges, size, mtime, public id,
  speculation support + vision, HF source link, "loaded" highlight when the running engine uses
  it, spec support line; unregistered files flagged.
- **Registered catalog** table (the five artifact identities): local/downloaded/download
  states with live download progress tail, launch/download actions, per-row spec support
  (mtp 1–5; dflash 1–15 on 35B-A3B; dflash2 1–15 on 3.8-27B with companion weights).
- **Models directory** card (path + copy), with the validation caveat (partial artifacts fail
  readiness).

### 2.4 Settings

Engine paths (`ninfer-serve`, `ninfer` CLI, models dir, `hf`), default port, API key (Studio
injects it on proxied requests), About (architecture note). Persisted to
`data/config.json` via the sidecar.

## 3. Option catalog → control mapping (serve surface)

| Flag | Control | Notes |
|---|---|---|
| `--host/--port/--api-key/--model-id` | text/number | key masked in generated command |
| `--max-context`, `--kv-capacity` | number + 3-state segmented | auto/follow/fixed |
| `--prefill-chunk` | number (multiple of 128) | |
| `--max-concurrency` (1–8), `--max-pending-requests`, `--pending-timeout-ms` | number | |
| `--kv-dtype` | segmented (5) | bf16/int8/fp8/nvfp4/k8v4 |
| `--spec` + `--draft-tokens` + `--lm-head-draft` | segmented + number (range-aware) + toggle | capability-checked per artifact |
| `--vision`, `--media-cache-mib`, `--media-live-mib`, `--media-preprocess-threads`, `--max-request-mib` | toggle + numbers | |
| `--no-cuda-graph`, `--no-prefix-reuse`, `--no-thinking`, `--preserve-thinking`, `--greedy`, `--cors` | toggles | |
| `--device-state-slots`, `--host-state-slots`, `--host-kv-mib`, `--max-private-continuations`, `--max-shared-prefixes`, `--max-long-anchors-per-continuation` | numbers | context-cache tier; disabled under no-prefix-reuse |
| `--default-max-tokens`, `--default-thinking-budget` | numbers | |
| `--temperature/--top-p/--top-k/--min-p/--presence-penalty/--frequency-penalty/--seed` | numbers | process-level defaults |
| `--log-level`, `--log-stats-interval-ms`, `--request-log-jsonl`, `--response-store-max-records/-mib`, `--context-cost-presets` | select + number + text | |

Unset ⇒ flag omitted ⇒ engine executable default (documented per control). The same
profile→argv function drives the generated command **and** the real spawn, so what you review is
what runs.

## 4. Data & state

- `data/config.json` — app settings (control-plane-owned; `NINFIER_STUDIO_DATA` overrides the
  data dir, `NINFIER_STUDIO_DIST` overrides the UI dist dir).
- `data/engine-<port>.log` — spawned engine stdout/stderr (appended, tailed by the UI).
- `localStorage` — conversations, chat params, engine profile, saved profiles, selected artifact
  (per-browser; a Tauri build can move these to the Rust store).
- Engine-side state (KV tiers, checkpoints, response store) is engine-owned; the UI never writes
  model state.

## 5. Verification performed (2026-09-09, RTX 5090, driver 610.57)

- Sidecar adopted an externally running engine (pid via `/proc`, model via `/v1/models`,
  GPU stats) — status pill `external`, no double-spawn.
- Proxied non-streaming chat: 112 ms round trip; `timings` present
  (prompt 275.9 tok/s, decode 61 tok/s, MTP draft 3/6 accepted).
- UI chat (SSE): streamed a thinking response — reasoning captured separately, markdown rendered,
  meta footer TTFT 583 ms / prompt 664 tok/s / decode 96.3 tok/s / 61 thinking tokens /
  draft 83/171 (49%), usage incl. cached tokens.
- Lifecycle: UI **stop** terminated the external pid; a subsequent UI **start** spawned
  `ninfer-serve` (nvfp4 artifact) — weights 20 GiB in 3.4 s (5.84 GiB/s), ready in 6.9 s total,
  log captured in-app; a real 203-message / 48-tool agent request then served through it.
- Models screen: two local artifacts (17.0 + 20.0 GiB) with catalog states; Settings/Engine
  screens render the full catalog of controls; production `tsc + vite` build passing.
- Production single-process mode: sidecar restart re-adopted the running engine from `/proc`
  (crash-safe), served the built UI at `:8787`, and a streamed thinking response (haiku,
  422 thinking tokens, 63% draft acceptance, TTFT 3.03 s under a concurrent user workload)
  completed through the proxied SSE path.
- **Engine source updates (git pull + rebuild)**: the Engine tab's *Engine source* section drives
  `POST /api/engine/update` (`{action: "pull" | "build"}`). Pull runs `git pull --ff-only` in the
  configured `repoDir` (validated as a git work tree first); build runs the configured
  `buildCommand` (NInfer's documented default:
  `cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)`,
  with `-j$(nproc)` expanded at run time to the machine's core count). One job at a time; stdout +
  stderr are pumped into a ring buffer (last ~2000 lines) surfaced in `status.update` and rendered
  in a live log pane with a running/done/failed badge. Verified end-to-end through the native
  app and the UI: a real `git pull` (exit 0, "Already up to date.") and an incremental build
  (exit 0, "ninja: no work to do.") both streamed their output and set the success badge. A
  successful build shows the hint to stop + start the engine to load the new binary.
- **Native desktop (Tauri 2)**: the Rust `ninfier-control` crate (axum + tokio) implements the
  same API contract, now running inside the `ninfier-studio` Tauri window (single process;
  window hosts `http://127.0.0.1:8787`, control plane bound in the setup hook before load).
  Verified through the live app: engine adoption (`external`, pid 61867), model scan, GPU
  stats, log tail, camelCase config persistence, static UI hosting (index + 504 kB JS bundle),
  a full SSE chat stream with `timings` + `[DONE]` through the Rust proxy, and a UI-originated
  streamed thinking response (TTFT 3.91 s under a concurrent user workload, decode 138.5 tok/s,
  58% draft acceptance).
- **Spawn path verified in Rust**: a start request with a camelCase profile produced the exact
  expected argv (`--max-context 240000 --kv-capacity 240000 --max-concurrency 2 --kv-dtype fp8
  --spec mtp --draft-tokens 3 --lm-head-draft --vision --device-state-slots 2
  --host-state-slots 8 --host-kv-mib 8192 --preserve-thinking`); the intentional VRAM-failure
  spawn (port 9091) was reaped to `failed | engine exited with code 1` within seconds, the
  zombie cleared, and the engine slot auto-restored to the external engine on the configured
  port — the user's running engine was untouched throughout (verified via `/proc` + nvidia-smi).

## 6. Roadmap (post-prototype)

1. Tauri 2 shell — **done** (window + Rust control plane in one process). Remaining packaging:
   system tray + single-instance lock, `.deb`/AppImage/Flatpak bundles, icons.
2. `shiki` code highlighting + KaTeX in chat.
3. Metrics screen: parse `--log-stats-interval-ms` records / `--request-log-jsonl` (schema v20)
   into live throughput & KV-utilization charts.
4. Responses-API-based tool calls in chat (engine parses; client executes).
5. Per-model parameter presets persisted per artifact (FreeToken "Console restores each model's
   last applied config").
6. First-run wizard (paths, GPU check via nvidia-smi, model download).

## 7. Desktop build notes (Ubuntu 26.10 dev branch, 2026-09-09)

Tauri 2 on Linux needs the WebKitGTK dev chain. On this dev-branch machine the archive has a
package skew: point-updated runtime libs (`libmount1 2.41.3-3ubuntu2.2`, `libbz2-1.0
1.0.8-6ubuntu0.1`, …) vs `-dev` packages pinning the older exact base versions — so neither
`apt` (new solver) nor `apt-get --allow-downgrades` can resolve
`libwebkit2gtk-4.1-dev + libxdo-dev + librsvg2-dev`.

Workaround used (no system-library downgrades):
1. `apt-get download` the ~59 dev packages (headers + `.pc` files only) — see
   `desktop/webkit-dev-pkgs/` for the exact set.
2. `sudo dpkg -i --force-depends *.deb` — unsatisfied exact-version pins on the (already
   installed, newer) runtime libs are harmless for compiling against the headers.

Verified working set: `libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev
libgtk-3-dev libglib2.0-dev(-bin) libgio-2.0-dev(-bin) libpango1.0-dev libcairo2-dev
libgdk-pixbuf-2.0-dev librsvg2-dev libmount-dev libblkid-dev libbz2-dev libatk1.0-dev
libatk-bridge2.0-dev libatspi2.0-dev libxdo-dev libxdo3 libx{composite,cursor,damage,ext,fixes,
i,inerama,kbcommon,randr,render,ft,res,tst}-dev libxcb-{render0,shm0}-dev libfontconfig-dev
libfreetype-dev libpng-dev libpixman-1-dev libfribidi-dev libthai-dev libdatrie-dev
libharfbuzz-dev libgraphite2-dev libselinux-dev libsepol-dev libsysprof-capture-4-dev
libwayland-dev libseccomp-dev lib{epoxy,egl,gl,gles,glvnd,glvnd-core,glx,opengl}-dev
libpcre2-dev libpcre2-posix3 libglycin-2-dev` (gdk-pixbuf 2.42+ requires the new `glycin-2`
loader API — easy to miss).

The `gir1.2-*-dev` packages have no candidates in this archive and are not needed
(pkg-config only sees `.pc` files). Tauri 2's default features do not include `global-shortcut`,
so `xdo.pc` is not required (the dist's `libxdo-dev` ships only the header anyway).
