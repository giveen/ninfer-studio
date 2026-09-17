//! Child-run spawning — the server-side `delegate` (scout) and `subagent`
//! (worker) tools, plus the critic review loop and git-diff plumbing.
//!
//! All of this was previously inline in `tools.rs`; separating it keeps the
//! dispatch table focused and lets the critic/subagent machinery be read and
//! tested in isolation.

use crate::agent::gates::run_depth;
use crate::agent::run::{AgentEvent, RunShared, RunStatus, now_ms};
use crate::agent::tools::{
    CRITIC_SYSTEM, IDEATION_SYSTEM, SCOUT_CHAT_TOOLS, SCOUT_DEFAULT_TOOLS, SCOUT_FILTER_TOOLS,
    SCOUT_SYSTEM, SUBAGENT_TOOLS, WORKER_SYSTEM,
};
use crate::engine::S;
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// delegate (read-only scout)
// ---------------------------------------------------------------------------

pub(crate) async fn delegate(state: &S, run: &Arc<RunShared>, args: &Value) -> Value {
    let task = args
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if task.is_empty() {
        return json!({ "error": "task is required" });
    }
    if run_depth(state, run) > 5 {
        return json!({ "error": "maximum subagent depth 5 exceeded" });
    }
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

// ---------------------------------------------------------------------------
// subagent (implementation worker with critic loop)
// ---------------------------------------------------------------------------

pub(crate) async fn subagent(state: &S, parent: &Arc<RunShared>, args: &Value) -> Value {
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

    let pre = git_tree(parent.scope_opt().as_deref()).await;
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
        diff = net_diff(parent.scope_opt().as_deref(), pre.as_deref())
            .await
            .unwrap_or_default();
        let Some(spec) = critic.as_ref().filter(|_| !diff.trim().is_empty()) else {
            res_ok = true;
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
    let ok = res_ok && critic_approved != Some(false);
    json!({ "summary": summary, "diff": diff, "ok": ok, "criticApproved": critic_approved })
}

// ---------------------------------------------------------------------------
// spawn_child — the shared machinery for scout and worker runs
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub(crate) async fn spawn_child(
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
        extra_headers: parent.meta.extra_headers.clone(),
        allow_fallback: parent.meta.allow_fallback,
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
        user_todo_rev: 0,
        todo_base_rev: 0,
    };

    let child = crate::agent::run::spawn_run(state, meta, live);
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
    let _ = parent.tx.send(AgentEvent::ChildRun {
        id: run_id.clone(),
        kind: kind.to_string(),
        task: prompt.chars().take(100).collect(),
    });

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
// Critic + git diff plumbing
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

async fn git_tree(scope: Option<&str>) -> Option<String> {
    git_run(scope, &["write-tree"], 10)
        .await
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn net_diff(scope: Option<&str>, pre: Option<&str>) -> Option<String> {
    let post = git_tree(scope).await?;
    let pre = pre.filter(|p| *p != post)?;
    git_run(scope, &["--no-pager", "diff", pre, &post], 60)
        .await
        .map(|s| s.chars().take(60_000).collect())
}

const CRITIC_SYSTEM_TEXT: &str = CRITIC_SYSTEM;

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
        .unwrap_or_else(|| CRITIC_SYSTEM_TEXT.to_string());
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
    RE_VERDICT.get_or_init(|| Regex::new("(?i)VERDICT:\\s*APPROVED").expect("static regex"))
}

static RE_VERDICT_TOKEN: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
fn re_verdict_token() -> &'static Regex {
    RE_VERDICT_TOKEN.get_or_init(|| {
        Regex::new(r"(?i)VERDICT:\s*(?:APPROVED|CHANGES_REQUESTED)\s*").expect("static regex")
    })
}

static RE_LEARNING: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
fn re_learning() -> &'static Regex {
    RE_LEARNING.get_or_init(|| Regex::new(r"(?im)^\*?\s*LEARNING:\s*(.+)$").expect("static regex"))
}

static RE_AVOID: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
fn re_avoid() -> &'static Regex {
    RE_AVOID.get_or_init(|| Regex::new(r"(?im)^\*?\s*AVOID:\s*(.+)$").expect("static regex"))
}

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

// ---------------------------------------------------------------------------
// scope_opt helper (needed here to avoid circular import with tools.rs)
// ---------------------------------------------------------------------------

trait RunScopeExt {
    fn scope_opt(&self) -> Option<String>;
}

impl RunScopeExt for Arc<RunShared> {
    fn scope_opt(&self) -> Option<String> {
        let live = self.live.lock().unwrap_or_else(|p| p.into_inner());
        live.scope.clone()
    }
}
