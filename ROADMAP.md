# ROADMAP — NInfer Studio

This document outlines planned improvements, upcoming features, and architectural enhancements for NInfer Studio.

---

## 1. Agent Engine & MCP Optimizations

### 1.1 Calibrated Tool Selection & Dynamic Schema Pruning (Rust-Native `mcp.rs` / `engine_loop.rs`)

* **Background & Goal**: When multiple MCP servers (e.g. GitHub, Postgres, Slack, Jira) are connected, the tool catalog can expand to 50–100+ schemas. Injecting all schemas into every prompt step consumes significant context tokens and leads to distractor confusion (tool-calling hallucinations), especially on local or smaller models.
* **Proposed Implementation**:
  * **Core Tool Safeguard**: Keep core system tools (`read`, `write`, `edit`, `grep`, `glob`, `bash`) permanently active in the system prompt.
  * **Dynamic MCP Schema Pruning**: When total available tools exceed a configurable threshold (e.g., `total_tools > 30`), execute a lightweight Rust-native similarity search in [`mcp.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/mcp.rs) to rank and select the top-$K$ candidate tool schemas for the active turn before building the API payload in [`engine_loop.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/agent/engine_loop.rs).
  * **Fast-Path Direct Dispatch**: Implement deterministic pattern matching for unambiguous inspection calls (e.g., `read ./package.json` or `git status`), dispatching them directly in `< 15ms` without an LLM round-trip.

### 1.2 Multi-Agent Prefix KV-Cache Optimization (`child_run.rs`)

* **Background & Goal**: Concurrent subagent loops (e.g. Scout or delegate loops in [`child_run.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/agent/child_run.rs)) often evaluate overlapping system prompts and codebase state against local inference engines (NInfer C++, Ollama, Ferrum).
* **Proposed Implementation**: Align system prompt and tool definitions across parent and child runs to maximize KV-cache prefix hits on local model servers, drastically reducing prefill latency for parallel subagents.

### 1.3 Session Trajectory Snapshot & Instant Resumption

* **Background & Goal**: Long-running agent runs can be interrupted by crashes, daemon restarts, or user pauses.
* **Proposed Implementation**: Implement structured trajectory snapshots and checkpointing, allowing interrupted runs to be instantly re-hydrated and resumed (`ninfer resume <run_id>`).

### 1.4 Tree-Sitter Symbol Resolution & Call Graph Engine ([`search.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/coder/search.rs))

* **Background & Goal**: Current code search in [`search.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/coder/search.rs) relies on regex heuristics (`SEARCH_SYMBOL_RE`). Regex matching cannot resolve exact call chains or distinguish between method invocations, string literals, and comments.
* **Proposed Implementation**: Upgrade from regex search to a Tree-sitter AST compiler index in Rust, introducing deterministic graph tools:
  * `get_callers`: Retrieve exact call sites reaching a function across the codebase.
  * `call_tree` / `trace_path`: Trace transitive call chains connecting functions A and B.
  * `backflow` / `forwardflow`: Track variable value origins and return propagation without reading full raw source files.

### 1.5 Pre-Edit Blast Radius & AST-Gated Rollbacks

* **Background & Goal**: Edits can break dependent modules or produce syntax errors that consume multiple turns to fix manually.
* **Proposed Implementation**:
  * **Blast Radius Calculation**: Prior to applying edits in [`tools.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/agent/tools.rs), inspect the AST call graph to determine downstream affected files and automatically select relevant unit tests for post-edit verification.
  * **AST Syntax-Gated Rollback**: Verify AST syntax validity immediately after applying a file diff; if syntax parsing fails, automatically roll back via index snapshot reloads without spending LLM generation tokens.

### 1.6 Historical Context Curation (`engine_loop.rs`)

* **Background & Goal**: Multi-turn sessions accumulate heavy file-reading outputs (`read`, `grep`, `git_diff`) across earlier turns, filling context memory.
* **Proposed Implementation**: Implement context self-curation in [`engine_loop.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/agent/engine_loop.rs). Older completed tool results (>5 turns back) are automatically trimmed to their first 15–20 lines while preserving turn message pairing, keeping context lightweight without breaking OpenRouter/OpenAI schema requirements.

### 1.7 Hash-Anchored Safe Edits & Conflict Detection ([`fs.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/coder/fs.rs))

* **Background & Goal**: If a user modifies a file in their editor while the agent is generating a response, applying an edit can overwrite user changes or apply diffs against stale code.
* **Proposed Implementation**: Attach a content-hash or modification timestamp check to `edit` and `apply_patch` in [`fs.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/coder/fs.rs). Rejects edits with a stale-content error if the file on disk has moved from the expected base state.

### 1.8 Repository Rules Auto-Discovery & Context Injection (`workspace_rules.rs`)

* **Background & Goal**: Projects often define repository guidelines and coding standards in `AGENTS.md`, `PROJECT.md`, or `.cursorrules`. Currently, system prompts in [`tools.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/agent/tools.rs) are static.
* **Proposed Implementation**: Implement a native workspace rules discovery module (`workspace_rules.rs`). On run initialization, scan the active workspace root for `AGENTS.md`, `PROJECT.md`, and `.cursorrules`, parsing and injecting their instructions into `build_request` in [`engine_loop.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/agent/engine_loop.rs).

### 1.9 Asynchronous User Preemption & Instruction Queueing (`engine_loop.rs`)

* **Background & Goal**: Active agent runs currently only support cancellation via `STOP_ERR`. Users cannot queue follow-up prompts or mid-turn steering instructions while tools are executing.
* **Proposed Implementation**: Extend the `select!` channel in [`engine_loop.rs`](file:///mnt/storage/Projects/ninfier-ui/desktop/control/src/agent/engine_loop.rs) to accept incoming user instruction messages during tool execution turns, enabling non-blocking task queueing and dynamic turn steering.

### 1.10 Provider Profile Calibration & Reasoning Controls

* **Background & Goal**: Different inference backends (NInfer C++ sidecar, Ollama, OpenRouter, Claude) have varying context limits and reasoning parameter requirements.
* **Proposed Implementation**: Create provider calibration profiles in `desktop/control` to dynamically adjust reasoning effort budgets, system prompt formatting, and token counting fallbacks per model/backend.

---

## 2. Desktop Shell & Engine Lifecycle

* **Multi-Engine Supervision**: Support seamless runtime switching between NInfer C++ inference sidecar, Ollama, and remote OpenAI/Anthropic-compatible endpoints.
* **Enhanced MCP Server Management**: Provide UI controls in Coder settings for toggling individual MCP servers and setting per-server permission tiers.
* **Headless CLI Utility (`ninfer-cli`)**: Extract a lightweight, headless CLI binary from the Rust control daemon (`desktop/control`) to execute agent tasks directly from terminal environments and CI/CD pipelines without needing the full desktop GUI.
* **Headless Agent Client Protocol (ACP) Server Adapter**: Implement a stdio / JSON-RPC Agent Client Protocol (ACP) adapter for `desktop/control` and `ninfer-cli`, enabling external editors (Zed, Neovim, VSCode) to directly drive NInfer Studio's agent daemon.

---

## 3. UI & Experience Improvements

* **Fine-Grained Token Analytics**: Live tracking of prompt overhead vs tool schema tokens in the chat inspector window.
* **Interactive Tool Call Visualizer**: Improved rendering of multi-tool execution pipelines and subagent tree graphs.
