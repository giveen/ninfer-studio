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
use axum::extract::{Path as AxumPath, Query};
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

/// Worker child-run system prompt — the server port of the client's
/// `WORKER_SYSTEM`. The harness owns the worker contract, so it lives with
/// the loop, not the webview.
pub(crate) const WORKER_SYSTEM: &str = r#"You are an autonomous implementation worker inside NInfer Studio's Coder. You
implement a concrete coding task end-to-end: you read the codebase, edit real files,
run commands and tests, and iterate until the task is done and verified.

Rules:
- Work autonomously with no human available to answer questions. If the request
  is ambiguous, pick the most reasonable interpretation and state the assumption
  in one line in your final summary.
- Keep the change tight: the minimal, well-structured edit that satisfies the
  task. No speculative refactors, no drive-by cleanups, no extra features.
- Prefer existing patterns: match the codebase's conventions (naming, file
  layout, error handling) instead of introducing new styles.
- Verify before declaring done: compile/build, run the relevant tests, and fix
  what they surface. Do not claim success you have not verified.
- Do NOT call: ask_user (never pause for the human), git_commit / git_branch /
  git_worktree (the supervisor owns version control), subagent (no nested
  implementation subagents), or todo_write.
- When you are done, your final message must be a short plain-text summary:
  what changed (files), how you verified it, and any assumptions or caveats.
  No code blocks in the summary unless a short snippet is genuinely needed."#;

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
            let mut live = run.live.lock().unwrap_or_else(|p| p.into_inner());
            live.todo = Some(args.clone());
            let _ = run.tx.send(AgentEvent::Todo { items: args.clone() });
            return json!({ "ok": true });
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
                requested
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
            const CHUNK: usize = 16_384;
            let end = (offset + CHUNK).min(text.len());
            // Back off to a char boundary.
            let mut end = end;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            let next = if end < text.len() { Some(end) } else { None };
            let chunk = text.get(offset..end).unwrap_or("");
            return json!({ "chunk": chunk, "nextOffset": next, "eof": next.is_none() });
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
                .map(|t| (if t.starts_with('-') { t.clone() } else { q(t) }))
                .collect::<Vec<_>>()
                .join(" ");
            let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("Agent commit").to_string();
            let mut body = json!({ "command": format!("git add {file_args} && git commit -m {} && git rev-parse HEAD", q(&message)) });
            if let Some(scope) = run.scope_opt() {
                body["cwd"] = json!(scope);
                body["workspace"] = json!(scope);
            }
            return flatten(exec::exec(state.clone(), Json(body)).await);
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
            return flatten(exec::exec(state.clone(), Json(body)).await);
        }
        _ => {}
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
    if mcp_name(name).is_none() && family.iter().all(|f| f != name) {
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
        return flatten(crate::mcp::mcp_call(state.clone(), Json(req)).await);
    }
    let res: Result<Value, (axum::http::StatusCode, Json<Value>)> = match name {
        "read" => fs::fs_read(state.clone(), Json(body.clone())).await.map(|j| j.0),
        "write" => fs::fs_write(state.clone(), Json(body.clone())).await.map(|j| j.0),
        "edit" => fs::fs_edit(state.clone(), Json(body.clone())).await.map(|j| j.0),
        "apply_patch" => fs::fs_patch(state.clone(), Json(body.clone())).await.map(|j| j.0),
        "grep" => grep::grep(state.clone(), Json(body.clone())).await.map(|j| j.0),
        "glob" => grep::glob(state.clone(), Json(body.clone())).await.map(|j| j.0),
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
            fs::tree(state.clone(), Query(q)).await.map(|j| j.0)
        }
        "bash" => exec::exec(state.clone(), Json(body.clone())).await.map(|j| j.0),
        "bash_poll" => {
            let id = body.get("jobId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            exec::job_get(state.clone(), AxumPath(id)).await.map(|j| j.0)
        }
        "git_diff" => search::diff(
            state.clone(),
            Query(search::WsQuery { workspace: body.get("workspace").and_then(|v| v.as_str()).map(String::from) }),
        )
        .await
        .map(|j| j.0),
        "repo_search" => search::search(
            state.clone(),
            Query(search::SearchQuery {
                q: body.get("query").and_then(|v| v.as_str()).map(String::from),
                limit: body.get("limit").and_then(|v| v.as_u64()),
                workspace: body.get("workspace").and_then(|v| v.as_str()).map(String::from),
            }),
        )
        .await
        .map(|j| j.0),
        "repo_map" => search::repo_map(
            state.clone(),
            Query(search::WsQuery { workspace: body.get("workspace").and_then(|v| v.as_str()).map(String::from) }),
        )
        .await
        .map(|j| j.0),
        "web_fetch" => web::web_fetch(state.clone(), Json(body.clone())).await.map(|j| j.0),
        "web_search" => web::web_search(state.clone(), Json(body.clone())).await.map(|j| j.0),
        "browser" => browser::browser(state.clone(), Json(body.clone())).await.map(|j| j.0),
        "memory" => memory::memory_get(state.clone(), Json(body.clone())).await.map(|j| j.0),
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

async fn delegate(state: &S, parent: &Arc<RunShared>, args: &Value) -> Value {
    spawn_child(state, parent, "delegate", "scout", args, DELEGATE_TOOLS, DELEGATE_TOOLS, 6, Some(SCOUT_SYSTEM.into())).await
}

async fn subagent(state: &S, parent: &Arc<RunShared>, args: &Value) -> Value {
    spawn_child(state, parent, "subagent", "worker", args, SUBAGENT_TOOLS, SUBAGENT_TOOLS, 24, Some(WORKER_SYSTEM.into())).await
}

/// Spawn a child run (server-side `delegate`/`subagent`) and wait for its
/// terminal state. The child is a first-class run — it shows up in the
/// registry and any client can attach to watch it.
async fn spawn_child(
    state: &S,
    parent: &Arc<RunShared>,
    tool: &str,
    kind: &str,
    args: &Value,
    allowed: &[&str],
    default_set: &[&str],
    default_steps: usize,
    system: Option<String>,
) -> Value {
    let task = args.get("task").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if task.is_empty() {
        return json!({ "error": "task is required" });
    }

    // Model-supplied allow-list filtered against the role's set (mirrors the
    // client's filterToolAllowList: nothing survives → the default set).
    let allowed_set: HashSet<&str> = allowed.iter().copied().collect();
    let requested: Vec<String> = args
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let filtered: Vec<String> = requested.into_iter().filter(|t| allowed_set.contains(t.as_str())).collect();
    let tool_names: Vec<String> = if filtered.is_empty() {
        default_set.iter().map(|s| s.to_string()).collect()
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
        label: format!("{tool}: {}", task.chars().take(60).collect::<String>()),
        model,
        system,
        max_steps,
        created_at: now_ms(),
        tool_set: parent.meta.tool_set.clone(),
        tool_names,
        tools_spec: Value::Array(tools_spec),
        params: parent.meta.params.clone(),
        parent: Some(parent.meta.id.clone()),
    };
    let live = crate::agent::run::RunLive {
        status: RunStatus::Running,
        messages: vec![json!({ "role": "user", "content": task })],
        turns: 0,
        updated_at: now_ms(),
        finish_reason: None,
        error: None,
        stop: None,
        pending_approvals: vec![],
        user_question: None,
        todo: None,
        scope: parent.scope_opt(),
        usage: Default::default(),
        last_meta: None,
    };

    let child = crate::agent::run::spawn_run(state.clone(), meta, live);
    let run_id = child.meta.id.clone();

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
        "summary": last,
    })
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
