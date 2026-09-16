//! Run registry, snapshot types, and the `/api/agent/*` HTTP endpoints.
//!
//! A **run** is one bounded agent loop (the server port of the webview's
//! `runToolLoop`): an initial transcript + an engine streaming loop that
//! dispatches tools in-process. Runs live in `State.agent_runs` and keep
//! going while no client is attached — closing a window only detaches its
//! SSE subscription, it never kills the run.

use crate::agent::engine_loop;
use crate::engine::S;
use axum::extract::{Path, State as AxumState};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get as get_route, post as post_route};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};
use tokio::sync::{broadcast, oneshot, watch};

/// Soft ceiling on concurrent non-terminal runs. The engine already caps
/// real generation via maxConcurrency; this just stops a runaway fan-out
/// (deep research x many tabs) from pinning this process's memory.
pub(crate) const MAX_CONCURRENT_RUNS: usize = 16;

/// SSE event payload — one JSON object per server-sent event, `type`-tagged.
/// Clients attach at any time; the first frame is always a `state` snapshot
/// (see [`events`]), so a late client never starts blind.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// Full run snapshot, sent first on every SSE connection.
    State {
        snapshot: Box<RunSnapshot>,
    },
    /// Streaming assistant content delta (kind: "content" or "reasoning").
    Delta {
        kind: &'static str,
        text: String,
    },
    /// A new assistant turn is about to stream (turn index).
    TurnStarted {
        turns: usize,
    },
    /// Transcript append: the assistant message, or one tool result.
    Appended {
        message: Value,
        turns: usize,
    },
    /// A tool call the model asked for (before dispatch).
    ToolCall {
        id: String,
        name: String,
        args: String,
    },
    /// A tool finished (result truncated for the event stream; the full
    /// result lives in the transcript).
    ToolResult {
        id: String,
        name: String,
        preview: String,
        error: bool,
    },
    /// An `ask`-tier tool paused the run; a client should show its dialog.
    ApprovalRequested {
        id: String,
        tool: String,
        rel: Option<String>,
        args: String,
    },
    ApprovalResolved {
        id: String,
        approved: bool,
    },
    /// The `ask_user` tool paused the run for a human answer.
    UserQuestionRequested {
        id: String,
        question: String,
    },
    UserQuestionAnswered {
        id: String,
        answer: String,
    },
    /// Paused at a turn end for a client's turn-hook decision (the run is
    /// in `awaiting_hook` status; the pending decision's id is here).
    HookRequested {
        id: String,
        /// Turns completed so far (the turn just finished).
        turns: usize,
        finish_reason: Option<String>,
        /// Whether the turn just finished made tool calls.
        had_tool_calls: bool,
        /// The client's compaction gate needs a token estimate of the next
        /// request (the server's last request size / ~4 chars-per-token).
        est_tokens: u64,
    },
    HookResolved {
        id: String,
        action: String,
    },
    /// A child run (`delegate`/`subagent`) was spawned; clients can attach
    /// to it for live progress.
    ChildRun {
        id: String,
        kind: String,
        task: String,
    },
    /// The `todo_write` tool updated the run's todo list.
    Todo {
        items: Value,
    },
    Status {
        status: RunStatus,
    },
    /// Terminal: the loop finished (done/steps), errored, or was stopped.
    Done {
        stop: Option<String>,
        status: RunStatus,
    },
    /// Loop error message (the run has moved to `error` status).
    Error {
        message: String,
    },
    /// A risky shell command paused the run (risky gate); a client should
    /// show its allow/deny dialog.
    GateRequested {
        id: String,
        kind: GateKind,
        command: String,
        reason: Option<String>,
    },
    GateResolved {
        id: String,
        kind: GateKind,
        decision: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    AwaitingApproval,
    AwaitingUser,
    /// Paused at a turn end for a client's turn-hook decision (humanize /
    /// verify-critic gates / compaction).
    AwaitingHook,
    /// Paused on a risky/commit gate for a client's allow/deny decision.
    AwaitingGate,
    Done,
    Stopped,
    Error,
}

impl RunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Stopped | Self::Error)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingApproval {
    pub id: String,
    pub tool: String,
    pub rel: Option<String>,
    pub args: String,
    pub asked_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingQuestion {
    pub id: String,
    pub question: String,
    pub asked_at: u64,
}

/// What the waiting loop is handed when a client resolves an approval.
#[derive(Debug, Clone)]
pub enum ApprovalDecision {
    Approved { token: Option<String> },
    Denied,
}
/// Which human gate paused the run: a risky shell command, or a git commit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateKind {
    Risky,
    Commit,
}

/// A pending risky/commit pause, surfaced on the snapshot so a polling
/// client can show its dialog without holding an SSE subscription.
#[derive(Debug, Clone, Serialize)]
pub struct PendingGate {
    pub id: String,
    pub kind: GateKind,
    pub command: String,
    pub reason: Option<String>,
}

/// What the waiting dispatch is handed when a client resolves a gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    Once,
    /// Run it and remember the (normalized) command for the rest of the run.
    Remember,
    /// Don't run it — the tool returns a denial error to the model.
    Deny,
}

/// Per-run human-gate config (the client's risky/commit gates, ported).
/// Cloned from the parent for child runs; `approved` grows on `remember`.
#[derive(Debug, Clone, Default)]
pub struct GateOpts {
    pub risky: bool,
    pub commit: bool,
    pub approved: Vec<String>,
}

/// Gate config + at most one in-flight pause. One field (not two) so the
/// half-dozen RunShared construction sites grow by a single line.
#[derive(Debug, Default)]
pub struct GateState {
    pub opts: GateOpts,
    pub slot: Option<GateSlot>,
}

/// An in-flight gate pause: what the client must decide, and the channel
/// the decision wakes.
#[derive(Debug)]
pub struct GateSlot {
    pub pending: PendingGate,
    pub tx: oneshot::Sender<GateDecision>,
}

/// Turn-hook mode: `auto` = the loop decides turn ends by itself (the
/// webview-legacy behaviour); `client` = pause at each turn end and let the
/// attached screen decide (rewrite / gate-continue / compact / abort).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookMode {
    Auto,
    Client,
}

/// A client's decision at a turn-hook pause.
#[derive(Debug, Clone)]
pub enum HookDecision {
    /// The reply stands; finish the run.
    Done,
    /// Replace the last assistant turn's content (e.g. a humanized pass),
    /// then finish.
    Replace { content: String },
    /// Keep the run going: optionally replace the turn's content, append a
    /// gate note as the next user message, and (when `transcript` is given)
    /// replace the run's transcript first — the client's compaction path.
    Continue {
        content: Option<String>,
        note: Option<String>,
        transcript: Option<Vec<Value>>,
    },
    /// Abort the run.
    Abort,
}

/// Accumulated per-run usage across turns.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(default)]
pub struct RunUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

/// Snapshot of a run — what a client gets from `GET /runs/{id}` and as the
/// first SSE frame.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub model: String,
    pub system: Option<String>,
    pub max_steps: usize,
    pub created_at: u64,
    pub tool_set: String,
    pub tool_names: Vec<String>,
    pub parent: Option<String>,
    pub status: RunStatus,
    /// Transcript in wire format (see engine_loop::build_request_messages).
    pub messages: Vec<Value>,
    pub turns: usize,
    pub updated_at: u64,
    pub finish_reason: Option<String>,
    pub error: Option<String>,
    /// Terminal stop reason: "done" | "steps" | "aborted" | None (error).
    pub stop: Option<String>,
    pub scope: Option<String>,
    pub todo: Option<Value>,
    pub usage: RunUsage,
    pub last_meta: Option<Value>,
    pub pending_approvals: Vec<PendingApproval>,
    pub user_question: Option<PendingQuestion>,
    /// "auto" (decisions never pause) or "client" (the screen decides at
    /// each turn end via `POST /runs/{id}/hooks/{hid}`).
    pub hook_mode: String,
    /// The id of a pending hook decision, if paused.
    pub pending_hook: Option<String>,
    /// A pending risky/commit gate pause, if any (the polling client's dialog).
    pub pending_gate: Option<PendingGate>,
    /// Plan mode: read-only investigation run (bash locked to inspection
    /// commands, MCP + mutating tools denied at dispatch).
    pub plan: bool,
    /// Revision of the run's task list (stale-write guard for todo_write).
    pub todo_rev: u64,
}

/// Mutable, loop-owned part of a run. The loop is the single writer;
/// snapshot endpoints read under the same std::sync::Mutex (never held
/// across an await).
#[derive(Debug)]
pub struct RunLive {
    pub status: RunStatus,
    /// Transcript in wire format, append-only.
    pub messages: Vec<Value>,
    pub turns: usize,
    pub updated_at: u64,
    pub finish_reason: Option<String>,
    pub error: Option<String>,
    pub stop: Option<String>,
    pub pending_approvals: Vec<PendingApproval>,
    pub user_question: Option<PendingQuestion>,
    /// Latest `todo_write` payload (chat runs).
    pub todo: Option<Value>,
    /// CU scope (`set_directory`) — later tool dispatch re-reads this.
    pub scope: Option<String>,
    pub usage: RunUsage,
    /// Last turn's meta (ttftMs, prompt/completion tokens, …).
    pub last_meta: Option<Value>,
    /// The id of a pending turn-hook decision (set while `status == AwaitingHook`).
    pub pending_hook: Option<String>,
    /// Task-list revision: bumped by an accepted `todo_write` or a user edit.
    /// A `todo_write` whose snapshot predates the bump is stale and discarded
    /// (the client's mid-run edit guard).
    pub todo_rev: u64,
    /// The rev captured at the start of the in-flight turn — the list the
    /// current response was generated from.
    pub todo_base_rev: u64,
}

/// Immutable run description, fixed at start.
#[derive(Debug, Clone, Serialize)]
pub struct RunMeta {
    pub id: String,
    /// Labelled by the caller: chat | coder | worker | scout | research.
    pub kind: String,
    pub label: String,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    /// JSON object string of extra headers forwarded to the cloud provider.
    #[serde(default)]
    pub extra_headers: Option<String>,
    /// Fall back to the local engine on cloud 429/5xx (default true for cloud runs).
    #[serde(default = "default_allow_fallback")]
    pub allow_fallback: bool,
    pub system: Option<String>,
    pub max_steps: usize,
    pub created_at: u64,
    /// Dispatch family: "coder" (workspace sandboxed) or "chat" (CU-scoped).
    pub tool_set: String,
    /// Names the server may dispatch (the caller's offered tool names).
    pub tool_names: Vec<String>,
    /// Engine tool spec array (OpenAI function shape), sent verbatim.
    pub tools_spec: Value,
    /// Sampling params (temperature, topP, reasoningEffort, maxTokens, …).
    pub params: Value,
    pub parent: Option<String>,
    /// Read-only plan-mode run (bash locked to inspection commands).
    pub plan: bool,
    /// Worker critic spec `{model, system?}` for `subagent` runs — when set,
    /// the server runs the worker → critic fix loop in-process and reports
    /// `criticApproved` in the tool result.
    pub critic: Option<Value>,
}

/// Shared handle to one run. `Arc`ed into the loop task and every
/// in-flight HTTP handler; all interior mutability is explicit.
pub struct RunShared {
    pub meta: RunMeta,
    pub live: Mutex<RunLive>,
    pub tx: broadcast::Sender<AgentEvent>,
    /// id → resolver for a waiting `ask`-tier dispatch.
    pub approvals: Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>,
    /// Resolver for a waiting `ask_user` dispatch.
    pub question_tx: Mutex<Option<oneshot::Sender<String>>>,
    /// obs_recall store: content-hash id → full tool-result text.
    pub recall: Mutex<HashMap<String, String>>,
    /// Packed-content cache: original raw content → placeholder JSON string.
    pub packed_cache: Mutex<HashMap<String, String>>,
    /// Stop flag (watch): the loop `select!`s on it around every engine and
    /// tool await, so a stop cancels in-flight reads, not just the next
    /// loop iteration.
    pub stop_tx: watch::Sender<bool>,
    pub stop_rx: watch::Receiver<bool>,
    /// Turn-hook mode (see [`HookMode`]).
    pub hook_mode: Mutex<HookMode>,
    /// Resolver for a waiting turn-hook decision (mode == client).
    pub hook_wait: Mutex<Option<oneshot::Sender<HookDecision>>>,
    /// Risky/commit human gates: config + at most one in-flight pause.
    pub gate_state: Mutex<GateState>,
    pub client: reqwest::Client,
}

impl std::fmt::Debug for RunShared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunShared")
            .field("id", &self.meta.id)
            .field("status", &lock(&self.live).status)
            .finish()
    }
}

/// `State` holds the registry. A std::sync::Mutex: insert/lookup only,
/// never held across an await.
pub type RunRegistry = Arc<Mutex<HashMap<String, Arc<RunShared>>>>;

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<'a>(m: &'a Mutex<RunLive>) -> MutexGuard<'a, RunLive> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn shared_hook_mode(r: &RunShared) -> HookMode {
    *r.hook_mode.lock().unwrap_or_else(|p| p.into_inner())
}

impl RunShared {
    pub fn snapshot(&self) -> RunSnapshot {
        let live = lock(&self.live);
        let meta = &self.meta;
        RunSnapshot {
            id: meta.id.clone(),
            kind: meta.kind.clone(),
            label: meta.label.clone(),
            model: meta.model.clone(),
            system: meta.system.clone(),
            max_steps: meta.max_steps,
            created_at: meta.created_at,
            tool_set: meta.tool_set.clone(),
            tool_names: meta.tool_names.clone(),
            parent: meta.parent.clone(),
            status: live.status,
            messages: live.messages.clone(),
            turns: live.turns,
            updated_at: live.updated_at,
            finish_reason: live.finish_reason.clone(),
            error: live.error.clone(),
            stop: live.stop.clone(),
            scope: live.scope.clone(),
            todo: live.todo.clone(),
            usage: live.usage.clone(),
            last_meta: live.last_meta.clone(),
            pending_approvals: live.pending_approvals.clone(),
            user_question: live.user_question.clone(),
            hook_mode: match shared_hook_mode(self) {
                HookMode::Auto => "auto".to_string(),
                HookMode::Client => "client".to_string(),
            },
            pending_hook: live.pending_hook.clone(),
            pending_gate: self
                .gate_state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .slot
                .as_ref()
                .map(|s| s.pending.clone()),
            plan: meta.plan,
            todo_rev: live.todo_rev,
        }
    }

    pub fn status(&self) -> RunStatus {
        lock(&self.live).status
    }

    pub fn set_status(&self, status: RunStatus) {
        let mut live = lock(&self.live);
        if live.status != status {
            live.status = status;
            live.updated_at = now_ms();
            drop(live);
            let _ = self.tx.send(AgentEvent::Status { status });
        }
    }

    /// Append to the transcript; emit `appended`.
    pub fn append(&self, message: Value) {
        let turns = {
            let mut live = lock(&self.live);
            live.messages.push(message.clone());
            live.updated_at = now_ms();
            live.turns
        };
        let _ = self.tx.send(AgentEvent::Appended { message, turns });
    }

    pub fn mark_terminal(&self, status: RunStatus, stop: Option<String>, error: Option<String>) {
        {
            let mut live = lock(&self.live);
            live.status = status;
            live.stop = stop.clone();
            live.error = error.clone();
            live.updated_at = now_ms();
            live.pending_approvals.clear();
            live.user_question = None;
        }
        if let Some(message) = &error {
            let _ = self.tx.send(AgentEvent::Error {
                message: message.clone(),
            });
        }
        let _ = self.tx.send(AgentEvent::Done { stop, status });
    }

    /// Future that resolves when a stop is requested. `select!`ing on it
    /// alongside an engine/tool await cancels the other side (dropping the
    /// in-flight read) when the stop wins.
    pub async fn wait_stop(&self) {
        let mut rx = self.stop_rx.clone();
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// Stop + terminal-mark in one place (the `stop` endpoint).
    pub fn stop_run(&self) {
        let was_terminal = {
            let live = lock(&self.live);
            live.status.is_terminal()
        };
        if was_terminal {
            return;
        }
        let _ = self.stop_tx.send(true);
        self.mark_terminal(RunStatus::Stopped, Some("aborted".into()), None);
    }
}

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct StartBody {
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    label: String,
    /// Engine model id. Defaults to the primary engine's model.
    model: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    /// JSON object string of extra headers forwarded to the cloud provider.
    extra_headers: Option<String>,
    /// Fall back to the local engine on cloud 429/5xx (default true for cloud runs).
    #[serde(default = "default_allow_fallback")]
    allow_fallback: bool,
    system: Option<String>,
    messages: Vec<Value>,
    /// Engine tool spec array (OpenAI shape), sent verbatim to the engine.
    #[serde(default)]
    tools: Value,
    /// Names the server may dispatch in-process. Defaults to the
    /// `function.name` of every offered tool spec.
    tool_names: Option<Vec<String>>,
    #[serde(default = "default_tool_set")]
    tool_set: String,
    #[serde(default = "default_max_steps")]
    max_steps: usize,
    #[serde(default)]
    params: Value,
    /// Workspace / CU directory scope for permissions + tool resolution.
    scope: Option<String>,
    parent: Option<String>,
    /// Read-only plan-mode run (bash locked to inspection commands).
    #[serde(default)]
    plan: bool,
    /// Worker critic spec `{model, system?}` for subagent runs.
    critic: Option<Value>,
    /// Risky-command gate (the client's detectRisky HITL, ported): pause on
    /// risky-but-allowed shell commands for a once/remember/deny decision.
    #[serde(default)]
    risky_gate: bool,
    /// Commit-approval gate: pause on `git commit` shell commands.
    #[serde(default)]
    commit_gate: bool,
    /// Pre-approved (normalized) commands for the risky gate.
    #[serde(default)]
    approved_commands: Vec<String>,
    hook_mode: Option<String>,
}

fn default_kind() -> String {
    "chat".into()
}
fn default_allow_fallback() -> bool {
    true
}
fn default_tool_set() -> String {
    "chat".into()
}
fn default_max_steps() -> usize {
    // The client's DEFAULT_MAX_AGENT_STEPS — runs the screens start pass it
    // explicitly; this is the fallback for direct API callers.
    60
}

/// Shared run construction + spawn — used by the `start` endpoint and by
/// `delegate`/`subagent` child runs (tools.rs). The run is registered
/// before the loop task starts, so a client can attach within the same
/// tick the run begins.
pub fn spawn_run(state: &S, meta: RunMeta, live: RunLive) -> Arc<RunShared> {
    let (tx, _rx) = broadcast::channel(512);
    let (stop_tx, stop_rx) = watch::channel(false);
    let shared = Arc::new(RunShared {
        meta,
        live: Mutex::new(live),
        tx,
        approvals: Mutex::new(HashMap::new()),
        question_tx: Mutex::new(None),
        recall: Mutex::new(HashMap::new()),
        packed_cache: Mutex::new(HashMap::new()),
        stop_tx,
        stop_rx,
        hook_mode: Mutex::new(HookMode::Auto),
        hook_wait: Mutex::new(None),
        gate_state: Default::default(),
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3600))
            .build()
            .unwrap_or_default(),
    });
    state
        .agent_runs
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(shared.meta.id.clone(), shared.clone());
    tokio::spawn(engine_loop::run(state.clone(), shared.clone()));
    shared
}

/// `POST /api/agent/runs` — start a run. Returns `{id, status}`; follow the
/// run via `GET /api/agent/runs/{id}/events` (SSE) or poll the snapshot.
pub(crate) async fn start(AxumState(state): AxumState<S>, Json(body): Json<StartBody>) -> Response {
    if body.messages.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "messages must not be empty"})),
        )
            .into_response();
    }
    if body.max_steps == 0 || body.max_steps > 500 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "maxSteps must be 1..=500"})),
        )
            .into_response();
    }
    // Fail fast when no engine can serve the model — a run that can't stream
    // its first turn is a client error, not a zombie.
    let is_remote_cloud = body
        .base_url
        .as_deref()
        .map(str::trim)
        .is_some_and(|u| !u.is_empty());
    if !is_remote_cloud {
        let probe = match &body.model {
            Some(m) if !m.is_empty() => json!({ "model": m, "stream": true }),
            _ => json!({ "stream": true }),
        };
        let raw = serde_json::to_vec(&probe).unwrap_or_default();
        if crate::proxy::route_port(&state, &raw).await.is_err() {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "no engine available for the requested model"})),
            )
                .into_response();
        }
    }
    {
        let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
        let active = runs.values().filter(|r| !r.status().is_terminal()).count();
        if active >= MAX_CONCURRENT_RUNS {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error": format!("too many concurrent agent runs ({active})")})),
            )
                .into_response();
        }
    }

    let tool_names = match body.tool_names {
        Some(names) if !names.is_empty() => names,
        _ => {
            let mut names = Vec::new();
            if let Some(arr) = body.tools.as_array() {
                for t in arr {
                    if let Some(n) = t
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|v| v.as_str())
                    {
                        names.push(n.to_string());
                    }
                }
            }
            names
        }
    };

    let model = body.model.filter(|m| !m.is_empty()).unwrap_or_default();
    let model = if model.is_empty() {
        // Primary engine's model; "" → the engine's own default model.
        state
            .engine
            .read()
            .await
            .model_id
            .clone()
            .unwrap_or_default()
    } else {
        model
    };

    let id = format!(
        "run_{:x}_{}",
        now_ms(),
        state
            .bg_job_counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let live = RunLive {
        status: RunStatus::Running,
        messages: body.messages.clone(),
        turns: 0,
        updated_at: now_ms(),
        finish_reason: None,
        error: None,
        stop: None,
        pending_approvals: Vec::new(),
        user_question: None,
        pending_hook: None,
        todo: None,
        scope: body.scope.clone(),
        usage: RunUsage::default(),
        last_meta: None,
        todo_rev: 0,
        todo_base_rev: 0,
    };
    // Worker critic spec (subagent runs only): `{model, system?}`.
    let critic = body
        .critic
        .as_ref()
        .filter(|c| {
            c.get("model")
                .and_then(|m| m.as_str())
                .map(str::trim)
                .map(|m| !m.is_empty())
                .unwrap_or(false)
        })
        .map(|c| {
            let mut o = serde_json::Map::new();
            o.insert("model".into(), c["model"].clone());
            if c.get("system")
                .and_then(|s| s.as_str())
                .is_some_and(|s| !s.trim().is_empty())
            {
                o.insert("system".into(), c["system"].clone());
            }
            Value::Object(o)
        });
    let meta = RunMeta {
        id: id.clone(),
        kind: body.kind,
        label: body.label,
        model,
        base_url: body.base_url,
        api_key: body.api_key,
        extra_headers: body.extra_headers,
        allow_fallback: body.allow_fallback,
        system: body.system,
        max_steps: body.max_steps,
        created_at: live.updated_at,
        tool_set: body.tool_set,
        tool_names,
        tools_spec: body.tools,
        params: body.params,
        parent: body.parent,
        plan: body.plan,
        critic,
    };
    // Registered + spawned before this response goes out (see spawn_run),
    // so a client can attach to the SSE stream immediately. A requested
    // client hook mode is applied synchronously here — before the loop task
    // is first scheduled — so turn one can't finish in auto mode first.
    let shared = spawn_run(&state, meta, live);
    if body.hook_mode.as_deref() == Some("client") {
        *shared.hook_mode.lock().unwrap_or_else(|p| p.into_inner()) = HookMode::Client;
    }
    if body.risky_gate || body.commit_gate || !body.approved_commands.is_empty() {
        let mut gs = shared.gate_state.lock().unwrap_or_else(|p| p.into_inner());
        gs.opts.risky = body.risky_gate;
        gs.opts.commit = body.commit_gate;
        gs.opts.approved = body
            .approved_commands
            .iter()
            .map(|c| normalize_command(c))
            .collect();
    }
    Json(json!({ "id": id, "status": "running" })).into_response()
}

/// `GET /api/agent/runs` — list runs (newest first), light summaries.
pub(crate) async fn list(AxumState(state): AxumState<S>) -> Response {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let mut out: Vec<Value> = runs
        .values()
        .map(|r| {
            let snap = r.snapshot();
            json!({
                "id": snap.id,
                "kind": snap.kind,
                "label": snap.label,
                "model": snap.model,
                "status": snap.status,
                "turns": snap.turns,
                "maxSteps": snap.max_steps,
                "createdAt": snap.created_at,
                "updatedAt": snap.updated_at,
                "stop": snap.stop,
                "parent": snap.parent,
                "pendingApprovals": snap.pending_approvals.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        let a = a.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
        let b = b.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
        b.cmp(&a)
    });
    Json(Value::Array(out)).into_response()
}

/// `GET /api/agent/runs/{id}` — full snapshot (transcript, pending
/// approvals, usage).
pub(crate) async fn get(AxumState(state): AxumState<S>, Path(id): Path<String>) -> Response {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    match runs.get(&id) {
        Some(r) => Json(serde_json::to_value(r.snapshot()).unwrap()).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "run not found"})),
        )
            .into_response(),
    }
}

/// `POST /api/agent/runs/{id}/stop` — abort the loop. The run is marked
/// stopped; in-flight engine reads and tool dispatches are dropped.
pub(crate) async fn stop(AxumState(state): AxumState<S>, Path(id): Path<String>) -> Response {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "run not found"})),
        )
            .into_response();
    };
    let status = r.status();
    if status.is_terminal() {
        return Json(json!({ "status": status })).into_response();
    }
    r.stop_run();
    Json(json!({ "status": "stopped" })).into_response()
}

/// `POST /api/agent/runs/{id}/approvals/{aid}` — resolve a pending approval.
/// Body: `{decision: "approve"|"deny", token?}`. For `approve`, the client
/// mints the one-shot token through the existing `/api/coder/perms/approve`
/// first and passes it here; the loop injects it and `enforce_perm`
/// consumes it (single-use, TTL, tool+path scoped — unchanged).
pub(crate) async fn approve(
    AxumState(state): AxumState<S>,
    Path((id, aid)): Path<(String, String)>,
    Json(body): Json<ApproveBody>,
) -> Response {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "run not found"})),
        )
            .into_response();
    };
    let approved = body.decision == "approve";
    if approved
        && body
            .token
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "approve requires a one-shot approvalToken from /api/coder/perms/approve"})),
        )
            .into_response();
    }
    let Some(sender) = r
        .approvals
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&aid)
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no pending approval with that id"})),
        )
            .into_response();
    };
    let decision = if approved {
        ApprovalDecision::Approved { token: body.token }
    } else {
        ApprovalDecision::Denied
    };
    let _ = sender.send(decision);
    r.set_status(RunStatus::Running);
    let _ =
        r.tx.send(AgentEvent::ApprovalResolved { id: aid, approved });
    Json(json!({ "ok": true, "approved": approved })).into_response()
}

#[derive(Debug, Deserialize)]
pub(crate) struct ApproveBody {
    decision: String,
    #[serde(default)]
    token: Option<String>,
}

/// `POST /api/agent/runs/{id}/gates/{gid}` — resolve a pending risky/commit
/// gate. Body: `{decision: "once"|"remember"|"deny"}` for a risky gate
/// (`remember` runs it and records the normalized command for the rest of
/// the run), `{decision: "approve"|"deny"}` for a commit gate. Unlike
/// approvals, no one-shot token is involved — the dialog itself is the
/// human gesture, and the command never leaves this machine.
pub(crate) async fn gate_decide(
    AxumState(state): AxumState<S>,
    Path((id, gid)): Path<(String, String)>,
    Json(body): Json<GateDecideBody>,
) -> Response {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "run not found"})),
        )
            .into_response();
    };
    let mut gs = r.gate_state.lock().unwrap_or_else(|p| p.into_inner());
    let Some(slot) = gs.slot.take() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no pending gate with that id"})),
        )
            .into_response();
    };
    if slot.pending.id != gid {
        gs.slot = Some(slot);
        return (
            StatusCode::CONFLICT,
            Json(json!({"error": "no pending gate with that id"})),
        )
            .into_response();
    }
    let decision = match (slot.pending.kind, body.decision.as_str()) {
        (GateKind::Risky, "once") => GateDecision::Once,
        (GateKind::Risky, "remember") => GateDecision::Remember,
        (_, "deny") => GateDecision::Deny,
        (GateKind::Commit, "approve") => GateDecision::Once,
        _ => {
            gs.slot = Some(slot);
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "decision must be once|remember|deny (risky) or approve|deny (commit)"})),
            )
                .into_response();
        }
    };
    if decision == GateDecision::Remember {
        let norm = normalize_command(&slot.pending.command);
        if !gs.opts.approved.iter().any(|a| a == &norm) {
            gs.opts.approved.push(norm);
        }
    }
    let kind = slot.pending.kind;
    let id_out = slot.pending.id.clone();
    let name = match decision {
        GateDecision::Once => "once",
        GateDecision::Remember => "remember",
        GateDecision::Deny => "deny",
    };
    let _ = slot.tx.send(decision);
    drop(gs);
    r.set_status(RunStatus::Running);
    let _ = r.tx.send(AgentEvent::GateResolved {
        id: id_out,
        kind,
        decision: name.to_string(),
    });
    Json(json!({ "ok": true, "decision": name })).into_response()
}
#[derive(Debug, Deserialize)]
pub(crate) struct GateDecideBody {
    pub(crate) decision: String,
}

/// Normalize a shell command for approved-command matching (the client's
/// `normalizeCommand`, ported): collapse whitespace, trim.
pub(crate) fn normalize_command(cmd: &str) -> String {
    cmd.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `POST /api/agent/runs/{id}/questions/{qid}` — answer a pending
/// `ask_user` pause. Body: `{answer}`.
pub(crate) async fn answer(
    AxumState(state): AxumState<S>,
    Path((id, qid)): Path<(String, String)>,
    Json(body): Json<AnswerBody>,
) -> Response {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "run not found"})),
        )
            .into_response();
    };
    let Some(sender) = r
        .question_tx
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no pending question"})),
        )
            .into_response();
    };
    let _ = sender.send(body.answer.clone());
    r.set_status(RunStatus::Running);
    let _ = r.tx.send(AgentEvent::UserQuestionAnswered {
        id: qid,
        answer: body.answer,
    });
    Json(json!({ "ok": true })).into_response()
}

#[derive(Debug, Deserialize)]
pub(crate) struct AnswerBody {
    answer: String,
}

/// `GET /api/agent/runs/{id}/events` — SSE attach. First frame: a `state`
/// snapshot (the full snapshot JSON as event data, event name `state`);
/// subsequent frames: one per [`AgentEvent`], event name = its `type`
/// value. A lagging subscriber just drops frames; it can resync with a
/// `GET /runs/{id}` snapshot (same shape as the first frame).
pub(crate) async fn events(AxumState(state): AxumState<S>, Path(id): Path<String>) -> Response {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "run not found"})),
        )
            .into_response();
    };
    // One pump task per attached client: it owns a broadcast receiver and
    // forwards frames over an mpsc (a broadcast `recv()` future borrows the
    // receiver, so it cannot live inside a `Stream` impl without a
    // self-referential struct — the spawned task has none of that). When
    // the client disconnects the mpsc receiver drops, the next send errors,
    // and the pump drops its broadcast receiver.
    let run = r.clone();
    let (out_tx, out_rx) = tokio::sync::mpsc::channel::<bytes::Bytes>(1024);
    tokio::spawn(sse_pump(run, out_tx));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(axum::body::Body::from_stream(SseMpsc { rx: out_rx }))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "bad response").into_response())
}

/// First frame is the snapshot (`event: state`); then one frame per
/// [`AgentEvent`]. Ends when the run's channel closes or the client goes
/// away.
async fn sse_pump(run: Arc<RunShared>, out: tokio::sync::mpsc::Sender<bytes::Bytes>) {
    let mut rx = run.tx.subscribe();
    let snap = run.snapshot();
    let first = sse_frame(
        "state",
        &serde_json::to_string(&AgentEvent::State {
            snapshot: Box::new(snap),
        })
        .unwrap_or_default(),
    );
    if out.send(first).await.is_err() {
        return; // client is already gone
    }
    while let Ok(ev) = rx.recv().await {
        let v = serde_json::to_value(&ev).unwrap_or(Value::Null);
        let name = v
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("event")
            .to_string();
        if out.send(sse_frame(&name, &v.to_string())).await.is_err() {
            return;
        }
    }
}

/// One SSE frame: `event: <name>`, then one `data:` line per line of the
/// (single-line) JSON payload.
fn sse_frame(name: &str, data: &str) -> bytes::Bytes {
    let mut out = String::new();
    out.push_str(&format!("event: {name}\n"));
    for line in data.split('\n') {
        out.push_str("data: ");
        out.push_str(line);
        out.push('\n');
    }
    out.push('\n');
    bytes::Bytes::from(out)
}

/// Stream adapter over an mpsc receiver — `poll_recv` registers wakers
/// properly (unlike `try_recv`).
struct SseMpsc {
    rx: tokio::sync::mpsc::Receiver<bytes::Bytes>,
}

impl std::fmt::Debug for SseMpsc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SseMpsc").finish()
    }
}

impl futures_util::Stream for SseMpsc {
    type Item = Result<bytes::Bytes, std::convert::Infallible>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.get_mut().rx.poll_recv(cx).map(|b| b.map(Ok))
    }
}

/// `POST /api/agent/runs/{id}/hook` — set the turn-hook mode.
/// `{mode: "auto" | "client"}`. `client` makes the loop pause at each turn
/// end (`awaiting_hook`) until a decision is posted to
/// `POST /runs/{id}/hooks/{hid}` — that is how the screens keep their
/// humanize/verify/critic/compact passes while the loop itself is
/// server-owned. A paused run times out back to plain `done` (see
/// `engine_loop::client_hook`), so an absent client can never wedge a run.
#[derive(Debug, Deserialize)]
pub(crate) struct HookModeBody {
    mode: String,
}

pub(crate) async fn set_hook_mode(
    AxumState(state): AxumState<S>,
    Path(id): Path<String>,
    Json(body): Json<HookModeBody>,
) -> Response {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "run not found"})),
        )
            .into_response();
    };
    let mode = match body.mode.as_str() {
        "client" => HookMode::Client,
        _ => HookMode::Auto,
    };
    *r.hook_mode.lock().unwrap_or_else(|p| p.into_inner()) = mode;
    Json(json!({ "ok": true, "mode": if mode == HookMode::Client { "client" } else { "auto" } }))
        .into_response()
}

/// `POST /api/agent/runs/{id}/hooks/{hid}` — the client's turn-hook
/// decision. Body: `{action: "done"|"replace"|"continue"|"abort",
/// content?, note?, transcript?}`.
#[derive(Debug, Deserialize)]
pub(crate) struct HookDecisionBody {
    action: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    note: Option<String>,
    /// Client-side compaction: replace the run's transcript with this
    /// (wire-format) transcript before continuing.
    #[serde(default)]
    transcript: Option<Vec<Value>>,
}

pub(crate) async fn hook_decision(
    AxumState(state): AxumState<S>,
    Path((id, hid)): Path<(String, String)>,
    Json(body): Json<HookDecisionBody>,
) -> Response {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "run not found"})),
        )
            .into_response();
    };
    // The id must be the pending one — a stale decision from an earlier pause
    // must not resolve the current one (two clients racing, a late reply).
    {
        let live = r.live.lock().unwrap_or_else(|p| p.into_inner());
        if live.pending_hook.as_deref() != Some(hid.as_str()) {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error": "no pending hook decision with that id"})),
            )
                .into_response();
        }
    }
    // The pending decision's id is whatever the loop posted; a stale/second
    // decision just finds nothing waiting and is a no-op.
    let decision = match body.action.as_str() {
        "replace" => HookDecision::Replace {
            content: body.content.unwrap_or_default(),
        },
        "continue" => HookDecision::Continue {
            content: body.content,
            note: body.note,
            transcript: body.transcript,
        },
        "abort" => HookDecision::Abort,
        _ => HookDecision::Done,
    };
    let action = decision.action_name().to_string();
    let sender = r.hook_wait.lock().unwrap_or_else(|p| p.into_inner()).take();
    let Some(sender) = sender else {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error": "no pending hook decision"})),
        )
            .into_response();
    };
    let _ = sender.send(decision);
    {
        let mut live = r.live.lock().unwrap_or_else(|p| p.into_inner());
        live.pending_hook = None;
    }
    r.set_status(RunStatus::Running);
    let _ = r.tx.send(AgentEvent::HookResolved { id: hid, action });
    Json(json!({ "ok": true })).into_response()
}

/// Validate + normalize a `todo_write` items array (mirrors the client's
/// guard: `content` must be a non-empty string, `status` one of the three
/// known values — malformed items are dropped, never stringified).
pub(crate) fn clean_todo_items(raw: &Value) -> Vec<Value> {
    let Some(arr) = raw.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for t in arr {
        let Some(content) = t.get("content").and_then(|v| v.as_str()) else {
            continue;
        };
        if content.trim().is_empty() {
            continue;
        }
        let status = match t.get("status").and_then(|v| v.as_str()) {
            Some("in_progress") | Some("completed") => t["status"].clone(),
            _ => Value::String("pending".into()),
        };
        out.push(json!({ "content": content, "status": status }));
    }
    out
}

/// User-edit the run's task list from the UI (bumps `todo_rev` so a stale
/// `todo_write` snapshot the model is generating gets discarded).
pub(crate) async fn todo_set(
    AxumState(state): AxumState<S>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "run not found" })),
        )
            .into_response();
    };
    let items = clean_todo_items(body.get("todos").unwrap_or(&Value::Null));
    let mut live = lock(&r.live);
    live.todo = Some(Value::Array(items.clone()));
    live.todo_rev += 1;
    let rev = live.todo_rev;
    drop(live);
    let _ = r.tx.send(AgentEvent::Todo {
        items: Value::Array(items.clone()),
    });
    Json(json!({ "ok": true, "count": items.len(), "rev": rev })).into_response()
}

/// Router for the whole `/api/agent` surface.
pub(crate) fn router() -> Router<S> {
    Router::new()
        .route("/runs", post_route(start).get(list))
        .route("/runs/{id}", get_route(get))
        .route("/runs/{id}/events", get_route(events))
        .route("/runs/{id}/todo", post_route(todo_set))
        .route("/runs/{id}/stop", post_route(stop))
        .route("/runs/{id}/approvals/{aid}", post_route(approve))
        .route("/runs/{id}/gates/{gid}", post_route(gate_decide))
        .route("/runs/{id}/questions/{qid}", post_route(answer))
        .route("/runs/{id}/hook", post_route(set_hook_mode))
        .route("/runs/{id}/hooks/{hid}", post_route(hook_decision))
}

impl HookDecision {
    /// Wire name of the decision (for the `hook_resolved` event).
    pub fn action_name(&self) -> &'static str {
        match self {
            HookDecision::Done => "done",
            HookDecision::Replace { .. } => "replace",
            HookDecision::Continue { .. } => "continue",
            HookDecision::Abort => "abort",
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) fn test_run(
    _state: &S,
    kind: &str,
    tool_names: &[&str],
    scope: Option<String>,
) -> Arc<RunShared> {
    let (tx, _rx) = broadcast::channel(64);
    let (stop_tx, stop_rx) = watch::channel(false);
    let meta = RunMeta {
        id: format!("run_test_{:x}_{}", now_ms(), std::process::id()),
        kind: kind.into(),
        label: "test".into(),
        model: "test-model".into(),
        base_url: None,
        api_key: None,
        extra_headers: None,
        allow_fallback: true,
        system: None,
        max_steps: 4,
        created_at: now_ms(),
        tool_set: "coder".into(),
        tool_names: tool_names.iter().map(|s| s.to_string()).collect(),
        tools_spec: Value::Array(vec![]),
        params: Value::Null,
        parent: None,
        plan: false,
        critic: None,
    };
    Arc::new(RunShared {
        meta,
        live: Mutex::new(RunLive {
            status: RunStatus::Running,
            messages: vec![json!({"role": "user", "content": "go"})],
            turns: 0,
            updated_at: now_ms(),
            finish_reason: None,
            error: None,
            stop: None,
            pending_approvals: vec![],
            user_question: None,
            pending_hook: None,
            todo: None,
            scope,
            usage: RunUsage::default(),
            last_meta: None,
            todo_rev: 0,
            todo_base_rev: 0,
        }),
        tx,
        approvals: Mutex::new(HashMap::new()),
        question_tx: Mutex::new(None),
        recall: Mutex::new(HashMap::new()),
        packed_cache: Mutex::new(HashMap::new()),
        stop_tx,
        stop_rx,
        hook_mode: Mutex::new(HookMode::Auto),
        hook_wait: Mutex::new(None),
        gate_state: Default::default(),
        client: reqwest::Client::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::State;

    fn fresh() -> S {
        static CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = std::env::temp_dir().join(format!(
            "ninfier-agent-{}-{}-{n}",
            std::process::id(),
            now_ms()
        ));
        Arc::new(State::new(tmp.clone(), tmp, None))
    }

    #[tokio::test]
    async fn registry_round_trip_and_snapshot_shape() {
        let state = fresh();
        let shared = test_run(&state, "chat", &["web_search"], None);
        state
            .agent_runs
            .lock()
            .unwrap()
            .insert(shared.meta.id.clone(), shared.clone());

        let snap = shared.snapshot();
        assert_eq!(snap.id, shared.meta.id);
        assert_eq!(snap.status, RunStatus::Running);
        assert_eq!(snap.messages.len(), 1);

        shared.append(json!({"role": "assistant", "content": "hello"}));
        assert_eq!(shared.snapshot().messages.len(), 2);

        shared.mark_terminal(RunStatus::Done, Some("done".into()), None);
        assert!(shared.status().is_terminal());
        let _ = std::fs::remove_dir_all(state.data_dir.clone());
    }

    #[tokio::test]
    async fn tool_dispatch_round_trip() {
        let state = fresh();
        let dir = state.data_dir.clone();
        std::fs::create_dir_all(dir.join("ws")).unwrap();
        let shared = test_run(
            &state,
            "coder",
            &["write", "read"],
            Some(dir.join("ws").to_string_lossy().into()),
        );
        let w = crate::agent::tools::dispatch(
            &state,
            &shared,
            "write",
            &json!({"path": "a.txt", "content": "hello"}),
        )
        .await;
        assert_eq!(
            w.get("created").and_then(|v| v.as_bool()),
            Some(true),
            "write: {w}"
        );
        let r =
            crate::agent::tools::dispatch(&state, &shared, "read", &json!({"path": "a.txt"})).await;
        assert_eq!(r.get("content").and_then(|v| v.as_str()), Some("hello"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn unknown_tool_returns_model_error() {
        let state = fresh();
        let shared = test_run(&state, "coder", &["read"], None);
        let r = crate::agent::tools::dispatch(&state, &shared, "nope", &json!({})).await;
        let err = r.get("error").and_then(|v| v.as_str()).unwrap_or("");
        assert!(err.contains("unknown tool"), "{r}");
        let _ = std::fs::remove_dir_all(state.data_dir.clone());
    }

    /// The web client sends camelCase (StartRunBody); the server must read
    /// it — a silent case mismatch here once gave every UI-started run 60
    /// steps, no tools, and no gates.
    #[test]
    fn start_body_accepts_camel_case_wire() {
        let b: StartBody = serde_json::from_value(json!({
            "messages": [{"role": "user", "content": "hi"}],
            "kind": "worker", "label": "w", "model": "m", "system": "s",
            "maxSteps": 12, "toolSet": "coder", "toolNames": ["read"],
            "tools": [], "params": {"maxTokens": 1}, "scope": "/tmp",
            "parent": null, "plan": true, "critic": null,
            "hookMode": "client", "riskyGate": true, "commitGate": true,
            "approvedCommands": ["git push"]
        }))
        .unwrap();
        assert_eq!(b.max_steps, 12);
        assert_eq!(b.tool_set, "coder");
        assert_eq!(b.tool_names, Some(vec!["read".to_string()]));
        assert_eq!(b.hook_mode.as_deref(), Some("client"));
        assert!(b.risky_gate && b.commit_gate);
        assert_eq!(b.approved_commands, vec!["git push".to_string()]);
        assert!(b.plan);
    }
}
