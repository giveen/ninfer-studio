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

use crate::agent::bash_guard::is_read_only_command;
use crate::agent::child_run::{delegate, subagent};
use crate::agent::gates::{
    ask_user, await_approval, await_gate, detect_risky, is_approved_command, is_git_commit_command,
};
use crate::agent::run::{AgentEvent, GateDecision, GateKind, RunShared};
use crate::coder::{browser, exec, fs, grep, memory, search, web};
use crate::engine::S;
use axum::Json;
use axum::extract::{Path as AxumPath, Query, State as AxumState};
use serde_json::{Value, json};
use std::sync::Arc;

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
    "memory_update",
    "memory_recall",
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
pub(crate) const SCOUT_FILTER_TOOLS: &[&str] = &[
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
pub(crate) const SCOUT_DEFAULT_TOOLS: &[&str] = &[
    "read",
    "grep",
    "glob",
    "ast_grep",
    "web_fetch",
    "web_search",
    "browser",
];
/// Chat-run scout default + filter set (ChatScreen's `readOnlyNames`).
pub(crate) const SCOUT_CHAT_TOOLS: &[&str] = &[
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
pub(crate) const SUBAGENT_TOOLS: &[&str] = &[
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
pub(crate) const IDEATION_SYSTEM: &str = r#"You are an IDEATION pass before implementation. Do NOT write any code and do NOT solve the task.
Identify the core difficulty, then list 2-4 genuinely distinct candidate approaches
(different algorithms/data structures/designs -- not variations of one idea),
noting a pitfall for each. Prose only, no code blocks, under 250 words."#;

/// Critic rubric (the client's `CRITIC_SYSTEM`, ported verbatim): review a
/// working-tree-vs-HEAD diff against the task and emit a VERDICT line.
pub(crate) const CRITIC_SYSTEM: &str = r#"You are a meticulous senior code reviewer. You are given a task and a unified diff (working tree vs HEAD). Decide whether the changes are acceptable.
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
            let mut payload = json!({ "learning": { "text": text, "kind": kind } });
            if let Some(scope) = run.scope_opt() {
                payload["workspace"] = json!(scope);
            }
            return match crate::coder::memory::memory_set(
                axum::extract::State(state.clone()),
                Json(payload),
            )
            .await
            {
                Ok(Json(res)) => {
                    json!({ "ok": true, "kind": kind, "learnings": res.get("learnings").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0) })
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
            let mem_res = crate::coder::memory::memory_get(
                axum::extract::State(state.clone()),
                axum::extract::Query(crate::coder::memory::MemQuery {
                    workspace: run.scope_opt().map(|s| s.to_string()),
                }),
            )
            .await;
            let mem = match mem_res {
                Ok(Json(v)) => v,
                Err((_, Json(e))) => return e,
            };
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::run::{ApprovalDecision, RunStatus};
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
                if let Some(gate) = &snap.pending_gate
                    && snap.status == RunStatus::AwaitingGate
                {
                    return gate.id.clone();
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
                if let Some(gate) = &snap.pending_gate {
                    return gate.id.clone();
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

    #[tokio::test]
    async fn approval_pause_denies_to_none() {
        let (out, snap) = round_trip(ApprovalDecision::Denied).await;
        assert_eq!(out, None);
        assert!(snap.pending_approvals.is_empty());
    }
}
