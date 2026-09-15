//! Server-side agent loop — the webview's tool-call loop, moved into the
//! control plane.
//!
//! Architecture (opencode-style: the loop lives in the server, clients
//! attach). Before this module, `runToolLoop` ran inside the webview:
//! closing the window killed the run, and no second client could watch or
//! steer it. Now:
//!
//!   * `POST /api/agent/runs` starts a **run** — a tokio task in this
//!     process that streams turns from the engine (the same port routing
//!     and usage tap the `/v1/*` proxy uses), recovers markup tool calls,
//!     and dispatches tools **in-process** through the very same handlers
//!     the HTTP routes use (`coder::fs`, `coder::exec`, `mcp`, …), so
//!     permissions, safe mode, sandboxing, and approval tickets are
//!     enforced by the server, not by the client's goodwill.
//!   * `ask`-tier tools **pause the run** (`status: awaiting_approval`)
//!     and emit `approval_requested`. Any attached client can show the
//!     dialog; approval mints the usual one-shot token
//!     (`/api/coder/perms/approve`) which the run injects and
//!     `enforce_perm` consumes — the existing security model, unchanged.
//!   * `GET /api/agent/runs/{id}/events` is an SSE stream (broadcast
//!     channel): a client can attach at any point, get a `state` snapshot
//!     first, then live `delta`/`appended`/`tool_*`/… events. Multiple
//!     clients attach concurrently; a run keeps going with zero clients
//!     attached.
//!
//! File split:
//!   run.rs        — run registry, status/snapshot types, HTTP endpoints, SSE
//!   engine_loop.rs— the loop: stream a turn, markup recovery, obs packing,
//!                   bounded recursion (the server port of agentLoop.ts)
//!   tools.rs      — in-process tool dispatch + permission/approval preflight

pub mod bash_guard;
pub mod child_run;
pub mod engine_loop;
pub mod gates;
pub mod run;
pub mod tools;
