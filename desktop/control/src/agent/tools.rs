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

use crate::agent::run::{now_ms, AgentEvent, ApprovalDecision, PendingApproval, PendingQuestion, RunShared, RunStatus};
use crate::coder::{browser, exec, fs, grep, memory, search, web};
use crate::engine::S;
use axum::extract::{Path as AxumPath, Query, State as AxumState};
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::oneshot;

/// Tools the server can dispatch in-process (per tool-set). Anything else
/// gets the same "unknown tool" error the client's registry returned.
const CODER_TOOLS: &[&str] = &[
    "read", "write", "edit", "apply_patch", "grep", "glob", "tree", "bash", "bash_poll",
    "git_diff", "git_commit", "ast_grep", "repo_search", "repo_map", "web_fetch", "web_search",
    "browser", "memory", "obs_recall", "delegate", "subagent",
];
const CHAT_TOOLS: &[&str] = &[
    "read", "write", "edit", "apply_patch", "grep", "glob", "tree", "bash", "bash_poll",
    "git_diff", "ast_grep", "repo_search", "web_fetch", "web_search", "browser",
    "set_directory", "memory_update", "memory_recall", "ask_user", "todo_write", "obs_recall",
    "delegate",
];

/// Read-only set for `delegate` child runs (mirrors the client's
/// READONLY_TOOL_NAMES, server-dispatchable subset).
const DELEGATE_TOOLS: &[&str] = &[
    "read", "grep", "glob", "ast_grep", "web_fetch", "web_search", "git_diff", "repo_search",
    "browser", "obs_recall", "bash_poll",
];

/// Scout child-run system prompt — the read-only investigation contract.
pub(crate) const SCOUT_SYSTEM: &str = r#"You are a read-only investigation worker (scout) inside NInfer Studio's Coder.
Map the code the supervisor needs before it commits to a plan: read files,
grep/glob/search the repo, fetch web docs, and run read-only inspection
commands. You must NOT modify anything — no writes, edits, patches, git
writes, or destructive commands.

Work autonomously: if the task is ambiguous, pick the most reasonable
interpretation and note it in one line.

Finish with a concise plain-text report: the findings the supervisor needs
(file:line references, exact APIs/conventions, command outputs), ordered by
importance. No preamble, no restating the task."#;
/// Implementation set for `subagent` child runs (mirrors WORKER_TOOL_NAMES).
const SUBAGENT_TOOLS: &[&str] = &[
    "read", "grep", "glob", "ast_grep", "web_fetch", "web_search", "browser", "repo_search",
    "write", "edit", "apply_patch", "bash", "bash_poll", "git_diff", "delegate",
];

/// Worker child-run system prompt — the verbatim port of the client's
/// `WORKER_SYSTEM`; the harness owns the worker contract, so it lives with
/// the loop, not the webview.
pub(crate) const WORKER_SYSTEM: &str = r#"You are a focused implementation subagent inside a coding harness. You are given ONE self-contained task and must implement it in the shared workspace.
- Read, search, and edit files with your tools. You MAY run shell commands (bash) to build, test, and verify.
- Do NOT call: ask_user (never pause for the human), git_commit / git_branch / git_worktree (the supervisor owns version control), subagent (no nested implementation subagents), or todo_write.
- Make reasonable decisions and proceed; never ask the user for input. If the task is ambiguous, pick the most sensible interpretation and note it in your summary.
- If your task says to try a different approach or fix a reviewer's rejection by rethinking the design, write a FRESH implementation for that approach instead of incrementally patching the stuck one — a patched-over wrong approach is usually worse than a clean rewrite.
- When the task is complete, STOP calling tools and reply with a concise summary: what you changed, the files touched, and any build/test commands you ran.
- Stay strictly scoped to the assigned task."#;

/// Fresh-context brainstorm before any code is written (the client's
/// ideation pass, ported verbatim).
const IDEATION_SYSTEM: &str = r#"You are a design brainstorm for a coding task. Do NOT write any code yet.
Given the task below, propose 3-5 genuinely distinct candidate implementation approaches.
For each approach: one line naming the approach, then 1-2 lines on its trade-offs or pitfalls.
Do not recommend one yet — the implementer picks. Be concrete and technical, no filler.

Task:"#;

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
            let items = crate::agent::run::clean_todo_items(args.get("todos").unwrap_or(&Value::Null));
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
            let _ = run.tx.send(AgentEvent::Todo { items: Value::Array(items.clone()) });
            return json!({ "success": true, "count": items.len() });
        }
        "set_directory" => {
            let requested = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
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
            let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let text = run.recall.lock().unwrap_or_else(|p| p.into_inner()).get(&id).cloned();
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
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
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
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_lowercase();
            let kind = args.get("kind").and_then(|v| v.as_str());
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10).clamp(1, 30) as usize;
            let mem = crate::chat::memory_get(axum::extract::State(state.clone())).await.0;
            let learnings = mem.get("learnings").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let mut matches: Vec<Value> = learnings
                .into_iter()
                .filter(|l| {
                    let kind_ok = kind.map(|k| l.get("kind").and_then(|v| v.as_str()) == Some(k)).unwrap_or(true);
                    let text = l.get("text").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
                    let task = l.get("task").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
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
            let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("Agent commit").to_string();
            let mut body = json!({ "command": format!("git add {file_args} && git commit -m {} && git rev-parse HEAD", q(&message)) });
            if let Some(scope) = run.scope_opt() {
                body["cwd"] = json!(scope);
                body["workspace"] = json!(scope);
            }
            return flatten(exec::exec(AxumState(state.clone()), Json(body)).await);
        }
        "ast_grep" => {
            // Same invocation the client made through exec: `sg -p '…' -l lang`.
            let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let lang = args.get("lang").and_then(|v| v.as_str()).unwrap_or("rust").to_string();
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
        const MUTATING: &[&str] = &["write", "edit", "apply_patch", "git_commit", "git_branch", "git_worktree", "subagent"];
        if name == "bash" {
            let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();
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
            perms.get(&scope).unwrap_or(&crate::coder::CoderPerms::default()),
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

    // --- scope injection + dispatch -------------------------------------
    inject_scope(run, name, &mut body);
    if let Some(t) = token {
        body["approvalToken"] = json!(t);
    }

    // MCP tools are namespaced (`mcp__<server>__<tool>`) and always
    // endpoint-dispatchable; everything else must be in the tool-set's table.
    let family = if run.meta.tool_set == "chat" { CHAT_TOOLS } else { CODER_TOOLS };
    if mcp_name(name).is_none() && family.iter().all(|f| *f != name) {
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
        "read" | "write" | "edit" | "apply_patch" | "grep" | "glob" | "tree" | "memory" => {
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
        "repo_search" | "repo_map" | "git_diff" | "web_fetch" | "web_search" | "browser" => {
            if body.get("workspace").map(|v| v.is_null()).unwrap_or(true) {
                body["workspace"] = json!(scope);
            }
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
        "read" => fs::fs_read(AxumState(state.clone()), Json(body.clone())).await.map(|j| j.0),
        "write" => fs::fs_write(AxumState(state.clone()), Json(body.clone())).await.map(|j| j.0),
        "edit" => fs::fs_edit(AxumState(state.clone()), Json(body.clone())).await.map(|j| j.0),
        "apply_patch" => fs::fs_patch(AxumState(state.clone()), Json(body.clone())).await.map(|j| j.0),
        "grep" => grep::grep(AxumState(state.clone()), Json(body.clone())).await.map(|j| j.0),
        "glob" => grep::glob(AxumState(state.clone()), Json(body.clone())).await.map(|j| j.0),
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
            fs::tree(AxumState(state.clone()), Query(q)).await.map(|j| j.0)
        }
        "bash" => exec::exec(AxumState(state.clone()), Json(body.clone())).await.map(|j| j.0),
        "bash_poll" => {
            let id = body.get("jobId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            exec::job_get(AxumState(state.clone()), AxumPath(id)).await.map(|j| j.0)
        }
        "git_diff" => search::diff(
            AxumState(state.clone()),
            Query(search::WsQuery { workspace: body.get("workspace").and_then(|v| v.as_str()).map(String::from) }),
        )
        .await
        .map(|j| j.0),
        // `search` is non-Result (it degrades to empty results) — wrap.
        "repo_search" => Ok(
            search::search(
                AxumState(state.clone()),
                Query(search::SearchQuery {
                    q: body.get("query").and_then(|v| v.as_str()).map(String::from),
                    limit: body.get("limit").and_then(|v| v.as_u64()),
                    workspace: body.get("workspace").and_then(|v| v.as_str()).map(String::from),
                }),
            )
            .await
            .0,
        ),
        "repo_map" => search::repo_map(
            AxumState(state.clone()),
            Query(search::WsQuery { workspace: body.get("workspace").and_then(|v| v.as_str()).map(String::from) }),
        )
        .await
        .map(|j| j.0),
        "web_fetch" => web::web_fetch(AxumState(state.clone()), Json(body.clone())).await.map(|j| j.0),
        "web_search" => web::web_search(AxumState(state.clone()), Json(body.clone())).await.map(|j| j.0),
        "browser" => browser::browser(AxumState(state.clone()), Json(body.clone())).await.map(|j| j.0),
        "memory" => memory::memory_get(
            AxumState(state.clone()),
            Query(memory::MemQuery {
                workspace: body.get("workspace").and_then(|v| v.as_str()).map(String::from),
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
    let preview: String = serde_json::to_string(args).unwrap_or_default().chars().take(400).collect();

    let (tx, rx) = oneshot::channel();
    run.approvals.lock().unwrap_or_else(|p| p.into_inner()).insert(aid.clone(), tx);
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
        "read" | "write" | "edit" | "apply_patch" | "memory" => get("path"),
        "grep" | "glob" => get("pattern"),
        "web_fetch" | "browser" => get("url"),
        "web_search" | "repo_search" => get("query"),
        "bash" | "ast_grep" | "git_commit" => get("command").or_else(|| get("pattern")).or_else(|| get("message")),
        _ => None,
    }
}

/// The `ask_user` tool: pause the run for a human answer. The answer becomes
/// the tool result. (The client used to render its own prompt; now any
/// attached client can — the run survives either way.)
async fn ask_user(run: &Arc<RunShared>, args: &Value) -> Value {
    let question = args.get("question").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
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
    let _ = run.tx.send(AgentEvent::UserQuestionRequested { id: qid.clone(), question: question.clone() });

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
// Child runs: delegate (read-only) / subagent (implementation worker)
// ---------------------------------------------------------------------------

async fn delegate(state: &S, run: &Arc<RunShared>, args: &Value) -> Value {
    let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if task.is_empty() {
        return json!({ "error": "task is required" });
    }
    // The client's exact scout seed (the task is wrapped the same way).
    let prompt = format!("Task: {task}\n\nYou are a read-only subagent. Investigate and reply with a concise summary. Do not write code.");
    spawn_child(state, run, "delegate", "scout", &prompt, DELEGATE_TOOLS, 6, args).await
}

async fn subagent(state: &S, parent: &Arc<RunShared>, args: &Value) -> Value {
    let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if task.is_empty() {
        return json!({ "error": "task is required" });
    }
    let wmodel = args
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|m| !m.is_empty())
        .map(String::from)
        .unwrap_or_else(|| parent.meta.model.clone());

    // Baseline tree for the net diff across every worker attempt (the blob
    // tree of the working tree, captured before the first worker runs).
    let pre = git_tree(parent.scope_opt()).await;
    // Fresh-context brainstorm before any code is written (best-effort — an
    // empty result just means the worker proceeds without ideation notes).
    let ideation = crate::agent::engine_loop::chat_once(
        &parent.client,
        state,
        &wmodel,
        IDEATION_SYSTEM,
        &task,
        Some(0.7),
        Some(500),
        std::time::Duration::from_secs(30),
    )
    .await
    .unwrap_or_default()
    .trim()
    .to_string();

    // Worker → critic fix loop (the client's MAX_WORKER_CRIT=2 retries).
    // `critic_approved` is tri-state: None = the critic never actually
    // reviewed anything (spec off, or every attempt had an empty diff) —
    // distinct from an explicit rejection.
    let critic = parent
        .meta
        .critic
        .clone()
        .filter(|c| {
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
            prompt = format!("TASK (implement now):\n{task}\n\n## Critic review of your previous attempt (address every issue listed before re-attempting):\n{critique}");
        }
        let res = spawn_child(state, parent, "subagent", "worker", &prompt, SUBAGENT_TOOLS, 12, args).await;
        summary = res["summary"].as_str().unwrap_or_default().to_string();
        res_ok = res["ok"].as_bool().unwrap_or(false);
        exhausted = res["stop"].as_str() == Some("steps");
        // Net diff across attempts (git write-tree before/after) — the critic
        // reviews the working-tree diff, not the worker's self-report.
        diff = net_diff(parent.scope_opt(), pre.as_deref()).await.unwrap_or_default();
        // No critic spec (or an empty diff) → no review gate for this attempt.
        let Some(spec) = critic.as_ref().filter(|_| !diff.trim().is_empty()) else {
            break;
        };
        match run_critic(state, parent, spec, &diff, &task).await {
            Ok((approved, issues, learnings)) => {
                persist_learnings(state, parent, &learnings, if approved { "critic:approve" } else { "critic:reject" }, &task).await;
                critic_approved = Some(approved);
                if approved || attempt == MAX_WORKER_CRIT || issues == prev_critique {
                    // Approved, budget spent, or the same issues raised again
                    // — the worker is not converging, stop retries early.
                    break;
                }
                prev_critique = issues.clone();
                critique = issues;
            }
            // Fail-open: a critic error never blocks the run.
            Err(_) => break,
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
/// message; the child's tool allow-list / maxSteps / model come from the
/// caller's args (model-supplied lists filtered against `allowed`).
async fn spawn_child(
    state: &S,
    parent: &Arc<RunShared>,
    tool: &str,
    kind: &str,
    prompt: &str,
    allowed: &[&str],
    default_steps: usize,
    args: &Value,
) -> Value {
    // Model-supplied allow-list filtered against the role's set (mirrors the
    // client's filterToolAllowList: nothing survives → the role's set).
    let allowed_set: HashSet<&str> = allowed.iter().copied().collect();
    let requested: Vec<String> = args
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let filtered: Vec<String> = requested.into_iter().filter(|t| allowed_set.contains(t.as_str())).collect();
    let tool_names: Vec<String> = if filtered.is_empty() {
        allowed.iter().map(|s| s.to_string()).collect()
    } else {
        filtered
    };

    // Child tool specs: the parent's offered specs, narrowed to the child's
    // names. (The client built these the same way from its TOOLS table.)
    let mut tools_spec = Vec::new();
    if let Some(arr) = parent.meta.tools_spec.as_array() {
        for t in arr {
            if let Some(n) = t.get("function").and_then(|f| f.get("name")).and_then(|v| v.as_str()) {
                if tool_names.iter().any(|x| x == n) {
                    tools_spec.push(t.clone());
                }
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
        state.bg_job_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    let meta = crate::agent::run::RunMeta {
        id: id.clone(),
        kind: kind.into(),
        label: format!("{tool}: {}", prompt.chars().take(60).collect::<String>()),
        model,
        system: if kind == "worker" { Some(WORKER_SYSTEM.to_string()) } else { Some(SCOUT_SYSTEM.to_string()) },
        max_steps,
        created_at: now_ms(),
        tool_set: parent.meta.tool_set.clone(),
        tool_names,
        tools_spec: Value::Array(tools_spec),
        params: parent.meta.params.clone(),
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
    c.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    let out = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), c.output())
        .await
        .ok()??;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The blob tree of the working tree (`git write-tree`) — the baseline for
/// the net worker diff.
fn git_tree_now(scope: Option<&str>) -> impl std::future::Future<Output = Option<String>> + Send {
    async move {
        git_run(scope, &["write-tree"], 10)
            .await
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
}

async fn git_tree(scope: Option<&str>) -> Option<String> {
    git_tree_now(scope).await
}

/// Net diff across the worker attempts (`git diff preTree postTree`, capped
/// at 60k chars — the same capture the client made).
async fn net_diff(scope: Option<&str>, pre: Option<&str>) -> Option<String> {
    let post = git_tree(scope).await?;
    let pre = pre.filter(|p| *p != &post)?;
    git_run(scope, &["--no-pager", "diff", pre, &post], 60)
        .await
        .map(|s| s.chars().take(60_000).collect())
}

/// One critic pass: review the diff against the task, parse the VERDICT line
/// + LEARNING/AVOID lines. Fail-open at the call site (an error never blocks
/// the run — the client's critic errored into an approval).
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
        &system,
        &prompt,
        None,
        Some(2048),
        std::time::Duration::from_secs(90),
    )
    .await?;
    let approved = re_verdict().is_match(&content);
    // Pull learnings out of the raw text first so they don't bleed into
    // `issues` (the rest of the reply, verdict line stripped).
    let mut learnings: Vec<(String, String)> = Vec::new();
    let mut kept: Vec<String> = Vec::new();
    for raw in content.lines() {
        let line = raw.trim();
        let learn = line.strip_prefix("LEARNING:").map(str::trim);
        let avoid = line.strip_prefix("AVOID:").map(str::trim);
        match (learn, avoid) {
            (Some(t), _) if !t.is_empty() => learnings.push(("success".into(), t.to_string())),
            (None, Some(t)) if !t.is_empty() => learnings.push(("avoid".into(), t.to_string())),
            _ => kept.push(raw.to_string()),
        }
    }
    let issues = kept
        .join("\n")
        .replace(&re_verdict().find(&kept.join("\n")).map(|m| m.as_str()).unwrap_or_default().to_string(), "")
        .trim()
        .to_string();
    Ok((approved, issues, learnings))
}

static RE_VERDICT: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

fn re_verdict() -> &'static Regex {
    // Case-insensitive via regex flags — the client tested /VERDICT:\s*APPROVED/i.
    RE_VERDICT.get_or_init(|| Regex::new(?is"VERDICT:\s*APPROVED").expect("static regex"))
}

/// Persist critic/agent learnings to the per-repo memory store (in-process
/// call of the same handler the HTTP route uses). A failure on one learning
/// never breaks the run loop.
async fn persist_learnings(state: &S, run: &Arc<RunShared>, learnings: &[(String, String)], provenance: &str, task: &str) {
    for (kind, text) in learnings {
        let mut body = json!({
            "learning": { "text": text, "kind": kind },
            "provenance": provenance,
            "task": task,
        });
        if let Some(scope) = run.scope_opt() {
            body["workspace"] = json!(scope);
        }
        let _ = crate::coder::memory::memory_set(axum::extract::State(state.clone()), axum::Json(body)).await;
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
    "find", "ls", "cat", "head", "tail", "wc", "grep", "rg", "fd", "file", "stat", "du", "df", "tree", "pwd",
    "which", "uname", "date", "sort", "uniq", "diff", "nl", "basename", "dirname", "realpath", "readlink",
    "md5sum", "sha256sum",
];
/// Read-only git subcommands allowed in plan mode.
const READONLY_GIT: &[&str] = &[
    "status", "log", "diff", "show", "branch", "tag", "remote", "blame", "shortlog", "describe", "ls-files",
    "rev-parse",
];

static RE_SHELL_CONTROL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

/// Redirection, pipes, chaining, command substitution, or a paren group make
/// a command non-inspection.
fn re_shell_control() -> &'static Regex {
    RE_SHELL_CONTROL
        .get_or_init(|| Regex::new(r#"[>|;&`\(]"#).expect("static regex"))
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
