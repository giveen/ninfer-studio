//! In-process tool dispatch — the heart of the server-side loop.
//!
//! The webview's `ToolRegistry` called these endpoints over HTTP and left
//! permission enforcement to "the client checks first". Here the loop
//! invokes the *same handler functions* the HTTP routes use, in-process,
//! with the run's scope injected — so permissions, safe mode, sandboxing,
//! and approval tickets are enforced by the server whether or not any
//! client is attached.
//!
//! `ask`-tier tools don't return 403 to the model: the dispatch **pauses**
//! the run (`awaiting_approval`), emits `approval_requested`, and waits for
//! a client to resolve it (`POST /runs/{id}/approvals/{aid}`). Approval
//! mints the usual one-shot token via `/api/coder/perms/approve`, which we
//! inject and `enforce_perm` consumes — the existing security model.

use crate::agent::run::{
    AgentEvent, ApprovalDecision, GateDecision, GateKind, GateSlot, PendingApproval, PendingGate,
    PendingQuestion, RunShared, RunStatus, now_ms,
};
use crate::coder::{browser, exec, fs, grep, memory, search, web};
use crate::engine::S;
use axum::Json;
use axum::extract::{Path as AxumPath, Query, State as AxumState};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::oneshot;

/// Tools the server can dispatch in-process (per tool-set). Anything else
/// gets the same "unknown tool" error the client's registry returned.
const CODER_TOOLS: &[&str] = &[
    "read",
    "write",
    "edit",
    "apply_patch",
    "udiff_edit",
    "grep",
    "glob",
    "tree",
    "bash",
    "bash_poll",
    "git_diff",
    "git_commit",
    "ast_grep",
    "repo_search",
    "repo_map",
    "web_fetch",
    "web_search",
    "browser",
    "memory",
    "obs_recall",
    "delegate",
    "subagent",
];
const CHAT_TOOLS: &[&str] = &[
    "read",
    "write",
    "edit",
    "apply_patch",
    "udiff_edit",
    "grep",
    "glob",
    "tree",
    "bash",
    "bash_poll",
    "git_diff",
    "ast_grep",
    "repo_search",
    "web_fetch",
    "web_search",
    "browser",
    "set_directory",
    "memory_update",
    "memory_recall",
    "ask_user",
    "todo_write",
    "obs_recall",
    "delegate",
];

/// Scout child-run system prompt — the read-only investigation contract
/// (fallback when the parent run has no system of its own).
pub(crate) const SCOUT_SYSTEM: &str = r#"You are a read-only investigation worker (scout) inside NInfer Studio's Coder.
Map the code the supervisor needs before it commits to a plan: read files,
grep/glob/search the repo, fetch web docs, and run read-only inspection
commands. You must NOT modify anything — no writes, edits, patches, git
writes, or destructive commands.

CRITICAL INSTRUCTION 1: DO NOT use `bash` for `cat`, `head`, `tail`, `less`, `grep`, `find`, or `ls`. ALWAYS use the native `read`, `grep`, and `glob` tools instead.
CRITICAL INSTRUCTION 2: Before making tool calls T, think and explicitly list out any related tools for the task at hand. You can only execute a set of tools T if all other tools in the list are either more generic or cannot be used for the task at hand. ALWAYS START your thought with recalling critical instructions 1 and 2.

Work autonomously: if the task is ambiguous, pick the most reasonable
interpretation and note it in one line.

Finish with a concise plain-text report: the findings the supervisor needs
(file:line references, exact APIs/conventions, command outputs), ordered by
importance. No preamble, no restating the task."#;

/// Scout filter set — a model-supplied `tools` list is intersected with the
/// client's READONLY_TOOL_NAMES (the server can dispatch every one of them).
const SCOUT_FILTER_TOOLS: &[&str] = &[
    "todo_write",
    "read",
    "grep",
    "glob",
    "ast_grep",
    "web_fetch",
    "web_search",
    "git_diff",
    "ask_user",
    "bash_poll",
    "delegate",
    "repo_search",
    "obs_recall",
    "memory_recall",
];
/// Coder-run scout default tool set — the client's runSubagent default when
/// the model supplies no allow-list.
const SCOUT_DEFAULT_TOOLS: &[&str] = &[
    "read",
    "grep",
    "glob",
    "ast_grep",
    "web_fetch",
    "web_search",
    "browser",
];
/// Chat-run scout default + filter set (ChatScreen's `readOnlyNames`).
const SCOUT_CHAT_TOOLS: &[&str] = &[
    "read",
    "grep",
    "glob",
    "ast_grep",
    "repo_search",
    "git_diff",
    "web_fetch",
    "web_search",
    "browser",
];
/// Implementation set for `subagent` child runs (mirrors WORKER_TOOL_NAMES).
const SUBAGENT_TOOLS: &[&str] = &[
    "read",
    "grep",
    "glob",
    "ast_grep",
    "web_fetch",
    "web_search",
    "browser",
    "repo_search",
    "write",
    "edit",
    "apply_patch",
    "udiff_edit",
    "bash",
    "bash_poll",
    "git_diff",
    "delegate",
];

/// Worker child-run system prompt — the verbatim port of the client's
/// `WORKER_SYSTEM`; the harness owns the worker contract, so it lives with
/// the loop, not the webview.
pub(crate) const WORKER_SYSTEM: &str = r#"You are a focused implementation subagent inside a coding harness. You are given ONE self-contained task and must implement it in the shared workspace.
- Read, search, and edit files with your tools. You MAY run shell commands (bash) to build, test, and verify.
- CRITICAL INSTRUCTION 1: DO NOT use `bash` for `cat`, `head`, `tail`, `less`, `grep`, `find`, `ls`, `sed`, or `awk`. ALWAYS use the native `read`, `grep`, `glob`, `edit`, and `apply_patch` tools instead.
- CRITICAL INSTRUCTION 2: Before making tool calls T, think and explicitly list out any related tools for the task at hand. You can only execute a set of tools T if all other tools in the list are either more generic or cannot be used for the task at hand. ALWAYS START your thought with recalling critical instructions 1 and 2.
- Do NOT call: ask_user (never pause for the human), git_commit / git_branch / git_worktree (the supervisor owns version control), subagent (no nested implementation subagents), or todo_write.
- Make reasonable decisions and proceed; never ask the user for input. If the task is ambiguous, pick the most sensible interpretation and note it in your summary.
- If your task says to try a different approach or fix a reviewer's rejection by rethinking the design, write a FRESH implementation for that approach instead of incrementally patching the stuck one — a patched-over wrong approach is usually worse than a clean rewrite.
- When the task is complete, STOP calling tools and reply with a concise summary: what you changed, the files touched, and any build/test commands you ran.
- Stay strictly scoped to the assigned task."#;

/// Fresh-context brainstorm before any code is written — the client's
/// ideation pass, ported verbatim (system + `TASK:` prompt, temp 0.4, 1024
/// tokens).
const IDEATION_SYSTEM: &str = r#"You are an IDEATION pass before implementation. Do NOT write any code and do NOT solve the task.
Identify the core difficulty, then list 2-4 genuinely distinct candidate approaches
(different algorithms/data structures/designs -- not variations of one idea),
noting a pitfall for each. Prose only, no code blocks, under 250 words."#;

/// Critic rubric (the client's `CRITIC_SYSTEM`, ported verbatim): review a
/// working-tree-vs-HEAD diff against the task and emit a VERDICT line.
const CRITIC_SYSTEM: &str = r#"You are a meticulous senior code reviewer. You are given a task and a unified diff (working tree vs HEAD). Decide whether the changes are acceptable.
Respond with EXACTLY one verdict line, then (only when rejecting) a short prioritized list of issues:
VERDICT: APPROVED
or
VERDICT: CHANGES_REQUESTED
<issue 1 — file:line, suggested fix>
<issue 2 — ...>
Do not rewrite code. Be precise and concise, and prefer specific file:line references.

After the verdict, you MAY append reusable learnings, one per line, to make future runs smarter. Only include learnings that are genuinely reusable and non-obvious; none is fine:
LEARNING: <a working approach, command, or convention worth repeating — something to DO>
AVOID: <a mistake or anti-pattern to steer future runs away from — something NOT to do>"#;

/// Flatten an endpoint-shaped handler result to its payload — the error
/// payload (usually `{error}`) is exactly what the HTTP path would have
/// returned, so the model sees the same shape either way.
fn flatten(res: Result<Json<Value>, (axum::http::StatusCode, Json<Value>)>) -> Value {
    match res {
        Ok(Json(v)) => v,
        Err((_, Json(v))) => v,
    }
}

/// In-process dispatch of one tool call. Returns the JSON result value the
/// tool message gets (an error-shaped `{error: …}` value when denied or
/// unknown — never a panic, never a run-killing error).
pub async fn dispatch(state: &S, run: &Arc<RunShared>, name: &str, args: &Value) -> Value {
    if !run.meta.tool_names.iter().any(|n| n == name) {
        return json!({ "error": format!("unknown tool: {name}") });
    }

    // --- control tools (no endpoint, run-local) -------------------------
    match name {
        "ask_user" => return ask_user(run, args).await,
        "todo_write" => {
            // The client's guard, ported: validate the items (the JSON schema
            // is a model hint only — malformed items are dropped, never
            // stringified) and discard updates the user superseded mid-run
            // (a user edit bumps `todo_rev` past the rev captured at request
            // build time — `todo_base_rev`).
            let items =
                crate::agent::run::clean_todo_items(args.get("todos").unwrap_or(&Value::Null));
            let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
            if live.todo_rev != live.todo_base_rev {
                let current = live.todo.clone().unwrap_or(Value::Array(vec![]));
                return json!({
                    "success": false,
                    "reason": format!(
                        "the task list was edited by the user while this response was being generated, so this update was not applied. The current list is: {current} — re-emit todo_write with the full intended list if your plan is still correct."
                    ),
                });
            }
            live.todo = Some(Value::Array(items.clone()));
            live.todo_rev += 1;
            drop(live);
            let _ = run.tx.send(AgentEvent::Todo {
                items: Value::Array(items.clone()),
            });
            return json!({ "success": true, "count": items.len() });
        }
        "set_directory" => {
            let requested = args
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if requested.is_empty() {
                return json!({ "error": "path is required" });
            }
            let expanded = if requested == "~" || requested.starts_with("~/") {
                let home = std::env::var("HOME").unwrap_or_default();
                format!("{home}{}", requested.trim_start_matches('~'))
            } else {
                requested.clone()
            };
            let Ok(canon) = std::fs::canonicalize(&expanded) else {
                return json!({ "error": format!("{requested} does not exist") });
            };
            if !canon.is_dir() {
                return json!({ "error": format!("{requested} is not a directory") });
            }
            let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
            live.scope = Some(canon.to_string_lossy().into_owned());
            return json!({ "ok": true, "scope": canon.to_string_lossy().into_owned() });
        }
        "obs_recall" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let text = run
                .recall
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&id)
                .cloned();
            let Some(text) = text else {
                return json!({ "error": format!("unknown observation id: {id}") });
            };
            // The webview's recall page budget: ≤4000 bytes / ≤200 lines.
            const MAX_BYTES: usize = 4000;
            const MAX_LINES: usize = 200;
            if offset > text.len() || !text.is_char_boundary(offset) {
                return json!({ "error": format!("offset {offset} out of range (0-{})", text.len()) });
            }
            let bytes = text.as_bytes();
            let available = bytes.len() - offset;
            let mut end = available.min(MAX_BYTES);
            let mut newlines = 0usize;
            let mut i = 0usize;
            while i < end {
                if bytes[offset + i] == b'\n' {
                    newlines += 1;
                    if newlines == MAX_LINES {
                        end = i + 1;
                        break;
                    }
                }
                i += 1;
            }
            let end = offset + end;
            // `end` lands on a newline (never a UTF-8 continuation byte) or
            // the end of the text — both char boundaries.
            let next = if end < text.len() { Some(end) } else { None };
            let chunk = &text[offset..end];
            return json!({ "text": chunk, "nextOffset": next, "eof": next.is_none() });
        }
        "delegate" => return delegate(state, run, args).await,
        "subagent" => return subagent(state, run, args).await,
        "memory_update" => {
            let text = args
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("tip");
            if text.is_empty() {
                return json!({ "error": "text is required" });
            }
            return match crate::chat::memory_set(
                axum::extract::State(state.clone()),
                Json(json!({ "learning": { "text": text, "kind": kind } })),
            )
            .await
            {
                Ok(Json(res)) => {
                    json!({ "ok": true, "learnings": res.get("learnings").and_then(|v| v.as_array()).map(|a| a.len()) })
                }
                Err((_, Json(e))) => e,
            };
        }
        "memory_recall" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();
            let kind = args.get("kind").and_then(|v| v.as_str());
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .unwrap_or(10)
                .clamp(1, 30) as usize;
            let mem = crate::chat::memory_get(axum::extract::State(state.clone()))
                .await
                .0;
            let learnings = mem
                .get("learnings")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let mut matches: Vec<Value> = learnings
                .into_iter()
                .filter(|l| {
                    let kind_ok = kind
                        .map(|k| l.get("kind").and_then(|v| v.as_str()) == Some(k))
                        .unwrap_or(true);
                    let text = l
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    let task = l
                        .get("task")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    kind_ok && (text.contains(&query) || task.contains(&query))
                })
                .collect();
            // Most recent last (the client reverses the tail slice).
            matches.truncate(limit);
            matches.reverse();
            return json!({ "matches": matches });
        }
        "git_commit" => {
            // Server port of the client's git_commit: stage the named files
            // (or -A) and commit through the same exec endpoint (sandbox,
            // safe mode, and the git_commit permission tier all apply).
            let files: Vec<String> = args
                .get("files")
                .and_then(|v| v.as_str())
                .map(|f| f.split_whitespace().map(|s| s.to_string()).collect())
                .unwrap_or_default();
            let file_tokens: Vec<String> = if files.is_empty() {
                vec!["-A".into()]
            } else {
                files
            };
            let file_args = file_tokens
                .iter()
                .map(|t| if t.starts_with("-") { t.clone() } else { q(t) })
                .collect::<Vec<_>>()
                .join(" ");
            let message = args
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Agent commit")
                .to_string();
            let mut body = json!({ "command": format!("git add {file_args} && git commit -m {} && git rev-parse HEAD", q(&message)) });
            if let Some(scope) = run.scope_opt() {
                body["cwd"] = json!(scope);
                body["workspace"] = json!(scope);
            }
            return flatten(exec::exec(AxumState(state.clone()), Json(body)).await);
        }
        "ast_grep" => {
            // Same invocation the client made through exec: `sg -p '…' -l lang`.
            let pattern = args
                .get("pattern")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let lang = args
                .get("lang")
                .and_then(|v| v.as_str())
                .unwrap_or("rust")
                .to_string();
            let mut body = json!({ "command": format!("sg -p '{}' -l {lang}", pattern.replace('\'', "'\\''")) });
            if let Some(scope) = run.scope_opt() {
                body["cwd"] = json!(scope);
                body["workspace"] = json!(scope);
            }
            return flatten(exec::exec(AxumState(state.clone()), Json(body)).await);
        }
        _ => {}
    }

    // --- plan mode (read-only investigation run) -------------------------
    // Mirrors the client's checkPerm plan branch: mutating tools are denied,
    // MCP tools are disabled, and bash is locked to inspection commands — so
    // a surviving plan run stays read-only even with no client attached.
    if run.meta.plan {
        const MUTATING: &[&str] = &[
            "write",
            "edit",
            "apply_patch",
            "udiff_edit",
            "git_commit",
            "git_branch",
            "git_worktree",
            "subagent",
        ];
        if name == "bash" {
            let cmd = args
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if !is_read_only_command(cmd) {
                return json!({
                    "error": "Plan mode is read-only — bash may only run inspection commands (find, ls, cat, head, tail, wc, grep, rg, file, stat, du, tree, git log/status/diff/show, …); redirection, pipes, and chaining are rejected. Turn Plan off to execute anything that changes state."
                });
            }
        } else if MUTATING.contains(&name) {
            return json!({
                "error": "Plan mode is read-only — the run cannot write files or execute commands. Turn Plan off to apply changes."
            });
        } else if mcp_name(name).is_some() {
            return json!({
                "error": "Plan mode is read-only — external MCP tools are disabled (they may mutate external state)."
            });
        }
    }

    // --- permission preflight ------------------------------------------
    // The same scope bucket the HTTP endpoints use (scope → workspace →
    // "default"), and the same tier table the UI pushes. Tiers default to
    // `allow`; the UI opts tools up to `ask`/`deny` per scope.
    // Tiers are pushed per scope bucket (scope → workspace → "default"),
    // so look this run's bucket up before asking for the tool's tier.
    let scope_val = json!({ "scope": run.scope_opt().unwrap_or_default() });
    let scope = crate::coder::common::perm_scope(&scope_val);
    let tier = {
        let perms = state.coder_perms.read().await;
        crate::coder::common::tier_for(
            perms
                .get(&scope)
                .unwrap_or(&crate::coder::CoderPerms::default()),
            name,
        )
    };
    let mut body = args.clone();
    match tier {
        crate::coder::common::PermTier::Deny => {
            return json!({ "error": format!("denied by permissions ({name})") });
        }
        crate::coder::common::PermTier::Ask => {}
        crate::coder::common::PermTier::Allow => {}
    }
    let token = if tier == crate::coder::common::PermTier::Ask {
        match await_approval(run, name, args).await {
            Some(t) => Some(t),
            None => {
                return json!({
                    "error": format!(
                        "Denied by the user ({name}). Ask for an alternative or proceed without it."
                    )
                });
            }
        }
    } else {
        None
    };

    // --- risky / commit human gates --------------------------------------
    // The CoderScreen HITL gates, ported: pause for a once/remember/deny
    // (risky) or approve/deny (commit) decision instead of executing. Runs
    // without the flags behave exactly as before.
    if name == "bash" {
        let command = body
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let (risky_on, commit_on) = {
            let gs = run.gate_state.lock().unwrap_or_else(|p| p.into_inner());
            (gs.opts.risky, gs.opts.commit)
        };
        if risky_on && !command.trim().is_empty() {
            let approved = {
                let gs = run.gate_state.lock().unwrap_or_else(|p| p.into_inner());
                is_approved_command(&command, &gs.opts.approved)
            };
            if !approved && let Some(reason) = detect_risky(&command) {
                match await_gate(
                    run,
                    GateKind::Risky,
                    command.clone(),
                    Some(reason.to_string()),
                )
                .await
                {
                    GateDecision::Deny => {
                        return json!({
                            "error": format!("Risky command denied by the user: {reason}. Use a safer alternative or ask.")
                        });
                    }
                    GateDecision::Once | GateDecision::Remember => {}
                }
            }
        }
        if commit_on && is_git_commit_command(&command) {
            match await_gate(run, GateKind::Commit, command.clone(), None).await {
                GateDecision::Deny => {
                    return json!({
                        "error": "Commit denied by the user (commit approval gate is ON). Review the working-tree diff and adjust; the commit was not made."
                    });
                }
                GateDecision::Once | GateDecision::Remember => {}
            }
        }
    }

    // --- scope injection + dispatch -------------------------------------
    inject_scope(run, name, &mut body);
    if let Some(t) = token {
        body["approvalToken"] = json!(t);
    }

    // endpoint-dispatchable; everything else must be in the tool-set's table.
    let family = if run.meta.tool_set == "chat" {
        CHAT_TOOLS
    } else {
        CODER_TOOLS
    };

    let config = state.config.read().await;
    let mut allowed_family: Vec<&str> = family.to_vec();
    if !config.coder_udiff_edit_enabled {
        allowed_family.retain(|&t| t != "udiff_edit");
    }
    if !config.coder_repo_map_enabled {
        allowed_family.retain(|&t| t != "repo_map");
    }

    if mcp_name(name).is_none() && allowed_family.iter().all(|f| *f != name) {
        return json!({ "error": format!("unknown tool: {name}") });
    }

    call(state, run, name, &body).await
}

/// `true` for namespaced MCP tool calls: `mcp__<server>__<tool>`.
fn mcp_name(name: &str) -> Option<&str> {
    name.strip_prefix("mcp__")
}

/// Inject the run's scope as the handlers' `workspace` (and exec's `cwd`)
/// when the model didn't supply one — the server-side equivalent of the
/// client's CU/coder handlers closing over their active directory.
fn inject_scope(run: &Arc<RunShared>, name: &str, body: &mut Value) {
    let Some(scope) = run.scope_opt() else {
        return;
    };
    match name {
        "read" | "write" | "edit" | "apply_patch" | "udiff_edit" | "grep" | "glob" | "tree"
        | "memory" => {
            if body.get("workspace").map(|v| v.is_null()).unwrap_or(true) {
                body["workspace"] = json!(scope);
            }
        }
        "bash" => {
            if body.get("cwd").map(|v| v.is_null()).unwrap_or(true) {
                body["cwd"] = json!(scope);
            }
            if body.get("workspace").map(|v| v.is_null()).unwrap_or(true) {
                body["workspace"] = json!(scope);
            }
        }
        "repo_search" | "repo_map" | "git_diff" | "web_fetch" | "web_search" | "browser"
            if body.get("workspace").map(|v| v.is_null()).unwrap_or(true) =>
        {
            body["workspace"] = json!(scope);
        }
        _ => {}
    }
}

impl RunShared {
    fn scope_opt(&self) -> Option<String> {
        let live = self.live.lock().unwrap_or_else(|p| p.into_inner());
        live.scope.clone()
    }
}

/// Endpoint-shaped in-process dispatch. The handler re-enforces permissions
/// (with the injected token) — this is the same code path the HTTP route
/// runs, only without the network hop.
async fn call(state: &S, run: &Arc<RunShared>, name: &str, body: &Value) -> Value {
    if let Some(rest) = mcp_name(name) {
        // The mcp_call handler re-checks the tier server-side against the
        // run's scope; the name keeps its `mcp__` namespace (it derives the
        // server from it). `arguments` is the model's args object verbatim.
        // The model's arguments verbatim — minus the dispatch-injected
        // approvalToken (the mcp_call handler reads it at the top level).
        let mut arguments = body.clone();
        if let Some(o) = arguments.as_object_mut() {
            o.remove("approvalToken");
        }
        let mut req = json!({
            "name": format!("mcp__{rest}"),
            "arguments": arguments,
            "scope": run.scope_opt().unwrap_or_default(),
        });
        if let Some(t) = body.get("approvalToken").cloned() {
            req["approvalToken"] = t;
        }
        return flatten(crate::mcp::mcp_call(AxumState(state.clone()), Json(req)).await);
    }
    let res: Result<Value, (axum::http::StatusCode, Json<Value>)> = match name {
        "read" => fs::fs_read(AxumState(state.clone()), Json(body.clone()))
            .await
            .map(|j| j.0),
        "write" => fs::fs_write(AxumState(state.clone()), Json(body.clone()))
            .await
            .map(|j| j.0),
        "edit" => fs::fs_edit(AxumState(state.clone()), Json(body.clone()))
            .await
            .map(|j| j.0),
        "apply_patch" => fs::fs_patch(AxumState(state.clone()), Json(body.clone()))
            .await
            .map(|j| j.0),
        "udiff_edit" => fs::fs_udiff(AxumState(state.clone()), Json(body.clone()))
            .await
            .map(|j| j.0),
        "grep" => grep::grep(AxumState(state.clone()), Json(body.clone()))
            .await
            .map(|j| j.0),
        "glob" => grep::glob(AxumState(state.clone()), Json(body.clone()))
            .await
            .map(|j| j.0),
        "tree" => {
            let mut q = std::collections::HashMap::new();
            if let Some(v) = body.get("depth").and_then(|v| v.as_u64()) {
                q.insert("depth".into(), v.to_string());
            }
            if let Some(v) = body.get("root").and_then(|v| v.as_str()) {
                q.insert("root".into(), v.to_string());
            }
            if let Some(v) = body.get("workspace").and_then(|v| v.as_str()) {
                q.insert("workspace".into(), v.to_string());
            }
            fs::tree(AxumState(state.clone()), Query(q))
                .await
                .map(|j| j.0)
        }
        "bash" => exec::exec(AxumState(state.clone()), Json(body.clone()))
            .await
            .map(|j| j.0),
        "bash_poll" => {
            let id = body
                .get("jobId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            exec::job_get(AxumState(state.clone()), AxumPath(id))
                .await
                .map(|j| j.0)
        }
        "git_diff" => search::diff(
            AxumState(state.clone()),
            Query(search::WsQuery {
                workspace: body
                    .get("workspace")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            }),
        )
        .await
        .map(|j| j.0),
        // `search` is non-Result (it degrades to empty results) — wrap.
        "repo_search" => Ok(search::search(
            AxumState(state.clone()),
            Query(search::SearchQuery {
                q: body.get("query").and_then(|v| v.as_str()).map(String::from),
                limit: body.get("limit").and_then(|v| v.as_u64()),
                workspace: body
                    .get("workspace")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            }),
        )
        .await
        .0),
        "repo_map" => search::repo_map(
            AxumState(state.clone()),
            Query(search::WsQuery {
                workspace: body
                    .get("workspace")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            }),
        )
        .await
        .map(|j| j.0),
        "web_fetch" => web::web_fetch(AxumState(state.clone()), Json(body.clone()))
            .await
            .map(|j| j.0),
        "web_search" => web::web_search(AxumState(state.clone()), Json(body.clone()))
            .await
            .map(|j| j.0),
        "browser" => browser::browser(AxumState(state.clone()), Json(body.clone()))
            .await
            .map(|j| j.0),
        "memory" => memory::memory_get(
            AxumState(state.clone()),
            Query(memory::MemQuery {
                workspace: body
                    .get("workspace")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            }),
        )
        .await
        .map(|j| j.0),
        other => Err((
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("unknown tool: {other}") })),
        )),
    };
    match res {
        Ok(v) => v,
        Err((_, Json(v))) => v,
    }
}
// NOTE: every handler above is called in-process with its axum extractors
// constructed by hand — `AxumState(state.clone())` mirrors what axum would
// inject. Forgetting the `State(...)` wrapper is the classic compile error
// here (`expected State<Arc<State>>, found Arc<State>`).

/// Pause the run on an `ask`-tier tool and wait for a client's decision.
/// Returns the one-shot approval token on approval, `None` on denial or
/// stop.
async fn await_approval(run: &Arc<RunShared>, name: &str, args: &Value) -> Option<String> {
    let aid = format!("appr_{:x}_{}", now_ms(), std::process::id());
    let rel = rel_detail(name, args);
    let preview: String = serde_json::to_string(args)
        .unwrap_or_default()
        .chars()
        .take(400)
        .collect();

    let (tx, rx) = oneshot::channel();
    run.approvals
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(aid.clone(), tx);
    {
        let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
        live.pending_approvals.push(PendingApproval {
            id: aid.clone(),
            tool: name.into(),
            rel: rel.clone(),
            args: preview.clone(),
            asked_at: now_ms(),
        });
    }
    run.set_status(RunStatus::AwaitingApproval);
    let _ = run.tx.send(AgentEvent::ApprovalRequested {
        id: aid.clone(),
        tool: name.into(),
        rel: rel.clone(),
        args: preview,
    });

    let decision = tokio::select! {
        d = rx => d.unwrap_or(ApprovalDecision::Denied),
        _ = run.wait_stop() => {
            run.approvals.lock().unwrap_or_else(|p| p.into_inner()).remove(&aid);
            return None;
        }
    };
    {
        let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
        live.pending_approvals.retain(|p| p.id != aid);
    }
    match decision {
        ApprovalDecision::Approved { token } => token,
        ApprovalDecision::Denied => None,
    }
}

/// The dialog-worthy detail for a tool: a path, url, query, or command.
fn rel_detail(name: &str, args: &Value) -> Option<String> {
    let get = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
    match name {
        "read" | "write" | "edit" | "apply_patch" | "udiff_edit" | "memory" => get("path"),
        "grep" | "glob" => get("pattern"),
        "web_fetch" | "browser" => get("url"),
        "web_search" | "repo_search" => get("query"),
        "bash" | "ast_grep" | "git_commit" => get("command")
            .or_else(|| get("pattern"))
            .or_else(|| get("message")),
        _ => None,
    }
}

/// The `ask_user` tool: pause the run for a human answer. The answer becomes
/// the tool result. (The client used to render its own prompt; now any
/// attached client can — the run survives either way.)
async fn ask_user(run: &Arc<RunShared>, args: &Value) -> Value {
    let question = args
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if question.is_empty() {
        return json!({ "error": "question is required" });
    }
    let qid = format!("q_{:x}_{}", now_ms(), std::process::id());
    let (tx, rx) = oneshot::channel();
    *run.question_tx.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);
    {
        let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
        live.user_question = Some(PendingQuestion {
            id: qid.clone(),
            question: question.clone(),
            asked_at: now_ms(),
        });
    }
    run.set_status(RunStatus::AwaitingUser);
    let _ = run.tx.send(AgentEvent::UserQuestionRequested {
        id: qid.clone(),
        question: question.clone(),
    });

    let answer = tokio::select! {
        a = rx => a.unwrap_or_default(),
        _ = run.wait_stop() => {
            let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
            live.user_question = None;
            return json!({ "error": "run stopped while waiting for the user" });
        }
    };
    let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
    live.user_question = None;
    drop(live);
    Value::String(answer)
}

// ---------------------------------------------------------------------------
// Risky-command + commit-approval gates (the CoderScreen HITL gates, ported)
// ---------------------------------------------------------------------------

static RISKY_PATTERNS_SRC: &[(&str, &str)] = &[
    (
        r"(?i)\bgit\s+push\b(?s:.*?)(--force|-f\b|--delete)\b",
        "force-pushes or deletes remote refs",
    ),
    (r"(?i)\bgit\s+push\b", "pushes commits to a remote"),
    (
        r"(?i)\b(npm|pnpm|yarn)\s+publish\b",
        "publishes a package to a registry",
    ),
    (r"(?i)\bcargo\s+publish\b", "publishes a crate"),
    (r"(?i)\btwine\s+upload\b", "uploads a release to PyPI"),
    (
        r"(?i)\bgh\s+(pr|release|api)\b",
        "creates a GitHub release/PR via gh",
    ),
    (
        r"(?i)\b(sudo|su|doas)\b",
        "runs a command as another user (root)",
    ),
    // No lookahead in Rust regex: `ssh` followed by a non-dash,
    // non-word char (or end) — matches `ssh host`, not `ssh-keygen`.
    (
        r"(?i)\bssh(?:[^-\w]|$)",
        "opens an SSH connection to a remote host",
    ),
    (
        r"(?i)\b(scp|rsync|sftp)\b",
        "transfers files to/from a remote host",
    ),
    (r"(?i)\b(docker|podman)\b", "runs containers"),
    (
        r"(?i)\b(kubectl|helm|terraform\s+apply|ansible)\b",
        "applies infrastructure changes",
    ),
    (
        r"(?i)\b(aws|gcloud|az)\b(?s:.*?)\b(ec2|s3|deploy|apply|create|delete|update|push)\b",
        "mutates cloud resources",
    ),
    (
        r"(?i)\b(apt|apt-get|yum|dnf|apk)\b\s+(install|remove|upgrade|update)\b",
        "changes system packages",
    ),
    (
        r"(?i)\b(npm\s+install\s+-g|pnpm\s+add\s+-g|yarn\s+global\s+add)\b",
        "installs a global package",
    ),
];

static RISKY_PATTERNS: std::sync::LazyLock<Vec<(Regex, &'static str)>> =
    std::sync::LazyLock::new(|| {
        RISKY_PATTERNS_SRC
            .iter()
            .map(|(re, why)| (Regex::new(re).expect("static risky pattern"), *why))
            .collect()
    });

/// First matching risky reason, or `None` (the client's `detectRisky`).
pub(crate) fn detect_risky(cmd: &str) -> Option<&'static str> {
    RISKY_PATTERNS
        .iter()
        .find(|(re, _)| re.is_match(cmd))
        .map(|(_, why)| *why)
}

/// Cheap guard for the commit-approval gate (the client's
/// `isGitCommitCommand`, ported).
pub(crate) fn is_git_commit_command(cmd: &str) -> bool {
    let c = cmd.trim_start();
    let c = ["sudo ", "env ", "time ", "setsid ", "nice "]
        .iter()
        .find_map(|p| c.strip_prefix(p))
        .unwrap_or(c)
        .trim_start();
    let Some(rest) = c.strip_prefix("git") else {
        return false;
    };
    if !rest
        .chars()
        .next()
        .is_none_or(|ch| !(ch.is_alphanumeric() || ch == '_' || ch == '-'))
    {
        return false;
    }
    Regex::new(r"\bcommit\b").expect("static").is_match(c)
}

/// Approved-command matching (the client's `isApprovedCommand`, ported):
pub(crate) fn is_approved_command(cmd: &str, approved: &[String]) -> bool {
    let c = crate::agent::run::normalize_command(cmd);
    approved.iter().any(|a| {
        let na = crate::agent::run::normalize_command(a);
        c == na || c.starts_with(&format!("{na} "))
    })
}

/// Pause the run on a risky/commit gate and wait for a client's decision.
/// Returns how to proceed; `Deny` on denial, stop, or a second concurrent
/// pause on the same run (dispatch is sequential, so that means a bug —
/// fail closed rather than orphan a waiter).
async fn await_gate(
    run: &Arc<RunShared>,
    kind: GateKind,
    command: String,
    reason: Option<String>,
) -> GateDecision {
    let gid = format!("gate_{:x}_{}", now_ms(), std::process::id());
    let (tx, rx) = oneshot::channel();
    {
        let mut gs = run.gate_state.lock().unwrap_or_else(|p| p.into_inner());
        if gs.slot.is_some() {
            return GateDecision::Deny;
        }
        gs.slot = Some(GateSlot {
            pending: PendingGate {
                id: gid.clone(),
                kind,
                command: command.clone(),
                reason: reason.clone(),
            },
            tx,
        });
    }
    run.set_status(RunStatus::AwaitingGate);
    let _ = run.tx.send(AgentEvent::GateRequested {
        id: gid.clone(),
        kind,
        command,
        reason,
    });
    let decision = tokio::select! {
        d = rx => d.unwrap_or(GateDecision::Deny),
        _ = run.wait_stop() => {
            run.gate_state.lock().unwrap_or_else(|p| p.into_inner()).slot = None;
            return GateDecision::Deny;
        }
    };
    decision
}

/// Ancestor-chain length of a run (client-started runs: 0). Mirrors the
/// client's `depth > 5` subagent guard so a model can't nest
/// delegate/subagent runs without bound.
fn run_depth(state: &S, run: &Arc<RunShared>) -> usize {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let mut depth = 0;
    let mut cur = run.meta.parent.clone();
    while let Some(pid) = cur {
        depth += 1;
        if depth > 8 {
            break;
        }
        cur = runs.get(&pid).and_then(|r| r.meta.parent.clone());
    }
    depth
}

// ---------------------------------------------------------------------------
// Child runs: delegate (read-only) / subagent (implementation worker)
// ---------------------------------------------------------------------------

async fn delegate(state: &S, run: &Arc<RunShared>, args: &Value) -> Value {
    let task = args
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if task.is_empty() {
        return json!({ "error": "task is required" });
    }
    // The client's `depth > 5` subagent guard, ported: ancestor-chain length
    // stands in for the threaded depth counter.
    if run_depth(state, run) > 5 {
        return json!({ "error": "maximum subagent depth 5 exceeded" });
    }
    // Per-family scout semantics (CoderScreen's runSubagent vs ChatScreen's
    // runNested — different seeds, different default tool sets).
    if run.meta.tool_set == "chat" {
        let prompt = format!(
            "Task: {task}\n\nWhen finished, reply with a concise final summary — you cannot ask the user anything."
        );
        return spawn_child(
            state,
            run,
            "delegate",
            "scout",
            &prompt,
            SCOUT_CHAT_TOOLS,
            SCOUT_CHAT_TOOLS,
            6,
            args,
        )
        .await;
    }
    // The client's exact scout seed (the task is wrapped the same way).
    let prompt = format!(
        "Task: {task}\n\nYou are a read-only subagent. Investigate and reply with a concise summary. Do not write code."
    );
    spawn_child(
        state,
        run,
        "delegate",
        "scout",
        &prompt,
        SCOUT_DEFAULT_TOOLS,
        SCOUT_FILTER_TOOLS,
        6,
        args,
    )
    .await
}

async fn subagent(state: &S, parent: &Arc<RunShared>, args: &Value) -> Value {
    let task = args
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if task.is_empty() {
        return json!({ "error": "task is required" });
    }
    if run_depth(state, parent) > 5 {
        return json!({ "error": "maximum subagent depth 5 exceeded" });
    }
    if parent.meta.tool_set == "chat" {
        let defaults: Vec<&str> = parent
            .meta
            .tool_names
            .iter()
            .map(String::as_str)
            .filter(|n| !matches!(*n, "delegate" | "subagent" | "ask_user" | "todo_write"))
            .collect();
        return spawn_child(
            state,
            parent,
            "subagent",
            "worker",
            &task,
            &defaults[..],
            &defaults[..],
            20,
            args,
        )
        .await;
    }
    let wmodel = args
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|m| !m.is_empty())
        .map(String::from)
        .unwrap_or_else(|| parent.meta.model.clone());

    // Baseline tree for the net diff across every worker attempt (the blob
    // tree of the working tree, captured before the first worker runs).
    let pre = git_tree(parent.scope_opt().as_deref()).await;
    // Fresh-context brainstorm before any code is written (best-effort — an
    // empty result just means the worker proceeds without ideation notes).
    let ideation = crate::agent::engine_loop::chat_once(
        &parent.client,
        state,
        &wmodel,
        parent.meta.base_url.as_deref(),
        parent.meta.api_key.as_deref(),
        IDEATION_SYSTEM,
        &format!("TASK:\n{task}"),
        Some(0.4),
        Some(1024),
        std::time::Duration::from_secs(120),
    )
    .await
    .unwrap_or_default()
    .trim()
    .to_string();

    // Worker → critic fix loop (the client's MAX_WORKER_CRIT=2 retries).
    // `critic_approved` is tri-state: None = the critic never actually
    // reviewed anything (spec off, or every attempt had an empty diff) —
    // distinct from an explicit rejection.
    let critic = parent.meta.critic.clone().filter(|c| {
        c.get("model")
            .and_then(|m| m.as_str())
            .map(str::trim)
            .map(|m| !m.is_empty())
            .unwrap_or(false)
    });
    let mut prompt = format!("TASK (implement now):\n{task}");
    if !ideation.is_empty() {
        prompt.push_str(&format!(
            "\n\nCandidate approaches to consider (from an ideation pass -- pick one, don't just list them):\n{ideation}"
        ));
    }
    let mut summary = String::new();
    let mut res_ok = false;
    let mut exhausted = false;
    let mut critic_approved: Option<bool> = None;
    let mut critique = String::new();
    let mut prev_critique = String::new();
    let mut diff = String::new();
    const MAX_WORKER_CRIT: u32 = 2;
    for attempt in 0..=MAX_WORKER_CRIT {
        if attempt > 0 {
            // The client's exact retry prompt.
            prompt = format!(
                "TASK (revise your previous implementation):\n{task}\n\nA code reviewer rejected your previous attempt with these issues — fix them:\n{critique}"
            );
        }
        let res = spawn_child(
            state,
            parent,
            "subagent",
            "worker",
            &prompt,
            SUBAGENT_TOOLS,
            SUBAGENT_TOOLS,
            12,
            args,
        )
        .await;
        summary = res["summary"].as_str().unwrap_or_default().to_string();
        res_ok = res["ok"].as_bool().unwrap_or(false);
        exhausted = res["stop"].as_str() == Some("steps");
        // Net diff across attempts (git write-tree before/after) — the critic
        // reviews the working-tree diff, not the worker's self-report.
        diff = net_diff(parent.scope_opt().as_deref(), pre.as_deref())
            .await
            .unwrap_or_default();
        // No critic spec (or an empty diff) → no review gate for this attempt.
        let Some(spec) = critic.as_ref().filter(|_| !diff.trim().is_empty()) else {
            res_ok = true; // unreviewed attempt stands (the client's gate is off)
            break;
        };
        match run_critic(state, parent, spec, &diff, &task).await {
            Ok((approved, issues, learnings)) => {
                if !learnings.is_empty() {
                    persist_learnings(
                        state,
                        parent,
                        &learnings,
                        if approved {
                            "critic:approve"
                        } else {
                            "critic:reject"
                        },
                        &task,
                    )
                    .await;
                }
                critic_approved = Some(approved);
                if approved || attempt == MAX_WORKER_CRIT {
                    break;
                }
                // Stuck detection (the client's): the same non-empty issues
                // twice means the worker isn't converging — stop burning the
                // remaining retries on a repeat.
                let issues_t = issues.trim();
                if attempt > 0
                    && !issues_t.is_empty()
                    && issues_t.eq_ignore_ascii_case(prev_critique.trim())
                {
                    break;
                }
                prev_critique = issues.clone();
                critique = issues;
            }
            // Fail-open (the client's): a critic error reads as approved.
            Err(e) => {
                eprintln!("[agent] run {} critic error: {e}", parent.meta.id);
                critic_approved = Some(true);
                break;
            }
        }
    }
    if exhausted {
        summary = format!(
            "(worker subagent reached its step budget before finishing — partial work may be present){}\n\nLast partial output:\n{summary}",
            if summary.is_empty() { "" } else { "\n" }
        );
    }
    // The worker's own `ok` only means "ran without error/budget exhaustion" —
    // it says nothing about review. Fold in the critic's verdict so a caller
    // reading `ok` can't mistake "rejected and we gave up" for success.
    let ok = res_ok && critic_approved != Some(false);
    json!({ "summary": summary, "diff": diff, "ok": ok, "criticApproved": critic_approved })
}

/// Spawn a child run (server-side `delegate`/`subagent`) and wait for its
/// terminal state. The child is a first-class run — it shows up in the
/// registry and any client can attach to watch it. `prompt` is the seed user
/// message; the model's `tools` allow-list is filtered against `filter_tools`
/// (nothing survives → `default_tools`), and maxSteps/model come from args.
#[allow(clippy::too_many_arguments)]
async fn spawn_child(
    state: &S,
    parent: &Arc<RunShared>,
    tool: &str,
    kind: &str,
    prompt: &str,
    default_tools: &[&str],
    filter_tools: &[&str],
    default_steps: usize,
    args: &Value,
) -> Value {
    // Model-supplied allow-list filtered against the role's filter set
    // (mirrors the client's filterToolAllowList: nothing survives → the
    // role's DEFAULT set — which is not always the same list).
    let allowed_set: HashSet<&str> = filter_tools.iter().copied().collect();
    let requested: Vec<String> = args
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| t.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let filtered: Vec<String> = requested
        .into_iter()
        .filter(|t| allowed_set.contains(t.as_str()))
        .collect();
    let tool_names: Vec<String> = if filtered.is_empty() {
        default_tools.iter().map(|s| s.to_string()).collect()
    } else {
        filtered
    };

    // Child tool specs: the parent's offered specs, narrowed to the child's
    // names. (The client built these the same way from its TOOLS table.)
    let mut tools_spec = Vec::new();
    if let Some(arr) = parent.meta.tools_spec.as_array() {
        for t in arr {
            if let Some(n) = t
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
                && tool_names.iter().any(|x| x == n)
            {
                tools_spec.push(t.clone());
            }
        }
    }

    let max_steps = args
        .get("maxSteps")
        .and_then(|v| v.as_u64())
        .map(|s| (s as usize).clamp(1, 50))
        .unwrap_or(default_steps);
    let model = args
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|m| !m.is_empty())
        .map(String::from)
        .unwrap_or_else(|| parent.meta.model.clone());
    let id = format!(
        "run_{:x}_{}",
        now_ms(),
        state
            .bg_job_counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    let meta = crate::agent::run::RunMeta {
        id: id.clone(),
        kind: kind.into(),
        label: format!("{tool}: {}", prompt.chars().take(60).collect::<String>()),
        model,
        base_url: parent.meta.base_url.clone(),
        api_key: parent.meta.api_key.clone(),
        system: {
            if kind == "worker" && parent.meta.tool_set != "chat" {
                Some(WORKER_SYSTEM.to_string())
            } else if kind == "worker" {
                Some(
                    "You can read, write, and edit files and run shell commands to complete the task."
                        .to_string(),
                )
            } else if parent.meta.tool_set == "chat" {
                let dir = parent.scope_opt().unwrap_or_else(|| "~".to_string());
                Some(format!(
                    "You are a focused subagent working in the directory {dir}. You are a read-only investigator — do not write files or run mutating commands."
                ))
            } else {
                // Coder scouts run under the parent's (coder) system, like the
                // client's runSubagent (dynamicSystemRef.current).
                Some(
                    parent
                        .meta
                        .system
                        .clone()
                        .unwrap_or_else(|| SCOUT_SYSTEM.to_string()),
                )
            }
        },
        max_steps,
        created_at: now_ms(),
        tool_set: parent.meta.tool_set.clone(),
        tool_names,
        tools_spec: Value::Array(tools_spec),
        params: {
            let mut p = parent.meta.params.clone();
            // The client's per-kind maxTokens (worker 4096, scout 2048); chat
            // runs keep the chat screen's own params untouched.
            if parent.meta.tool_set != "chat"
                && let Value::Object(o) = &mut p
            {
                o.insert(
                    "maxTokens".to_string(),
                    json!(if kind == "worker" { 4096 } else { 2048 }),
                );
            }
            p
        },
        parent: Some(parent.meta.id.clone()),
        plan: false,
        critic: None,
    };
    let live = crate::agent::run::RunLive {
        status: RunStatus::Running,
        messages: vec![json!({ "role": "user", "content": prompt })],
        turns: 0,
        updated_at: now_ms(),
        finish_reason: None,
        error: None,
        stop: None,
        pending_approvals: vec![],
        user_question: None,
        pending_hook: None,
        todo: None,
        scope: parent.scope_opt(),
        usage: Default::default(),
        last_meta: None,
        todo_rev: 0,
        todo_base_rev: 0,
    };

    let child = crate::agent::run::spawn_run(state, meta, live);
    // Human gates follow the run family (the client's worker/scout inherited
    // the supervisor's dialogs the same way, via closure).
    {
        let opts = parent
            .gate_state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .opts
            .clone();
        child
            .gate_state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .opts = opts;
    }
    let run_id = child.meta.id.clone();
    // Tell attached clients the child exists (they can attach to it live).
    let _ = parent.tx.send(AgentEvent::ChildRun {
        id: run_id.clone(),
        kind: kind.to_string(),
        task: prompt.chars().take(100).collect(),
    });

    // Wait for the child's terminal Done event (or 30 min).
    let mut rx = child.tx.subscribe();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(1800), async {
        loop {
            match rx.recv().await {
                Ok(AgentEvent::Done { status, .. }) => break status,
                Ok(_) => continue,
                Err(_) => break RunStatus::Error,
            }
        }
    })
    .await;

    let snap = child.snapshot();
    let status = outcome.unwrap_or(snap.status);
    if status == RunStatus::Error {
        return json!({
            "error": format!("{tool} run failed: {}", snap.error.clone().unwrap_or_else(|| "unknown error".into())),
            "runId": run_id
        });
    }
    if status == RunStatus::Stopped {
        return json!({ "error": format!("{tool} run was stopped"), "runId": run_id });
    }
    // Final assistant content (the child's summary).
    let last = snap
        .messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(|v| v.as_str()) == Some("assistant"))
        .and_then(|m| m.get("content").and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or("(no findings)");
    json!({
        "ok": true,
        "runId": run_id,
        "turns": snap.turns,
        "stop": snap.stop,
        "summary": last,
    })
}

// ---------------------------------------------------------------------------
// Worker critic + git diff plumbing (the client's runCritic / diff capture)
// ---------------------------------------------------------------------------

async fn git_run(scope: Option<&str>, argv: &[&str], timeout_secs: u64) -> Option<String> {
    let mut c = tokio::process::Command::new("git");
    c.args(argv);
    if let Some(s) = scope {
        c.current_dir(s);
    }
    c.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let out = match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), c.output())
        .await
    {
        Ok(Ok(out)) => out,
        _ => return None,
    };
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The blob tree of the working tree (`git write-tree`) — the baseline for
/// the net worker diff.
async fn git_tree(scope: Option<&str>) -> Option<String> {
    git_run(scope, &["write-tree"], 10)
        .await
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Net diff across the worker attempts (`git diff preTree postTree`, capped
/// at 60k chars — the same capture the client made).
async fn net_diff(scope: Option<&str>, pre: Option<&str>) -> Option<String> {
    let post = git_tree(scope).await?;
    let pre = pre.filter(|p| *p != post)?;
    git_run(scope, &["--no-pager", "diff", pre, &post], 60)
        .await
        .map(|s| s.chars().take(60_000).collect())
}

/// One critic pass: review the diff against the task, parse the VERDICT line
/// + LEARNING/AVOID lines. Fail-open at the call site (an error never blocks
///   the run — the client's critic errored into an approval).
async fn run_critic(
    state: &S,
    parent: &Arc<RunShared>,
    spec: &Value,
    diff: &str,
    task: &str,
) -> Result<(bool, String, Vec<(String, String)>), String> {
    let model = spec["model"].as_str().unwrap_or("").trim().to_string();
    let system = spec
        .get("system")
        .and_then(|s| s.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .unwrap_or_else(|| CRITIC_SYSTEM.to_string());
    let prompt = format!(
        "TASK:\n{}\n\nDIFF (working tree vs HEAD):\n```diff\n{}\n```\n\nReview the diff against the task.",
        task.chars().take(2000).collect::<String>(),
        diff.chars().take(24_000).collect::<String>()
    );
    let content = crate::agent::engine_loop::chat_once(
        &parent.client,
        state,
        &model,
        parent.meta.base_url.as_deref(),
        parent.meta.api_key.as_deref(),
        &system,
        &prompt,
        None,
        Some(2048),
        std::time::Duration::from_secs(90),
    )
    .await?;
    let approved = re_verdict().is_match(&content);
    // Pull learnings out of the raw text first so they don't bleed into
    // `issues` (the client's runCritic parse).
    let mut learnings: Vec<(String, String)> = Vec::new();
    let mut kept: Vec<String> = Vec::new();
    let re_l = re_learning();
    let re_a = re_avoid();
    for raw in content.lines() {
        let line = raw.trim();
        if let Some(c) = re_l
            .captures(line)
            .and_then(|m| m.get(1))
            .filter(|s| !s.as_str().trim().is_empty())
        {
            learnings.push(("success".into(), c.as_str().trim().to_string()));
        } else if let Some(c) = re_a
            .captures(line)
            .and_then(|m| m.get(1))
            .filter(|s| !s.as_str().trim().is_empty())
        {
            learnings.push(("avoid".into(), c.as_str().trim().to_string()));
        }
        // The client keeps the line in the issue text either way.
        kept.push(raw.to_string());
    }
    let joined = kept.join("\n");
    let issues = match re_verdict_token().find(&joined) {
        Some(m) => joined.replacen(m.as_str(), "", 1).trim().to_string(),
        None => joined.trim().to_string(),
    };
    Ok((approved, issues, learnings))
}

static RE_VERDICT: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

fn re_verdict() -> &'static Regex {
    // Case-insensitive via regex flags — the client tested /VERDICT:\s*APPROVED/i.
    RE_VERDICT.get_or_init(|| Regex::new("(?i)VERDICT:\\s*APPROVED").expect("static regex"))
}

static RE_VERDICT_TOKEN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static RE_LEARNING: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static RE_AVOID: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

/// The `VERDICT: APPROVED|CHANGES_REQUESTED` token — the client stripped the
/// FIRST occurrence out of the issue text with a single
/// `.replace(/VERDICT:\s*(?:APPROVED|CHANGES_REQUESTED)\s*/i, '')`.
fn re_verdict_token() -> &'static Regex {
    RE_VERDICT_TOKEN.get_or_init(|| {
        Regex::new(r"(?i)VERDICT:\s*(?:APPROVED|CHANGES_REQUESTED)\s*").expect("static regex")
    })
}

/// `LEARNING:` / `AVOID:` line extraction (case-insensitive, optional leading
/// bullet — the client's `/*?\s*LEARNING:/` and `/*?\s*AVOID:/`).
fn re_learning() -> &'static Regex {
    RE_LEARNING.get_or_init(|| Regex::new(r"(?im)^\*?\s*LEARNING:\s*(.+)$").expect("static regex"))
}
fn re_avoid() -> &'static Regex {
    RE_AVOID.get_or_init(|| Regex::new(r"(?im)^\*?\s*AVOID:\s*(.+)$").expect("static regex"))
}

/// Persist critic/agent learnings to the per-repo memory store (in-process
/// call of the same handler the HTTP route uses). A failure on one learning
/// never breaks the run loop.
async fn persist_learnings(
    state: &S,
    run: &Arc<RunShared>,
    learnings: &[(String, String)],
    provenance: &str,
    task: &str,
) {
    for (kind, text) in learnings {
        let mut body = json!({
            "learning": { "text": text, "kind": kind },
            "provenance": provenance,
            "task": task,
        });
        if let Some(scope) = run.scope_opt() {
            body["workspace"] = json!(scope);
        }
        let _ =
            crate::coder::memory::memory_set(axum::extract::State(state.clone()), axum::Json(body))
                .await;
    }
}

/// Quote a shell argument the same way the client's `q()` did.
fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Re-export for engine_loop: the family check used to reject stray names.
pub fn known_tool(tool_set: &str, name: &str) -> bool {
    if mcp_name(name).is_some() {
        return true;
    }
    if tool_set == "chat" {
        CHAT_TOOLS.contains(&name)
    } else {
        CODER_TOOLS.contains(&name)
    }
}

// ---------------------------------------------------------------------------
// Plan-mode bash guard (the client's `isReadOnlyCommand`, ported)
// ---------------------------------------------------------------------------

const READONLY_BASH: &[&str] = &[
    "find",
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "grep",
    "rg",
    "fd",
    "file",
    "stat",
    "du",
    "df",
    "tree",
    "pwd",
    "which",
    "uname",
    "date",
    "sort",
    "uniq",
    "diff",
    "nl",
    "basename",
    "dirname",
    "realpath",
    "readlink",
    "md5sum",
    "sha256sum",
];
/// Read-only git subcommands allowed in plan mode.
const READONLY_GIT: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "tag",
    "remote",
    "blame",
    "shortlog",
    "describe",
    "ls-files",
    "rev-parse",
];

static RE_SHELL_CONTROL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

/// Redirection, pipes, chaining, command substitution, or a paren group make
/// a command non-inspection.
fn re_shell_control() -> &'static Regex {
    RE_SHELL_CONTROL.get_or_init(|| Regex::new(r#"[>|;&`\(]"#).expect("static regex"))
}

/// Would this shell command only inspect state? (The client's
/// `isReadOnlyCommand`, ported: no shell operators, and the first word is an
/// inspection tool — or `git` + a read-only subcommand.)
pub(crate) fn is_read_only_command(cmd: &str) -> bool {
    let cmd = cmd.trim();
    if cmd.is_empty() || re_shell_control().is_match(cmd) {
        return false;
    }
    let toks: Vec<&str> = cmd.split_whitespace().collect();
    let first = toks[0];
    if first == "git" {
        return toks.get(1).is_some_and(|s| READONLY_GIT.contains(s));
    }
    READONLY_BASH.contains(&first)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::State;

    fn fresh_state() -> S {
        static CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp =
            std::env::temp_dir().join(format!("ninfier-agent-tools-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        Arc::new(State::new(tmp.clone(), tmp, None))
    }

    /// Drive one pause/resume round-trip: the run pauses with a pending
    /// approval, the "client" resolves it, the waiter gets the outcome.
    async fn round_trip(
        decision: ApprovalDecision,
    ) -> (Option<String>, crate::agent::run::RunSnapshot) {
        let state = fresh_state();
        let shared = crate::agent::run::test_run(&state, "coder", &["bash"], None);
        let args = serde_json::json!({"command": "rm -rf /"});
        let s2 = shared.clone();
        let waiter = tokio::spawn(async move { await_approval(&s2, "bash", &args).await });
        let aid = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let snap = shared.snapshot();
                if snap.status == RunStatus::AwaitingApproval && !snap.pending_approvals.is_empty()
                {
                    return snap.pending_approvals[0].id.clone();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("run should pause with a pending approval");
        let tx = shared
            .approvals
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&aid)
            .expect("approval sender");
        tx.send(decision).expect("waiter alive");
        let out = waiter.await.expect("waiter joins");
        let snap = shared.snapshot();
        let _ = std::fs::remove_dir_all(state.data_dir.clone());
        (out, snap)
    }

    #[tokio::test]
    async fn approval_pause_approves_with_token() {
        let (out, snap) = round_trip(ApprovalDecision::Approved {
            token: Some("tok123".into()),
        })
        .await;
        assert_eq!(out.as_deref(), Some("tok123"));
        assert!(snap.pending_approvals.is_empty());
    }

    #[test]
    fn risky_patterns_mirror_client() {
        assert_eq!(
            detect_risky("git push --force origin main"),
            Some("force-pushes or deletes remote refs")
        );
        assert_eq!(detect_risky("git push"), Some("pushes commits to a remote"));
        assert_eq!(
            detect_risky("npm publish"),
            Some("publishes a package to a registry")
        );
        assert_eq!(detect_risky("cargo publish"), Some("publishes a crate"));
        assert_eq!(
            detect_risky("twine upload dist/*"),
            Some("uploads a release to PyPI")
        );
        assert_eq!(
            detect_risky("gh release create v1"),
            Some("creates a GitHub release/PR via gh")
        );
        assert_eq!(
            detect_risky("sudo rm -rf /"),
            Some("runs a command as another user (root)")
        );
        assert_eq!(
            detect_risky("ssh user@host"),
            Some("opens an SSH connection to a remote host")
        );
        assert_eq!(detect_risky("ssh-keygen -t ed25519"), None);
        assert_eq!(
            detect_risky("scp a b"),
            Some("transfers files to/from a remote host")
        );
        assert_eq!(detect_risky("docker ps"), Some("runs containers"));
        assert_eq!(
            detect_risky("kubectl apply -f x"),
            Some("applies infrastructure changes")
        );
        assert_eq!(
            detect_risky("aws s3 rm s3://b/k"),
            Some("mutates cloud resources")
        );
        assert_eq!(
            detect_risky("apt install foo"),
            Some("changes system packages")
        );
        assert_eq!(
            detect_risky("npm install -g foo"),
            Some("installs a global package")
        );
        assert_eq!(detect_risky("ls -la"), None);
        assert_eq!(detect_risky("cargo test"), None);
    }

    #[test]
    fn commit_guard_mirrors_client() {
        assert!(is_git_commit_command("git commit -m x"));
        assert!(is_git_commit_command("sudo git commit"));
        assert!(!is_git_commit_command("git status"));
        assert!(!is_git_commit_command("gitcommit"));
        assert!(!is_git_commit_command("echo commit"));
    }

    #[test]
    fn approved_match_mirrors_client() {
        let ap = vec!["git push".to_string()];
        assert!(is_approved_command("git  push", &ap));
        assert!(is_approved_command("git push origin", &ap));
        assert!(!is_approved_command("git pushy", &ap));
        assert!(!is_approved_command("git push", &[]));
    }

    /// A risky command pauses the run (AwaitingGate + snapshot pending
    /// gate) and a deny resolves it to a model denial error — nothing
    /// executes.
    #[tokio::test]
    async fn gate_risky_pause_denies_without_executing() {
        let state = fresh_state();
        let shared = crate::agent::run::test_run(&state, "coder", &["bash"], None);
        {
            let mut gs = shared.gate_state.lock().unwrap_or_else(|p| p.into_inner());
            gs.opts.risky = true;
        }
        state
            .agent_runs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(shared.meta.id.clone(), shared.clone());
        let st2 = state.clone();
        let s2 = shared.clone();
        let args = serde_json::json!({"command": "git push --force"});
        let waiter = tokio::spawn(async move { dispatch(&st2, &s2, "bash", &args).await });
        let gid = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let snap = shared.snapshot();
                if snap.status == RunStatus::AwaitingGate && snap.pending_gate.is_some() {
                    return snap.pending_gate.as_ref().unwrap().id.clone();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("run should pause on the risky gate");
        let resp = crate::agent::run::gate_decide(
            axum::extract::State(state.clone()),
            axum::extract::Path((shared.meta.id.clone(), gid)),
            axum::Json(crate::agent::run::GateDecideBody {
                decision: "deny".into(),
            }),
        )
        .await;
        drop(resp);
        let out = waiter.await.expect("waiter joins");
        assert!(
            out.get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .contains("denied by the user")
        );
        assert!(shared.snapshot().pending_gate.is_none());
        let _ = std::fs::remove_dir_all(state.data_dir.clone());
    }

    /// `once` proceeds past the gate (the command itself runs — `docker
    /// --version` is harmless and exits fast either way).
    #[tokio::test]
    async fn gate_risky_once_proceeds() {
        let state = fresh_state();
        let shared = crate::agent::run::test_run(&state, "coder", &["bash"], None);
        {
            let mut gs = shared.gate_state.lock().unwrap_or_else(|p| p.into_inner());
            gs.opts.risky = true;
        }
        state
            .agent_runs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(shared.meta.id.clone(), shared.clone());
        let st2 = state.clone();
        let s2 = shared.clone();
        let args = serde_json::json!({"command": "docker --version"});
        let waiter = tokio::spawn(async move { dispatch(&st2, &s2, "bash", &args).await });
        let gid = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let snap = shared.snapshot();
                if snap.pending_gate.is_some() {
                    return snap.pending_gate.as_ref().unwrap().id.clone();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("run should pause on the risky gate");
        crate::agent::run::gate_decide(
            axum::extract::State(state.clone()),
            axum::extract::Path((shared.meta.id.clone(), gid)),
            axum::Json(crate::agent::run::GateDecideBody {
                decision: "once".into(),
            }),
        )
        .await;
        let out = waiter.await.expect("waiter joins");
        assert!(
            out.get("error")
                .and_then(|v| v.as_str())
                .is_none_or(|e| !e.contains("denied by the user")),
            "{out}"
        );
        let _ = std::fs::remove_dir_all(state.data_dir.clone());
    }
    async fn approval_pause_denies_to_none() {
        let (out, snap) = round_trip(ApprovalDecision::Denied).await;
        assert_eq!(out, None);
        assert!(snap.pending_approvals.is_empty());
    }
}
