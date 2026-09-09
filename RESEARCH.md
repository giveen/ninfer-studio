# RESEARCH — NInfer Studio: stack, reference projects, and design assets

Research performed 2026-09-09 for the from-scratch UI of the NInfer LLM inference engine
(`/mnt/storage/ninfer`). Goal: a **Linux-first desktop app** that (a) exposes every engine option
as an easily toggleable/configurable control, (b) shows downloaded models, and (c) provides a
streaming chat window.

## 1. Conclusion (what we built and why)

| Layer | Choice | Why |
|---|---|---|
| App shell (production) | **Tauri 2** (Rust core + system WebKitGTK) | Smallest footprint (~3–15 MB), first-class Linux packaging (.deb/.rpm/AppImage/Flatpak/AUR), native Wayland, built-in child-process supervision for the C++ engine as a **sidecar** — the exact lifecycle our sidecar prototype already implements. |
| Frontend | **React 19 + TypeScript + Vite 7 + Tailwind CSS 4** | The dominant open-source stack for local-LLM clients (Jan, Cherry Studio, Cline, AnythingLLM). Highest UI-polish ceiling; real browser engine ⇒ free markdown/SSE/streaming. |
| Components | **Radix UI primitives** (Switch, Popover, Dialog) + **Lucide** icons + hand-rolled dark design system | Same family Cherry Studio / Cline / shadcn-ui use; small dependency surface, full theming control for a devtool aesthetic. |
| Markdown | **react-markdown + remark-gfm** | Chat rendering with tables/code; matches the ecosystem norm. |
| Control plane | **Zero-dependency Node 22 sidecar** (prototype) → **Tauri Rust core** (production) | FreeToken's core lesson: a deliberately thin, crash-proof supervisor owns the engine lifecycle (start/stop/logs/models/GPU) and proxies the engine's HTTP API. Kept dependency-free so it runs anywhere. |
| Engine interface | OpenAI-compatible `/v1/chat/completions` SSE (reasoning deltas, `timings`, usage) | NInfer already speaks OpenAI/Anthropic/Responses; the UI consumes its documented contract — zero engine changes. |

**Fallback:** Electron + the same frontend (mature, ~100 MB+, `child_process` supervision,
electron-builder packaging). **Pragmatic baseline (already shipped):** the built web app served by
the sidecar at `http://127.0.0.1:8787` — single process, zero framework overhead, usable today.

## 2. Reference projects

### FreeToken (the user's example) — `FlashML-org/FreeToken`

- **What it is:** an "edge-native" MoE serving engine (DeepSeek-V4-Flash / Qwen3.6-35B-A3B class
  models on consumer GPUs) with a three-layer architecture:
  1. **Engine** — `ft serve` (Python/CUDA/C++), OpenAI `/v1/*` + Anthropic `/v1/messages` +
     Responses API, plus `/health`, `/v1/stats`, `/v1/cache/status`, `/v1/cache/rebuild`
     (live pool resize without restart).
  2. **Daemon** — a **deliberately torch-free FastAPI/uvicorn control plane** that owns the
     `ft serve` child's lifecycle (start/stop/switch/logs/metrics) over loopback. Designed so a
     CUDA segfault can never take down the controller.
  3. **Desktop GUI** — proprietary binary, a *thin HTTP client* of the daemon + engine.
- **UI layout (from 16 desktop release notes):** Library (model catalog cards with
  quantizations stacked per card, checkpoint-derived params/quant, resumable real-size download
  progress, local-folder import) · Chat (redesigned composer, timestamps, copy, model-loading
  progress bar, Enter-to-send / Ctrl+Enter newline, jump-to-latest) · Console (launch command +
  streamed engine logs SSE/ANSI-stripped, per-request ↑in/↓out token usage) · Settings (section
  jump menu, proxy, multi-GPU picker, HF token, models dir) · Apps (launch coding agents with
  remembered workdir) · first-launch wizard, system tray, in-app self-update rendering Markdown
  release notes.
- **Config surface exposed:** model/host/port, GPU selection (UUID or index), max running
  requests, output budget, sequence length, prefill chunk, CUDA-graph batch, KV cache & memory
  (`--memory-ratio`, pages/tokens, page size, cache type), MoE offload strategy, quant backend,
  expert-cache sizing, CPU threads; most values auto-resolve from checkpoint + GPU.
- **Patterns we copied into NInfer Studio:**
  - *decoupled, crash-proof control plane* (our sidecar ↔ their daemon);
  - *clean lifecycle API*: start/stop idempotent, status with pid/model/port/uptime,
    logs with replay;
  - *adopt-don't-kill*: if the port already serves an engine, the UI marks it **external** and
    refuses to double-spawn (implemented in the sidecar + status pill);
  - *record crashes, don't blindly restart*;
  - *GPU stats via NVML/nvidia-smi, error instead of fake numbers*;
  - *per-model persisted presets* (our Profiles), *resumable download progress* (our downloads
    panel streams `hf` output);
  - *engine outlives the UI* (external mode).
- **License:** engine Apache-2.0; desktop GUI closed (undiscoverable license) — so its *design
  patterns*, not its code, are the reusable asset.
- Sources: `github.com/FlashML-org/FreeToken` (README, daemon README, `docs/cli.md`, `server/`
  tree), `flashml.ai/changelog/releases.json` (16 releases), `FreeToken-Web` repo (download site
  only).

### Existing local-LLM clients (stack evidence)

| Client | Shell | Frontend / UI libs | Linux shipping |
|---|---|---|---|
| **Jan** (closest analog: local model manager + chat + bundled server) | **Tauri 2** | TS + web UI; server on `localhost:1337` | .deb, AppImage, Flathub |
| **Cherry Studio** | **Electron 41** | **React 19 + Tailwind 4 + Radix + lucide** (shadcn-style), markdown-it/remark/rehype/shiki/katex/mermaid/tiptap | AppImage, .deb, .rpm, Flatpak (x64+arm64) |
| **Cline** | VS Code ext + **Tauri** desktop | **Next.js + Tailwind 4 + Radix** (shadcn-style), Bun sidecar | macOS/Win desktop; Linux via ext/CLI |
| **AnythingLLM** | Electron (out-of-tree) | React + Vite + Tailwind + **Tremor** (Radix-based) + Phosphor icons | AppImage (x64/arm64), Docker |
| **GPT4All** | **Qt 6 / QML** (native) | Qt Widgets/Quick | .run installer, Flathub |
| **LM Studio** | closed (AppImage on Linux) | closed | AppImage |
| **Open WebUI** | web app | SvelteKit + Tailwind | pip/Docker (web-first) |
| **Msty** | closed | AppImage on Linux | AppImage |

Takeaways:
- The dominant open pattern is **Tauri/Electron + React + Tailwind + Radix/shadcn** — exactly our
  frontend choice.
- **Jan** (the closest product analog) chose **Tauri 2** for a Linux-first local-model client.
- The only fully-native client (GPT4All, Qt/QML) is the least chat-polished of the group — native
  toolkits are viable but slower for this UI category.
- Ollama ships **no official Linux GUI** (CLI/daemon only) — a caution that a pure server leaves
  Linux GUI users to third parties; we ship a first-class GUI.
- Sources: each repo's `package.json`/releases, Tauri & electron-builder docs (URLs in the
  research transcript).

## 3. Framework comparison (summary)

| Option | Linux fit | Solo dev velocity | Polish ceiling | Spawn child server | Packaging | Bundle |
|---|---|---|---|---|---|---|
| **Tauri 2** | ★★★★★ (WebKitGTK, Wayland) | ★★★☆ (thin Rust glue) | ★★★★★ | ★★★★★ (plugin-shell + sidecar) | .deb/.rpm/AppImage/Flatpak/Snap/AUR | ~3–15 MB |
| Electron | ★★★★☆ | ★★★★★ | ★★★★★ | ★★★★★ (`child_process`) | electron-builder all targets | ~80–150 MB |
| Neutralino / Wails | ★★★★ | ★★★★ | ★★★★ | ★★★–★★★★★ | manual wrap | 2–30 MB |
| Qt / GTK4+libadwaita | ★★★★★ (native look) | ★★☆ | ★★★★ (unless embedding WebKit) | ★★★★★ (native) | native | 15–40 MB |
| Pure local web + `.desktop` | ★★★★★ | ★★★★★ | ★★★★ | ★★★★ (separate process) | trivial | ≈ server size |

Local machine check (2026-09-09): `node 22.23`, `pnpm 11`, `rustc 1.97`, **`libwebkit2gtk-4.1`
installed** — Tauri can build here today; the Node sidecar runs today.

## 4. Design assets used

- **Icons:** Lucide (`lucide-react`) — the de-facto standard in the Cherry/Cline/Jan family.
- **Primitives:** Radix UI (Switch, Popover, Dialog) — unstyled, fully themeable.
- **Theme:** hand-rolled dark devtool system (Tailwind v4 `@theme`): near-black `#0a0c10` canvas,
  `#10141b` panels, 1px `rgba(255,255,255,.08)` borders, single **lime accent `#b7f04a`** for
  primary actions/engine-running state, JetBrains Mono for all metrics/commands/logs, Inter
  (bundled via `@fontsource`, no network) for UI text. Semantic tones: ok `#59d499`, warn
  `#e8b34b`, danger `#f0625f`, info `#5cb2f0`.
- **Markdown:** react-markdown + remark-gfm, custom `.markdown` styles for chat (tables, code
  fences, blockquotes).
- **Reference aesthetics:** FreeToken desktop (dark, catalog cards, console log panel), Cherry
  Studio (settings density, Radix controls), Ollama/LM Studio (status pills, model lists).

## 5. Open questions / next research

- System tray + single-instance behavior in the Tauri core (Tauri docs; ~1 day work).
- `shiki` for syntax highlighting in chat code fences (drop-in, matches ecosystem).
- Engine-metrics screen: NInfer exposes `--log-stats-interval-ms` throughput records on stderr and
  a `--request-log-jsonl` schema v20 — a small parser could feed a live throughput/token chart.
- Multi-GPU: NInfer is single-GPU by design; the UI surfaces `--device` and GPU stats only.
