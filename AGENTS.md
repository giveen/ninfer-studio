# NInfier UI Agent Instructions

NInfier UI is a monorepo containing a native Linux desktop UI (Tauri 2 / Rust) and streaming web interface (React 19 / TypeScript) for the NInfer local LLM inference engine.

## Instruction Precedence

Apply all relevant instruction files. If instructions conflict, resolve them in this order:

1. Explicit human instructions in the current prompt
2. Subsystem nested `AGENTS.md` (`apps/web/AGENTS.md` or `desktop/AGENTS.md`)
3. This root `AGENTS.md` file

## Repository Map

- `apps/web/` - Web & desktop frontend app (React 19, Vite, Vitest, Playwright, Tailwind CSS v4).
- `desktop/` - Cargo workspace containing Rust crates:
  - `desktop/app/` - Tauri 2 desktop application (`ninfier-studio`).
  - `desktop/control/` - Local engine control daemon (`ninfier-control`).
- `data/` - Development runtime data directory for NInfer engine.
- `skills/` - Custom repository skills (e.g., `skills/linus-torvalds/`).

## Working Style & Core Principles

- Treat codebase inspection and question-answering tasks as read-only.
- Make focused, reviewable changes; avoid unrequested refactoring or style churn.
- Use the simplest design that solves the problem without speculative machinery.
- Prefer existing APIs, utilities, scripts, and conventions in the codebase.
- Before declaring a feature complete, check both the Web UI layer and Rust control service layers if touched.

## Single Source of Truth

Avoid duplicating raw environment variables or inline scripts in prose. Refer to the canonical scripts in [package.json](file:///mnt/storage/Projects/ninfier-ui/package.json) and workspace configurations.

## Verification Matrix

Use the narrowest validation command that covers your changes:

| Change Category | Validation Command | Description |
| :--- | :--- | :--- |
| Web UI / Frontend | `pnpm --filter @ninfier/web test` | Runs Vitest unit tests |
| TS Types | `pnpm --filter @ninfier/web typecheck` | Runs TypeScript type checking |
| Rust Control Service | `cargo check --manifest-path desktop/Cargo.toml -p ninfier-control` | Checks control service Rust code |
| Desktop App Rust | `cargo check --manifest-path desktop/Cargo.toml -p ninfier-studio` | Checks Tauri desktop Rust code |
| Desktop & Control Run | `pnpm control:build && pnpm desktop:build` | Validates full desktop build pipeline |
| End-to-End Tests | `pnpm --filter @ninfier/web test:e2e` | Runs Playwright browser/E2E test suite |

## Hard Prohibitions

- **NEVER** run broad git staging operations like `git add .` or `git add -A`. Stage specific, explicit file paths.
- **NEVER** run destructive git commands (`git reset --hard`, `git clean -fd`, `git checkout .`) that could erase uncommitted work.
- **NEVER** perform blanket dependency upgrades (`cargo update` without `--precise`, or unpinned `pnpm update`).
- **NEVER** write or clear runtime engine files outside `NINFIER_STUDIO_DATA` or designated `$PWD/data`.
- **NEVER** bypass error handling in IPC channels between Tauri Rust host and the Web UI.
