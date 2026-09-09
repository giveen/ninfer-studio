# NInfer Studio

A from-scratch, **native Linux desktop app** (Tauri 2 / WebKitGTK) for the
[NInfer](/mnt/storage/ninfer) C++/CUDA LLM inference engine. It turns a raw
`ninfer-serve` binary into a product:

- **Engine configuration** — every `ninfer-serve` option as a labeled, documented control:
  context/KV capacity & dtype, concurrency, speculative decoding (MTP/DFlash/DFlash2), vision &
  media budgets, context-cache tiers, sampling defaults, logging — plus one-click **presets**
  (including the published RTX 5090 long-context profile) and a live **generated launch command**.
- **Model management** — scans the models directory for downloaded `.ninfer` artifacts, shows the
  registered five-identity catalog with local/download states, and downloads artifacts from
  Hugging Face via the `hf` CLI.
- **Chat** — streaming chat over the engine's OpenAI-compatible API: reasoning shown in a
  collapsible thinking block, per-message engine metrics (TTFT, prompt/decode tok/s, cached
  tokens, MTP draft acceptance), sampling/thinking overrides per conversation, image/video
  attachments (vision engines), stop button, local conversation history.
- **Engine supervision** — starts/stops `ninfer-serve` from the UI, adopts already-running
  engines (never double-spawns), tails the engine log, and reports GPU state via `nvidia-smi`.

See **[RESEARCH.md](RESEARCH.md)** for the stack research (Tauri 2 + React 19 + Vite 7 +
Tailwind 4 + Radix/Lucide, informed by FreeToken, Jan, Cherry Studio, Cline) and
**[DESIGN.md](DESIGN.md)** for the full architecture, screen specs, and option catalog.

## Layout

```
desktop/         Rust control plane + Tauri 2 desktop shell
  control/       ninfier-control: engine process supervision, model scan, hf downloads,
                 nvidia-smi stats, SSE-safe engine API proxy, static hosting (framework-free)
  app/           ninfier-studio: Tauri 2 window hosting the control plane URL
apps/web         React 19 + Vite + Tailwind 4 frontend (Chat / Engine / Models / Settings)
apps/sidecar     zero-dependency Node 22 dev mode for the same control-plane API
data/            runtime state (config.json, engine-<port>.log) — gitignored
RESEARCH.md      stack & reference-project research
DESIGN.md        architecture, screens, option→control mapping, verification log
```

## Quick start (this machine)

Requirements: a built NInfer (`/mnt/storage/ninfer/build/apps/ninfer-serve`),
RTX 5090 + CUDA 13.1, `hf` CLI on PATH (for downloads), a Rust toolchain, and the
one-time Tauri Linux dependencies (see below). Node ≥ 22 + pnpm are only needed to
build the web bundle.

### 1. One-time system dependencies (Tauri 2 on Linux, WebKitGTK)

```bash
sudo apt install -y libwebkit2gtk-4.1-dev libxdo-dev librsvg2-dev
```

### 2. Build & run the native app

```bash
cd /mnt/storage/Projects/ninfier-ui
pnpm install && pnpm build                 # web bundle → apps/web/dist
pnpm desktop:run                           # native window (debug) — or:
cargo build --release --manifest-path desktop/Cargo.toml -p ninfier-studio
desktop/target/release/ninfier-studio      # native window (release)
```

The app opens a native WebKitGTK window on the same control plane it used to
talk to from a browser (`http://127.0.0.1:8787` — now served by the Rust core,
no Node runtime at all).

1. **Engine tab** — pick an artifact, review the generated command, hit **start engine**
   (or start nothing: if an engine is already serving the port, Studio adopts it as *external*).
2. **Chat tab** — send a message; streaming, thinking, and per-message metrics appear inline.
3. **Models tab** — see what's downloaded; fetch the other four registered artifacts.

Default profile: *Long context MTP3* (240k context, FP8 KV, MTP3 + optimized head, vision,
preserve-thinking — the published 5090 profile in the engine README/`run.txt`).

### Development modes

```bash
pnpm dev            # web dev: Vite :5173 (HMR) + Node sidecar :8787 (browser UI)
pnpm control:run    # headless: Rust control plane only, no window
pnpm desktop:run    # native window + Rust control plane (dist served from apps/web/dist)
```

`NINFIER_STUDIO_DATA` (default `./data`) and `NINFIER_STUDIO_DIST` (default
`apps/web/dist`) override the data/dist locations.

## How the control plane works

The control plane (`desktop/control`, the `ninfier-control` Rust crate; the Node sidecar
`apps/sidecar` implements the same contract for browser dev mode) is the only process that
touches the engine process. In the desktop app it runs inside the Tauri core, so the engine's
parent is the app itself — a single process supervises the engine:

| API | Purpose |
|---|---|
| `GET /api/status` | engine state (incl. adopted external pids), GPU, models, downloads, config |
| `POST /api/engine/start` | profile + artifact → `ninfer-serve` argv (1:1 with the UI's generated command); spawn, health-poll, log capture |
| `POST /api/engine/stop` | SIGTERM the child (8 s grace) or the adopted external pid |
| `POST /api/engine/update` | `{action: "pull" \| "build"}` — `git pull --ff-only` in `repoDir`, or run `buildCommand` (default: NInfer's `cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)`, cores detected at run time); single job, streamed output + exit code |
| `GET /api/logs?n=400` | tail of the spawned engine's log |
| `GET /api/models` | scan `modelsDir` for `*.ninfer` + registered catalog |
| `POST /api/models/download` | `hf download <repo> <file> --local-dir` |
| `GET /api/gpu` / `GET /api/status.gpu` | `nvidia-smi` memory/util/process list |
| `GET/POST /api/config` | app settings (`data/config.json`) |
| `GET /health`, `/v1/*` | SSE-safe proxy to the engine port (injects API key) |

In the production **Tauri 2** build the same responsibilities move into the Rust core
(`plugin-shell` sidecar spawn + Tauri commands); the frontend is unchanged.

## Verified on 2026-09-09

RTX 5090 (32 GiB), driver 610.57, engine built at `/mnt/storage/ninfer/build`:
external-engine adoption → UI stop → UI start (nvfp4, 20 GiB weights in 3.4 s, ready 6.9 s) →
streaming chat with thinking + draft-acceptance metrics → 203-message / 48-tool external agent
request served through the spawned engine. The **native Tauri desktop app** (`ninfier-studio`)
re-ran the full verification in-process: adoption, spawn-argv correctness, failed-spawn reaping
(`failed | engine exited with code 1` → auto re-adoption of the live external engine), SSE
streaming, and a UI-originated thinking response through the Rust control plane.
Details in `DESIGN.md` §5 (verification) and §7 (desktop build notes for this dev-branch distro).
