//! Run registry, snapshot types, and the `/api/agent/*` HTTP endpoints.
//!
//! A **run** is one bounded agent loop (the server port of the webview's
//! `runToolLoop`): an initial transcript + an engine streaming loop that
//! dispatches tools in-process. Runs live in `State.agent_runs` and keep
//! going while no client is attached — closing a window only detaches its
//! SSE subscription, it never kills the run.

use crate::agent::engine_loop;
use crate::agent::tools;
use crate::engine::S;
use axum::extract::{Path, State as AxumState};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};
use tokio::sync::{broadcast, oneshot};
use tokio::task::AbortHandle;

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
    State { snapshot: RunSnapshot },
    /// Streaming assistant content delta (kind: "content" or "reasoning").
    Delta { kind: &'static str, text: String },
    /// A new assistant turn is about to stream (turn index).
    TurnStarted { turns: usize },
    /// Transcript append: the assistant message, or one tool result.
    Appended { message: Value, turns: usize },
    /// A tool call the model asked for (before dispatch).
    ToolCall { id: String, name: String, args: String },
    /// A tool finished (result truncated for the event stream; the full
    /// result lives in the transcript).
    ToolResult { id: String, name: String, preview: String, error: bool },
    /// An `ask`-tier tool paused the run; a client should show its dialog.
    ApprovalRequested {
        id: String,
        tool: String,
        rel: Option<String>,
        args: String,
    },
    ApprovalResolved { id: String, approved: bool },
    /// The `ask_user` tool paused the run for a human answer.
    UserQuestionRequested { id: String, question: String },
    UserQuestionAnswered { id: String, answer: String },
    /// The `todo_write` tool updated the run's todo list.
    Todo { items: Value },
    Status { status: RunStatus },
    /// Terminal: the loop finished (done/steps), errored, or was stopped.
    Done { stop: Option<String>, status: RunStatus },
    /// Non-terminal loop error message (the run continues or has errored —
    /// see `Done.status`).
    Error { message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    AwaitingApproval,
    AwaitingUser,
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

/// Accumulated per-run usage across turns.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(default)]
pub struct RunUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

/// Mutable, loop-owned part of a run. The loop is the single writer;
/// snapshot endpoints read under the same std::sync::Mutex (never held
/// across an await).
#[derive(Debug)]
pub struct RunLive {
    pub status: RunStatus,
    /// Transcript in wire format (see engine_loop::build_request_messages):
    /// `{role, content, ...}` objects, append-only.
    pub messages: Vec<Value>,
    pub turns: usize,
    pub updated_at: u64,
    pub finish_reason: Option<String>,
    pub error: Option<String>,
    /// Terminal stop reason: "done" | "steps" | "aborted" | None (error).
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
}

/// Immutable run description, fixed at start.
#[derive(Debug, Clone, Serialize)]
pub struct RunMeta {
    pub id: String,
    /// Labelled by the caller: chat | coder | worker | scout | research.
    pub kind: String,
    pub label: String,
    pub model: String,
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
}

/// Shared handle to one run. `Arc`ed into the loop task and into every
/// in-flight HTTP handler; all interior mutability is explicit.
pub struct RunShared {
    pub meta: RunMeta,
    pub live: Mutex<RunLive>,
    pub tx: broadcast::Sender<AgentEvent>,
    /// id → resolver for a waiting `ask`-tier dispatch.
    pub approvals: Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>,
    /// Resolver for a waiting `ask_user` dispatch.
    pub question_tx: Mutex<Option<oneshot::Sender<String>>>,
    /// obs_recall store: content hash id → full tool-result text.
    pub recall: Mutex<HashMap<String, String>>,
    /// Packed-content cache: original raw content → placeholder JSON string.
    pub packed_cache: Mutex<HashMap<String, String>>,
    pub abort: AbortHandle,
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
        }
    }

    pub fn set_status(&self, status: RunStatus) {
        let mut live = lock(&self.live);
        if live.status != status {
            live.status = status;
            live.updated_at = now_ms();
            let _ = self.tx.send(AgentEvent::Status { status });
        }
    }

    /// Append to the transcript + bump turns/updated_at; emit `appended`.
    pub fn append(&self, message: Value) {
        let mut live = lock(&self.live);
        let turns = live.turns;
        live.messages.push(message.clone());
        live.updated_at = now_ms();
        drop(live);
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
        let _ = self
            .tx
            .send(AgentEvent::Error { message: error.unwrap_or_default() })
            .filter(|_| error.is_some());
        let _ = self
            .tx
            .send(AgentEvent::Done { stop, status })
            .filter(|_| true);
    }
}

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(default)]
struct StartBody {
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    label: String,
    /// Engine model id. Defaults to the primary engine's model.
    model: Option<String>,
    system: Option<String>,
    messages: Vec<Value>,
    /// Engine tool spec array (OpenAI shape), sent verbatim to the engine.
    #[serde(default)]
    tools: Value,
    /// Names the server may dispatch in-process. Defaults to the `function.name`
    /// of every offered tool spec.
    tool_names: Option<Vec<String>>,
    #[serde(default = "default_tool_set")]
    tool_set: String,
    #[serde(default = "default_max_steps")]
    max_steps: usize,
    #[serde(default)]
    params: Value,
    /// Workspace / CU directory scope for permission + tool resolution.
    scope: Option<String>,
    parent: Option<String>,
}

fn default_kind() -> String {
    "chat".into()
}
fn default_tool_set() -> String {
    "chat".into()
}
fn default_max_steps() -> usize {
    12
}

/// `POST /api/agent/runs` — start a run. Returns `{id, status}`; follow the
/// run via `GET /api/agent/runs/{id}/events` (SSE) or poll the snapshot.
pub async fn start(
    AxumState(state): AxumState<S>,
    Json(body): Json<StartBody>,
) -> impl IntoResponse {
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
    let body_val = json!({ "model": body.model, "stream": true });
    let raw = serde_json::to_vec(&body_val).unwrap_or_default();
    if crate::proxy::route_port(&state, &raw).await.is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "no engine available for the requested model"})),
        )
            .into_response();
    }
    let tool_names = match body.tool_names {
        Some(names) if !names.is_empty() => names,
        _ => {
            let mut names = Vec::new();
            if let Some(arr) = body.tools.as_array() {
                for t in arr {
                    if let Some(n) = t.get("function").and_then(|f| f.get("name")).and_then(|v| v.as_str()) {
                        names.push(n.to_string());
                    }
                }
            }
            names
        }
    };

    let registry: RunRegistry = {
        // State exposes the registry via its field (see types::state::State).
        state.agent_runs.clone()
    };
    {
        let runs = registry.lock().unwrap_or_else(|p| p.into_inner());
        let active = runs
            .values()
            .filter(|r| !RunShared::status_of(r).is_terminal())
            .count();
        if active >= MAX_CONCURRENT_RUNS {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error": format!("too many concurrent agent runs ({active})")})),
            )
                .into_response();
        }
    }

    let model = body.model.unwrap_or_else(|| {
        // Primary engine's model (status shape); fallback "" → engine default.
        crate::routes_engine::primary_model(&state)
    });

    let (tx, _rx) = broadcast::channel(512);
    let id = format!(
        "run_{:x}_{}",
        now_ms(),
        state.bg_job_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
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
        todo: None,
        scope: body.scope.clone(),
        usage: RunUsage::default(),
        last_meta: None,
    };
    let meta = RunMeta {
        id: id.clone(),
        kind: body.kind,
        label: body.label,
        model,
        system: body.system,
        max_steps: body.max_steps,
        created_at: live.updated_at,
        tool_set: body.tool_set,
        tool_names,
        tools_spec: body.tools,
        params: body.params,
        parent: body.parent,
    };
    let (task, abort) = tokio::task::spawn_abort(engine_loop::run(state.clone(), Arc::new(()), tx.clone(), meta.clone(), live));
    let (_handle, abort) = task;
    let shared = Arc::new(RunShared {
        meta,
        live: Mutex::new(RunLive { status: RunStatus::Running, messages: Vec::new(), turns: 0, updated_at: now_ms(), finish_reason: None, error: None, stop: None, pending_approvals: Vec::new(), user_question: None, todo: None, scope: body.scope.clone(), usage: RunUsage::default(), last_meta: None }),
        tx,
        approvals: Mutex::new(HashMap::new()),
        question_tx: Mutex::new(None),
        recall: Mutex::new(HashMap::new()),
        packed_cache: Mutex::new(HashMap::new()),
        abort,
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3600))
            .build()
            .unwrap_or_default(),
    });
    registry
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id.clone(), shared.clone());

    Json(json!({ "id": id, "status": "running" }))
        .into_response()
}

/// `RunShared::status` without cloning the whole run (used by the
/// concurrency cap).
impl RunShared {
    fn status_of(r: &Arc<RunShared>) -> RunStatus {
        lock(&r.live).status
    }
}

/// `GET /api/agent/runs` — list runs (newest first), light summaries.
pub async fn list(AxumState(state): AxumState<S>) -> impl IntoResponse {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let mut out: Vec<Value> = runs.values().map(|r| {
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
    });
    out.sort_by(|a, b| {
        let a = a.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
        let b = b.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
        b.cmp(&a)
    });
    Json(Value::Array(out)).into_response()
}

/// `GET /api/agent/runs/{id}` — full snapshot (transcript, pending
/// approvals, usage).
pub async fn get(AxumState(state): AxumState<S>, Path(id): Path<String>) -> impl IntoResponse {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    match runs.get(&id) {
        Some(r) => Json(Value::Object(serde_json::to_value(r.snapshot()).unwrap())).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"error": "run not found"}))).into_response(),
    }
}

/// `POST /api/agent/runs/{id}/stop` — abort the loop task. The run is
/// marked stopped; in-flight engine reads and tool dispatches are dropped.
pub async fn stop(AxumState(state): AxumState<S>, Path(id): Path<String>) -> impl IntoResponse {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "run not found"}))).into_response();
    };
    {
        let live = lock(&r.live);
        if live.status.is_terminal() {
            return Json(json!({ "status": live.status })).into_response();
        }
    }
    r.abort.abort();
    r.mark_terminal(RunStatus::Stopped, Some("aborted".into()), None);
    Json(json!({ "status": "stopped" })).into_response()
}

/// `POST /api/agent/runs/{id}/approvals/{aid}` — resolve a pending approval.
/// Body: `{decision: "approve"|"deny", token?}`. For `approve`, the client
/// mints the one-shot token through the existing `/api/coder/perms/approve`
/// first and passes it here; the loop injects it and `enforce_perm`
/// consumes it (single-use, TTL, tool+path scoped — unchanged).
pub async fn approve(
    AxumState(state): AxumState<S>,
    Path((id, aid)): Path<(String, String)>,
    Json(body): Json<ApproveBody>,
) -> impl IntoResponse {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "run not found"}))).into_response();
    };
    let approved = body.decision == "approve";
    if approved && body.token.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "approve requires a one-shot approvalToken from /api/coder/perms/approve"})),
        )
            .into_response();
    }
    let Some(sender) = r.approvals.lock().unwrap_or_else(|p| p.into_inner()).remove(&aid) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "no pending approval with that id"}))).into_response();
    };
    let decision = if approved {
        ApprovalDecision::Approved { token: body.token }
    } else {
        ApprovalDecision::Denied
    };
    let _ = sender.send(decision);
    r.set_status(RunStatus::Running);
    let _ = r.tx.send(AgentEvent::ApprovalResolved { id: aid, approved });
    Json(json!({ "ok": true, "approved": approved })).into_response()
}

#[derive(Debug, Deserialize)]
struct ApproveBody {
    decision: String,
    #[serde(default)]
    token: Option<String>,
}

/// `POST /api/agent/runs/{id}/questions/{qid}` — answer a pending `ask_user`
/// pause. Body: `{answer}`.
pub async fn answer(
    AxumState(state): AxumState<S>,
    Path((id, qid)): Path<(String, String)>,
    Json(body): Json<AnswerBody>,
) -> impl IntoResponse {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "run not found"}))).into_response();
    };
    let Some(sender) = r.question_tx.lock().unwrap_or_else(|p| p.into_inner()).take() else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "no pending question"}))).into_response();
    };
    let _ = sender.send(body.answer.clone());
    r.set_status(RunStatus::Running);
    let _ = r
        .tx
        .send(AgentEvent::UserQuestionAnswered { id: qid, answer: body.answer });
    Json(json!({ "ok": true })).into_response()
}

#[derive(Debug, Deserialize)]
struct AnswerBody {
    answer: String,
}

/// `GET /api/agent/runs/{id}/events` — SSE attach. First frame: a `state`
/// snapshot (the full snapshot JSON as event data, event name `state`);
/// subsequent frames: one per [`AgentEvent`], event name = its `type`
/// value. Lagging subscribers get the next event (SSE clients resync via
/// the snapshot they already hold + `GET` if they fall behind).
pub async fn events(AxumState(state): AxumState<S>, Path(id): Path<String>) -> Response {
    let runs = state.agent_runs.lock().unwrap_or_else(|p| p.into_inner());
    let Some(r) = runs.get(&id).cloned() else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "run not found"}))).into_response();
    };
    let rx = r.tx.subscribe();
    let stream = SseStream { rx, started: false, run: r.clone() };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(axum::body::Body::from_stream(
            futures_util::StreamExt::boxed(stream).map(|b| Ok::<_, std::convert::Infallible>(b)),
        ))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "bad response").into_response())
}

struct SseStream {
    rx: broadcast::Receiver<AgentEvent>,
    started: bool,
    run: Arc<RunShared>,
}

impl SseStream {
    fn frame(name: &str, data: &str) -> bytes::Bytes {
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
}

impl futures_util::Stream for SseStream {
    type Item = bytes::Bytes;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            if !self.started {
                self.started = true;
                let snap = serde_json::to_string(&self.run.snapshot()).unwrap_or_default();
                return Poll::Ready(Some(Self::frame("state", &snap)));
            }
            match self.rx.recv() {
                Ok(ev) => {
                    let (name, data) = match &ev {
                        AgentEvent::State { snapshot } => ("state", &serde_json::to_string(snapshot).unwrap_or_default()),
                        other => {
                            let v = serde_json::to_value(other).unwrap_or(Value::Null);
                            let name = v.get("type").and_then(|t| t.as_str()).unwrap_or("event").to_string();
                            (name, &serde_json::to_string(other).unwrap_or_default())
                        }
                    };
                    return Poll::Ready(Some(Self::frame(&name, &data)));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    cx.waker().wake_by_ref();
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => return Poll::Ready(None),
            }
        }
    }
}

/// Router for the whole `/api/agent` surface.
pub fn router() -> Router<S> {
    Router::new()
        .route("/runs", post(start).get(list))
        .route("/runs/{id}", get(get))
        .route("/runs/{id}/events", get(events))
        .route("/runs/{id}/stop", post(stop))
        .route("/runs/{id}/approvals/{aid}", post(approve))
        .route("/runs/{id}/questions/{qid}", post(answer))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::State;

    fn fresh() -> (S, RunRegistry) {
        let tmp = std::env::temp_dir().join(format!("ninfier-agent-{}-{}", std::process::id(), now_ms()));
        let state: S = Arc::new(State::new(tmp.clone(), tmp.clone(), None));
        let reg: RunRegistry = state.agent_runs.clone();
        (state, reg)
    }

    #[tokio::test]
    async fn registry_round_trip_and_snapshot_shape() {
        let (_state, reg) = fresh();
        let (tx, _rx) = broadcast::channel(8);
        let meta = RunMeta {
            id: "run_test".into(),
            kind: "chat".into(),
            label: "t".into(),
            model: "m".into(),
            system: None,
            max_steps: 4,
            created_at: now_ms(),
            tool_set: "chat".into(),
            tool_names: vec!["web_search".into()],
            tools_spec: Value::Array(vec![]),
            params: Value::Null,
            parent: None,
        };
        let shared = Arc::new(RunShared {
            meta,
            live: Mutex::new(RunLive {
                status: RunStatus::Running,
                messages: vec![json!({"role": "user", "content": "hi"})],
                turns: 0,
                updated_at: now_ms(),
                finish_reason: None,
                error: None,
                stop: None,
                pending_approvals: vec![],
                user_question: None,
                todo: None,
                scope: None,
                usage: RunUsage::default(),
                last_meta: None,
            }),
            tx,
            approvals: Mutex::new(HashMap::new()),
            question_tx: Mutex::new(None),
            recall: Mutex::new(HashMap::new()),
            packed_cache: Mutex::new(HashMap::new()),
            abort: tokio::task::current().abort_handle(),
            client: reqwest::Client::new(),
        });
        reg.lock().unwrap().insert("run_test".into(), shared.clone());

        let snap = shared.snapshot();
        assert_eq!(snap.id, "run_test");
        assert_eq!(snap.status, RunStatus::Running);
        assert_eq!(snap.messages.len(), 1);

        shared.append(json!({"role": "assistant", "content": "hello"}));
        assert_eq!(shared.snapshot().messages.len(), 2);

        shared.mark_terminal(RunStatus::Done, Some("done".into()), None);
        assert!(RunShared::status_of(&shared).is_terminal());
        let _ = std::fs::remove_dir_all(_state.data_dir.clone());
    }

    #[tokio::test]
    async fn tool_dispatch_read_round_trip() {
        let (state, _reg) = fresh();
        let dir = state.data_dir.clone();
        std::fs::create_dir_all(dir.join("ws")).unwrap();
        let scope = dir.join("ws");
        // In-process dispatch of `write` then `read` (allow tier → no token).
        let shared = test_run(&state, &["write", "read"]);
        let w = tools::dispatch(&state, &shared, "write", &json!({"path": "a.txt", "content": "hello"})).await;
        assert!(w.get("ok").and_then(|v| v.as_bool()) == Some(true), "write: {w}");
        let r = tools::dispatch(&state, &shared, "read", &json!({"path": "a.txt"})).await;
        assert_eq!(r.get("content").and_then(|v| v.as_str()), Some("hello"));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn test_run(state: &S, tool_names: &[&str]) -> Arc<RunShared> {
        let (tx, _rx) = broadcast::channel(8);
        let meta = RunMeta {
            id: format!("run_test_{}", now_ms()),
            kind: "coder".into(),
            label: "test".into(),
            model: "m".into(),
            system: None,
            max_steps: 2,
            created_at: now_ms(),
            tool_set: "coder".into(),
            tool_names: tool_names.iter().map(|s| s.to_string()).collect(),
            tools_spec: Value::Array(vec![]),
            params: Value::Null,
            parent: None,
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
                todo: None,
                scope: None,
                usage: RunUsage::default(),
                last_meta: None,
            }),
            tx,
            approvals: Mutex::new(HashMap::new()),
            question_tx: Mutex::new(None),
            recall: Mutex::new(HashMap::new()),
            packed_cache: Mutex::new(HashMap::new()),
            abort: tokio::task::current().abort_handle(),
            client: reqwest::Client::new(),
        })
    }
}
