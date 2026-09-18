//! Server-side agent loop — the webview's tool-call loop, moved into the
//! control plane server.
//!
//! Architecture (opencode-style: the loop lives in the server, clients attach).
//! Historically, tool loops ran inside the client webview (`apps/web/src/lib/agentLoop.ts`
//! and `useCoderAgentLoop.ts`): closing the window killed the run, and no second
//! client could watch or steer it. Now:
//!
//!   * `POST /api/agent/runs` starts a **run** — a tokio task in this process
//!     that streams turns from the engine (using the same port routing and
//!     usage tap as the `/v1/*` proxy), recovers markup tool calls, and
//!     dispatches tools **in-process** through the very same handlers the HTTP
//!     routes use (`coder::fs`, `coder::exec`, `mcp`, …), so permissions, safe
//!     mode, sandboxing, and approval tickets are enforced by the server, not
//!     by the client's goodwill.
//!   * `ask`-tier tools **pause the run** (`status: awaiting_approval`) and
//!     emit `approval_requested`. Any attached client can show the dialog;
//!     approval mints a one-shot token (`/api/coder/perms/approve`) which the
//!     run injects and `enforce_perm` consumes — maintaining the client security
//!     contract server-side.
//!   * `GET /api/agent/runs/{id}/events` is an SSE stream (broadcast channel):
//!     a client can attach at any point, receive a `state` snapshot first, then
//!     live `delta`/`appended`/`tool_*` events. Multiple clients attach
//!     concurrently; a run keeps going even if all clients detach.
//!
//! Architecture Caveat:
//!   Dispatch is in-process, but the coder/tool path resolves permissions against
//!   a client-minted token (`approvalToken`) and an explicitly-set workspace scope
//!   (`inject_scope`). This is why a chat-scope run can reach tools like git with no
//!   workspace attached unless scope is explicitly injected.
//!
//! One file per concern:
//!   bash_guard.rs  — fast read-only inspection heuristics and flag deny-lists
//!                    (`is_read_only_command`, mirroring `apps/web/src/lib/coderTools.ts`)
//!   child_run.rs   — subagent spawning, working tree diffing, step budget enforcement,
//!                    and critic review loop
//!   engine_loop.rs — core agent loop: SSE turn streaming, markup tool recovery,
//!                    observation window packing, and bounded turn recursion (server port of `apps/web/src/lib/agentLoop.ts`)
//!   gates.rs       — HITL approval, user question (`ask_user`), risky command, and git commit gate waiters
//!   run.rs         — run registry, status/snapshot types, HTTP route handlers, and SSE event broadcasting
//!   tools.rs       — in-process tool dispatch table, prompt system definitions (`WORKER_SYSTEM`, `CRITIC_SYSTEM`),
//!                    and permission/approval preflight (`inject_scope`)
//!
//! System Invariants (MUST be preserved across all module edits):
//!   1. Model Feedback Roles: `build_request` drops in-transcript `role: "system"`
//!      messages on subsequent turns. All model feedback (dropped tool notices,
//!      critic reviews) MUST be emitted with `role: "user"`.
//!   2. Terminal State Isolation: Gate/approval resolution handlers (`resolve_approval`,
//!      `gate_decide`, `answer`, `hook_decision`) MUST NEVER transition a terminal run
//!      (`Completed`, `Failed`, `Stopped`, `Error`) back to `Running`.
//!   3. Subagent Contract Parity: `spawn_child` / subagent dispatch MUST return a consistent
//!      JSON payload (`{ "ok": bool, "summary": String, ... }` or `{ "error": String, "ok": false }`)
//!      and MUST NOT swallow errors as `ok: true`.
//!   4. Inspection Heuristic Authority: `bash_guard` is a fast preflight inspection heuristic.
//!      The OS/sandbox environment remains the ultimate authority for execution security.
//!   5. Scope & Permission Isolation: In-process tool dispatch enforces permissions against
//!      a client-minted approval token and an explicitly set workspace scope (`inject_scope`);
//!      unscoped runs must not mutate global or unconfigured workspace resources.
//!   6. Client-Server Feature Parity: `bash_guard`, `RISKY_PATTERNS`, `is_git_commit_command`,
//!      and `WORKER_SYSTEM` / `CRITIC_SYSTEM` mirror TypeScript implementations in
//!      `apps/web/src/lib/coderTools.ts` and `apps/web/src/lib/coderPrompts.ts`. Unit test
//!      suites (`bash_guard::tests`, `gates::tests`, `tools::tests`) pin these implementations
//!      to maintain strict client-server parity.

pub mod bash_guard;
pub mod child_run;
pub mod engine_loop;
pub mod gates;
pub mod run;
pub mod tools;
