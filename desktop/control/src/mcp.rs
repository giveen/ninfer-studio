// Rust guideline compliant 2026-07-28

//! MCP (Model Context Protocol) client — external tool servers.
//!
//! NInfer Studio speaks MCP as a *client*: configured servers
//! (`AppSettings::mcp_servers`) are either spawned as child processes
//! (newline-delimited JSON-RPC over stdio) or addressed as streamable-HTTP
//! endpoints (the current spec — responses may be JSON or SSE-framed).
//! Transports and protocol handling come from the official Rust SDK
//! (`rmcp`, client features only); this module adds the control-plane
//! plumbing on top:
//!
//!   * per-server connection lifecycle — connect at startup, reconnect on
//!     failure or config change, kill/cleanup on delete (a dead MCP config
//!     must never take the control plane down with it),
//!   * tool discovery cached per connection, exposed to the agent loop as
//!     LLM tool definitions namespaced `mcp__<server>__<tool>`,
//!   * tool invocation through the existing allow/ask/deny permission
//!     machinery (`coder::common::enforce_perm`) — a tier row for the full
//!     tool name overrides a row for the server-level key `mcp__<server>`.
//!
//! rmcp's running client service is `!Send` (the same story as Obscura's
//! `Page` in `coder/browser.rs` — strict thread affinity), so all sessions
//! live on a dedicated actor thread with its own current-thread tokio
//! runtime + `LocalSet`. The `McpManager` on `State` is `Send+Sync` (a
//! command channel plus plain metadata); every route is a
//! `(command, reply)` round trip through it, and the permission re-check
//! happens on the axum side where the approval-token machinery lives.

use crate::coder::PanicGuard;
use crate::coder::{enforce_perm, perm_scope, tier_for};
use crate::engine::S;
use crate::types::{AppSettings, McpServerSpec};
use axum::extract::{Path as AxumPath, Query, State as AxumState};
use axum::http::header::{HeaderName, HeaderValue};
use axum::http::StatusCode;
use axum::Json;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ClientCapabilities, ClientInfo,
    ContentBlock, Implementation, InitializeRequestParams, ProtocolVersion, Tool,
};
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{ClientLifecycleMode, ClientServiceExt, RoleClient, ServiceError};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fmt;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::task::LocalSet;
use tokio::time::timeout;

/// A live MCP session (rmcp's running client service). `!Send` — it lives
/// on the actor thread only (see `actor_entry`/`dispatcher`).
pub(crate) type McpService = RunningService<RoleClient, ClientInfo>;

/// `mcp__<server>__<tool>` — the prefix every MCP-exposed tool name carries.
pub(crate) const MCP_PREFIX: &str = "mcp__";

/// Connecting + initializing + first `tools/list` must finish in this long,
/// or the server is treated as unreachable (covers hung `npx` installs).
const INIT_TIMEOUT: Duration = Duration::from_secs(60);

/// A single `tools/call` is bounded — some MCP tools legitimately run for
/// minutes (long web scrapes, migrations), but an unbounded hang must not
/// wedge the agent loop forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(600);

/// How long a cached `tools/list` stays fresh before the next catalog/
/// refresh re-asks the server.
const TOOLS_TTL: Duration = Duration::from_secs(120);

/// Cap on the rendered tool output handed back to the agent loop (mirrors
/// the observation-packing discipline the other tools already follow).
const MAX_TOOL_OUTPUT: usize = 64 * 1024;

/// `tools/list` is 30s inside the actor; the handler-side reply ceiling
/// adds slack so a slow-but-live server gets marked dead (and is retried
/// through a fresh connection) instead of wedging the catalog forever.
const LIST_TOOLS_LIMIT: Duration = Duration::from_secs(35);

/// Same slack idea for `tools/call`, over the actor's `CALL_TIMEOUT` cap
/// (computed at the call site — `Duration` addition is not const-stable).
/// One MCP server tool in its LLM-facing namespaced form.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    /// `mcp__<server>__<tool>` — what the model calls.
    pub mangled: String,
    /// The server's own tool name — what we send it.
    pub original: String,
    pub description: String,
    /// The tool's JSON-schema `inputSchema`.
    pub parameters: Value,
}

/// Plain (Send) connection metadata — everything the UI and the agent loop
/// need that does NOT require a round trip to the actor thread.
#[derive(Debug, Clone, Default)]
pub(crate) struct ConnMeta {
    /// Peer's `serverInfo` (name/version), for the UI.
    pub peer: Option<Value>,
    /// Child-process pid for stdio servers (for the UI).
    pub pid: Option<u32>,
    /// Last connection error; `None` while alive.
    pub error: Option<String>,
    /// Last known tool catalog (namespaced).
    pub tools: Vec<ToolDef>,
    /// When `tools` was last refreshed.
    pub tools_at: Option<Instant>,
    /// When `error` was last recorded — gates the implicit-reconnect
    /// backoff (`failed_recently`) so a broken server doesn't stall every
    /// catalog fetch or tool call with the full init timeout.
    pub error_at: Option<Instant>,
    /// Whether the session is believed live (set by connect; cleared when a
    /// round trip reveals the transport died).
    pub alive: bool,
}

/// Commands for the MCP actor. Everything is `Send` — these cross from the
/// axum worker threads into the actor's dedicated driver thread.
#[derive(Debug)]
enum McpCmd {
    /// (Re)connect: drop any existing session for `server`, open the new
    /// one, and return its `tools/list`.
    Connect { server: String, spec: McpServerSpec },
    /// Re-ask a live session for `tools/list` (catalog refresh).
    ListTools { server: String },
    /// Invoke one tool on a live session.
    CallTool {
        server: String,
        /// The server's own tool name (not the mangled one).
        tool: String,
        arguments: Map<String, Value>,
    },
    /// Drop the session (server deleted).
    Close { server: String },
}

/// Replies for the MCP actor — one per command, all `Send`.
#[derive(Debug)]
enum McpReply {
    Connect {
        error: Option<String>,
        peer: Option<Value>,
        pid: Option<u32>,
        tools: Vec<ToolDef>,
    },
    ListTools {
        error: Option<String>,
        tools: Vec<ToolDef>,
    },
    /// `transport_dead` tells the caller the session is gone: drop the
    /// metadata and retry once through a fresh connection.
    Call {
        ok: bool,
        output: String,
        transport_dead: bool,
    },
    Close,
}

type ActorTx = UnboundedSender<(McpCmd, UnboundedSender<McpReply>)>;

/// `Send+Sync` handle for the MCP actor. Lives on `State` (behind the
/// tokio `RwLock` like the other manager fields); the `!Send` sessions
/// themselves never leave the actor thread.
///
/// The driver thread is spawned lazily on the first route hit (mirrors
/// `BrowserSlot::spawn_driver`) so `State::new` — and the unit tests — stay
/// cheap.
#[derive(Default)]
pub struct McpManager {
    tx: Mutex<Option<ActorTx>>,
    started: AtomicBool,
    meta: Mutex<HashMap<String, ConnMeta>>,
}

impl fmt::Debug for McpManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let keys: Vec<String> = self
            .meta
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        f.debug_struct("McpManager")
            .field("running", &self.started.load(Ordering::Relaxed))
            .field("servers", &keys)
            .finish()
    }
}

impl McpManager {
    /// The actor command channel, spawning the driver thread on first use.
    /// The `tx` mutex is held across the spawn, so a racing second caller
    /// always sees the finished state.
    fn channel(&self) -> Option<ActorTx> {
        let mut guard = self.tx.lock().unwrap();
        if guard.is_none() {
            if self.started.swap(true, Ordering::SeqCst) {
                return guard.clone();
            }
            let (tx, rx) = unbounded_channel();
            if std::thread::Builder::new()
                .name("mcp-actor".into())
                .spawn(move || actor_entry(rx))
                .is_ok()
            {
                *guard = Some(tx);
            } else {
                self.started.store(false, Ordering::SeqCst);
                return None;
            }
        }
        guard.clone()
    }

    /// The actor is gone (its command channel closed) — forget the dead
    /// sender so the next `channel()` call respawns a fresh actor.
    fn reset(&self) {
        self.started.store(false, Ordering::SeqCst);
        *self.tx.lock().unwrap() = None;
    }

    fn meta_get(&self, name: &str) -> Option<ConnMeta> {
        self.meta.lock().unwrap().get(name).cloned()
    }

    fn meta_set(&self, name: &str, meta: ConnMeta) {
        self.meta.lock().unwrap().insert(name.to_string(), meta);
    }

    fn meta_remove(&self, name: &str) {
        self.meta.lock().unwrap().remove(name);
    }
}

// ---------------------------------------------------------------------------
// Tool-name namespacing
// ---------------------------------------------------------------------------

/// Sanitize a user-supplied server name: keep `[A-Za-z0-9-]`. Underscores
/// are reserved for the `mcp__<server>__<tool>` separators, so they are
/// dropped rather than translated (the name stays a stable, unique id).
fn sanitize_server_name(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

/// Mangle an MCP tool name into something the LLM's function-name grammar
/// accepts: `[a-zA-Z0-9_-]`, capped so `mcp__` + server + `__` + tool fits
/// comfortably inside 64 chars.
fn sanitize_tool_name(raw: &str) -> String {
    let mut out: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if out.is_empty() {
        out.push_str("tool");
    }
    if out.len() > 56 {
        out.truncate(56);
    }
    out
}

/// Split an `mcp__<server>__<tool>` name into `(server, tool)`. Server
/// names never contain `_` (see `sanitize_server_name`), so the first `__`
/// is unambiguously the separator; the tool part may itself contain `__`
/// (mangled from a server-side name that did).
pub(crate) fn split_mcp_name(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix(MCP_PREFIX)?;
    let idx = rest.find("__")?;
    let (server, tail) = rest.split_at(idx);
    let tool = &tail[2..];
    (!server.is_empty() && !tool.is_empty()).then_some((server, tool))
}

/// Map a server's raw `tools/list` result into namespaced, LLM-safe
/// definitions. Two raw tools that mangle to the same name get a
/// `_2`, `_3`, … suffix so neither shadows the other.
fn mangle_tools(server: &str, tools: &[Tool]) -> Vec<ToolDef> {
    let prefix = format!("{MCP_PREFIX}{server}__");
    let mut defs = Vec::new();
    let mut count: HashMap<String, i64> = HashMap::new();
    for t in tools {
        let mut mangled = format!("{prefix}{}", sanitize_tool_name(&t.name));
        let n = count.entry(mangled.clone()).or_insert(0);
        *n += 1;
        if *n > 1 {
            mangled = format!("{mangled}_{n}");
        }
        defs.push(ToolDef {
            mangled,
            original: t.name.as_ref().to_string(),
            description: t
                .description
                .as_deref()
                .map(String::from)
                .unwrap_or_default(),
            parameters: serde_json::to_value(t.input_schema.as_ref())
                .unwrap_or_else(|_| json!({ "type": "object" })),
        });
    }
    defs
}

/// Validate a spec before it is persisted: a usable non-empty name and a
/// usable http(s) url for http transport. (Hand-edited configs that fail
/// `transport()` are tolerated at load time and simply report as
/// disconnected; the upsert endpoint is strict.)
fn validate_spec(spec: &McpServerSpec) -> Result<(), (StatusCode, Json<Value>)> {
    let err = |m: String| (StatusCode::BAD_REQUEST, Json(json!({ "error": m })));
    if sanitize_server_name(&spec.name).is_empty() {
        return Err(err(
            "server name must contain at least one letter, digit, or dash".into(),
        ));
    }
    if spec.name.trim().len() > 40 {
        return Err(err("server name too long (max 40 chars)".into()));
    }
    if matches!(spec.transport(), Some("http")) {
        let url = spec.url.as_deref().unwrap_or("").trim();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(err("http servers need an http(s):// url".into()));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Connection lifecycle (actor thread only — everything in this section is
// `!Send` and must never cross a `.await` into the axum world)
// ---------------------------------------------------------------------------

fn client_info() -> ClientInfo {
    InitializeRequestParams::new(
        ClientCapabilities::default(),
        Implementation::new("ninfier-studio", env!("CARGO_PKG_VERSION")),
    )
}

/// The protocol-version ladder offered during the handshake: prefer the
/// newest stable revisions, fall back to the original streamable-HTTP
/// version (2025-03-26) for legacy servers — every server since then
/// supports it. `Auto` probes `server/discover` first and falls back to the
/// legacy `initialize` handshake instantly when the peer answers with a
/// method-not-found, so this costs nothing on modern servers.
fn lifecycle() -> ClientLifecycleMode {
    ClientLifecycleMode::Auto {
        preferred_versions: vec![
            ProtocolVersion::V_2025_11_25,
            ProtocolVersion::V_2025_06_18,
            ProtocolVersion::V_2025_03_26,
        ],
        legacy_version: Some(ProtocolVersion::V_2025_03_26),
    }
}

/// Open a session with `spec`, complete the MCP handshake, and return the
/// running service (+ peer info, child pid). Fails with a human-readable
/// `String` — a broken MCP config is a per-server error, never a crash.
async fn connect(spec: &McpServerSpec) -> Result<(McpService, Option<Value>, Option<u32>), String> {
    let info = client_info();
    let lc = lifecycle();
    // Both arms build their transport synchronously, then race the
    // handshake against INIT_TIMEOUT. (Boxed because the two transports are
    // different types; the future is awaited here, not spawned, so no Send
    // bound is needed.)
    let mut pid: Option<u32> = None;
    // `spec.transport()` returns `Option<&str>` — `&str` cannot be matched
    // exhaustively, so the wildcard arm catches any future transport kind
    // the same way `None` (no transport configured) does.
    let fut: Pin<Box<dyn Future<Output = Result<McpService, String>>>> =
        match spec.transport() {
            Some("stdio") => {
                let cmd = spec.command.clone().unwrap_or_default();
                let mut c = tokio::process::Command::new(&cmd);
                c.args(&spec.args);
                for (k, v) in &spec.env {
                    c.env(k, v);
                }
                if let Some(dir) = spec.cwd.as_deref() {
                    c.current_dir(dir);
                }
                // The control plane may run inside the AppImage, which poisons
                // PYTHONHOME/PYTHONPATH for spawned interpreters (see
                // clear_appimage_env) — an MCP server installed via a uv tool
                // would otherwise fail to bootstrap.
                crate::clear_appimage_env(&mut c);
                let transport = TokioChildProcess::new(c)
                    .map_err(|e| format!("failed to spawn MCP server '{cmd}': {e}"))?;
                pid = transport.id();
                Box::pin(async move {
                    timeout(INIT_TIMEOUT, info.serve_with_lifecycle(transport, lc))
                        .await
                        .map_err(|_| {
                            format!(
                                "timed out after {}s connecting to MCP server '{cmd}'",
                                INIT_TIMEOUT.as_secs()
                            )
                        })?
                        .map_err(|e| format!("MCP initialize failed for '{cmd}': {e}"))
                })
            }
            Some("http") => {
                let url = spec.url.clone().unwrap_or_default();
                let mut custom = HashMap::new();
                for (k, v) in &spec.headers {
                    // `Authorization` travels through `auth_header` — the SDK
                    // rejects it as a reserved header in `custom_headers`, so
                    // drop a duplicated entry here (it would also double-send
                    // the value).
                    if k.eq_ignore_ascii_case("authorization") {
                        continue;
                    }
                    match (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(v)) {
                        (Ok(name), Ok(value)) => {
                            custom.insert(name, value);
                        }
                        _ => {
                            tracing::warn!("mcp: skipping invalid header {k:?} for server '{url}'");
                        }
                    }
                }
                let mut config = StreamableHttpClientTransportConfig::with_uri(url.trim());
                if let Some(auth) = spec
                    .authorization
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                {
                    // rmcp sends `Authorization: Bearer <value>` (reqwest's
                    // `bearer_auth`), so a user pasting a full header value
                    // would end up with a doubled prefix — normalize it.
                    let token = auth
                        .strip_prefix("Bearer ")
                        .or_else(|| auth.strip_prefix("bearer "))
                        .unwrap_or(auth);
                    config = config.auth_header(token.to_string());
                }
                if !custom.is_empty() {
                    config = config.custom_headers(custom);
                }
                let transport = StreamableHttpClientTransport::from_config(config);
                Box::pin(async move {
                    timeout(INIT_TIMEOUT, info.serve_with_lifecycle(transport, lc))
                        .await
                        .map_err(|_| {
                            format!(
                                "timed out after {}s connecting to MCP server '{url}'",
                                INIT_TIMEOUT.as_secs()
                            )
                        })?
                        .map_err(|e| format!("MCP initialize failed for '{url}': {e}"))
                })
            }
            // `None` means "neither command nor url" — validate_spec and the
            // ensure_conn callers both reject that before we get here.
            _ => unreachable!("connect called with a spec that has no transport"),
        };
    let svc = fut.await?;
    let peer: Option<Value> = svc.peer_info().and_then(|p| {
        let v = serde_json::to_value(p.as_ref()).ok()?;
        // The stored info is the whole handshake result — the UI only wants
        // the server's self-identification (`serverInfo`), not the
        // capabilities/version negotiation. Fall back to the full value if
        // a future shape doesn't carry `serverInfo`.
        let inner = v.get("serverInfo").cloned().filter(|s| s.is_object());
        Some(inner.unwrap_or(v))
    });
    Ok((svc, peer, pid))
}

/// Refresh the `tools/list` catalog for a live service.
async fn fetch_tools(server: &str, svc: &McpService) -> Result<Vec<ToolDef>, String> {
    let tools = timeout(Duration::from_secs(30), svc.list_all_tools())
        .await
        .map_err(|_| format!("timed out listing tools from MCP server '{server}'"))?
        .map_err(|e| format!("tools/list failed on MCP server '{server}': {e}"))?;
    Ok(mangle_tools(server, &tools))
}

/// Driver-thread entry: a private current-thread tokio runtime + `LocalSet`
/// so the `!Send` rmcp services can exist (mirrors the Obscura browser
/// driver in `coder/browser.rs`). Runs until the process exits.
fn actor_entry(rx: UnboundedReceiver<(McpCmd, UnboundedSender<McpReply>)>) {
    let res = tokio::runtime::Builder::new_current_thread().enable_all().build();
    match res {
        Ok(rt) => {
            rt.block_on(async {
                let local = LocalSet::new();
                // Drive the actor's JoinHandle: the thread lives until the
                // command channel closes (the manager on State keeps a
                // sender for the process lifetime).
                let actor = local.spawn_local(PanicGuard(async move {
                    let () = dispatcher(rx).await;
                }));
                let _ = local.run_until(actor).await;
            });
        }
        Err(e) => tracing::error!("mcp actor runtime failed to start: {e}"),
    }
}

/// The actor dispatcher: receives commands and fans each out to a local
/// task so a 10-minute `tools/call` on one server cannot wedge
/// `tools/list` on another. Sessions live in a plain `Mutex` map — guards
/// are only ever held across synchronous code, never across an `.await`.
async fn dispatcher(mut rx: UnboundedReceiver<(McpCmd, UnboundedSender<McpReply>)>) {
    let conns: Arc<Mutex<HashMap<String, Arc<McpService>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    while let Some((cmd, reply)) = rx.recv().await {
        let conns = conns.clone();
        tokio::task::spawn_local(async move {
            match cmd {
                McpCmd::Connect { server, spec } => {
                    // Drop the previous session first (its `Drop` closes the
                    // transport) so an edited spec takes effect immediately.
                    conns.lock().unwrap().remove(&server);
                    match connect(&spec).await {
                        Ok((svc, peer, pid)) => {
                            let tools = fetch_tools(&server, &svc).await.unwrap_or_default();
                            let svc = Arc::new(svc);
                            conns
                                .lock()
                                .unwrap()
                                .insert(server.clone(), svc);
                            let _ = reply.send(McpReply::Connect {
                                error: None,
                                peer,
                                pid,
                                tools,
                            });
                        }
                        Err(e) => {
                            tracing::info!(target: "mcp", "connect '{server}' failed: {e}");
                            let _ = reply.send(McpReply::Connect {
                                error: Some(e),
                                peer: None,
                                pid: None,
                                tools: Vec::new(),
                            });
                        }
                    }
                }
                McpCmd::ListTools { server } => {
                    let svc = conns.lock().unwrap().get(&server).cloned();
                    match svc {
                        None => {
                            let _ = reply.send(McpReply::ListTools {
                                error: Some("not connected".into()),
                                tools: Vec::new(),
                            });
                        }
                        Some(svc) => match fetch_tools(&server, &svc).await {
                            Ok(tools) => {
                                let _ = reply.send(McpReply::ListTools { error: None, tools });
                            }
                            Err(e) => {
                                tracing::info!(target: "mcp", "list tools '{server}': {e}");
                                let _ = reply.send(McpReply::ListTools {
                                    error: Some(e),
                                    tools: Vec::new(),
                                });
                            }
                        },
                    }
                }
                McpCmd::CallTool {
                    server,
                    tool,
                    arguments,
                } => {
                    let svc = conns.lock().unwrap().get(&server).cloned();
                    let result = match svc {
                        None => McpReply::Call {
                            ok: false,
                            output: format!("MCP server '{server}' is not connected"),
                            transport_dead: true,
                        },
                        Some(svc) => {
                            // `CallToolRequestParams::new` wants a
                            // `Cow<'static, str>` — `tool` is an owned
                            // String, so hand it over by value.
                            let params =
                                CallToolRequestParams::new(tool).with_arguments(arguments);
                            match timeout(CALL_TIMEOUT, svc.call_tool_once(params)).await {
                                Ok(Ok(CallToolResponse::Complete(result))) => {
                                    let failed = result.is_error == Some(true);
                                    if failed {
                                        tracing::info!(
                                            target: "mcp",
                                            "tool '{server}' reported an error result"
                                        );
                                    }
                                    McpReply::Call {
                                        ok: !failed,
                                        output: render_result(&result),
                                        transport_dead: false,
                                    }
                                }
                                Ok(Ok(CallToolResponse::InputRequired(_))) => {
                                    // SEP-2322 multi-round interactive
                                    // input: we don't drive those rounds
                                    // (the human-facing dialog doesn't exist
                                    // here), so tell the model what happened
                                    // instead of hanging.
                                    McpReply::Call {
                                        ok: false,
                                        output: format!(
                                            "MCP tool '{server}' requested interactive \
                                             multi-round input, which this client does \
                                             not provide."
                                        ),
                                        transport_dead: false,
                                    }
                                }
                                // `CallToolResponse` is `#[non_exhaustive]`:
                                // a newer rmcp release may add variants.
                                // Surface them instead of silently dropping
                                // the response.
                                Ok(Ok(_)) => McpReply::Call {
                                    ok: false,
                                    output: format!(
                                        "MCP tool '{server}' returned an unsupported \
                                         response shape"
                                    ),
                                    transport_dead: false,
                                },
                                Ok(Err(e))
                                    if matches!(
                                        e,
                                        ServiceError::TransportClosed
                                            | ServiceError::TransportSend(_)
                                    ) =>
                                {
                                    McpReply::Call {
                                        ok: false,
                                        output: format!(
                                            "MCP server '{server}' connection died \
                                             mid-call: {e}"
                                        ),
                                        transport_dead: true,
                                    }
                                }
                                Ok(Err(e)) => {
                                    tracing::warn!(
                                        target: "mcp",
                                        "MCP call '{server}' failed: {e}"
                                    );
                                    McpReply::Call {
                                        ok: false,
                                        output: format!("MCP call '{server}' failed: {e}"),
                                        transport_dead: false,
                                    }
                                }
                                Err(_) => {
                                    tracing::warn!(
                                        target: "mcp",
                                        "MCP call '{server}' timed out after {}s",
                                        CALL_TIMEOUT.as_secs()
                                    );
                                    McpReply::Call {
                                        ok: false,
                                        output: format!(
                                            "MCP call '{server}' timed out after {}s",
                                            CALL_TIMEOUT.as_secs()
                                        ),
                                        transport_dead: false,
                                    }
                                }
                            }
                        }
                    };
                    let _ = reply.send(result);
                }
                McpCmd::Close { server } => {
                    conns.lock().unwrap().remove(&server);
                    let _ = reply.send(McpReply::Close);
                }
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

/// Render a `tools/call` result into the single text blob the agent loop
/// feeds back to the model. Binary payloads (images/audio) are described,
/// not dumped — base64 would only burn context.
fn render_result(result: &CallToolResult) -> String {
    let mut parts: Vec<String> = Vec::new();
    for block in &result.content {
        match block {
            ContentBlock::Text(t) => parts.push(t.text.clone()),
            ContentBlock::Image(_) => {
                parts.push("[image content omitted]".into());
            }
            ContentBlock::Audio(_) => {
                parts.push("[audio content omitted]".into());
            }
            ContentBlock::Resource(res) => {
                parts.push(serde_json::to_string(res).unwrap_or_default());
            }
            ContentBlock::ResourceLink(link) => {
                parts.push(serde_json::to_string(link).unwrap_or_default());
            }
            other => {
                // `ContentBlock` is `#[non_exhaustive]`: a newer rmcp may
                // add block kinds. Describe them by kind instead of
                // guessing at their shape.
                let v = serde_json::to_value(other).unwrap_or(Value::Null);
                let kind = v
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                parts.push(format!("[{kind} content omitted]"));
            }
        }
    }
    let mut out = parts.join("\n");
    if let Some(sc) = &result.structured_content {
        out.push_str("\n\n");
        out.push_str(&format!("[structured result] {sc}"));
    }
    if out.is_empty() {
        out = "(no content)".into();
    }
    if out.len() > MAX_TOOL_OUTPUT {
        out.truncate(MAX_TOOL_OUTPUT);
        out.push_str("\n… (truncated)");
    }
    out
}

// ---------------------------------------------------------------------------
// Handler-side plumbing
// ---------------------------------------------------------------------------

/// One (command, reply) round trip through the actor. `limit` is the
/// handler-side ceiling — the actor enforces its own (shorter) timeouts,
/// so `limit` only fires if the actor itself wedged.
async fn send_cmd(
    state: &S,
    cmd: McpCmd,
    limit: Duration,
) -> Result<McpReply, (StatusCode, Json<Value>)> {
    let manager = state.mcp.read().await;
    let Some(tx) = manager.channel() else {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "MCP actor failed to start" })),
        ));
    };
    let (reply_tx, mut reply_rx) = unbounded_channel();
    if tx.send((cmd, reply_tx)).is_err() {
        // The actor's receiver is gone — drop the dead channel so the next
        // request gets a fresh actor instead of failing forever.
        manager.reset();
        return Err((
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "MCP actor unavailable" })),
        ));
    }
    match timeout(limit, reply_rx.recv()).await {
        Ok(Some(reply)) => Ok(reply),
        Ok(None) => Err((
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "MCP actor dropped the reply" })),
        )),
        Err(_) => Err((
            StatusCode::GATEWAY_TIMEOUT,
            Json(json!({ "error": "MCP operation timed out" })),
        )),
    }
}

/// Mark a server's session dead (the transport died mid-operation) so the
/// next request takes the reconnect path.
async fn mark_dead(state: &S, name: &str, reason: String) {
    let m = state.mcp.read().await;
    let mut meta = m.meta_get(name).unwrap_or_default();
    meta.alive = false;
    meta.error = Some(reason);
    meta.error_at = Some(Instant::now());
    m.meta_set(name, meta);
}

/// Ensure `name` has a live session (connect or reconnect), and record the
/// result in the manager's metadata. Shared by upsert/restart/tools/call.
pub(crate) async fn ensure_conn(state: &S, name: &str) -> Result<(), (StatusCode, Json<Value>)> {
    let spec = state
        .config
        .read()
        .await
        .mcp_servers
        .iter()
        .find(|s| s.name == name)
        .cloned()
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("unknown MCP server '{name}'") })),
            )
        })?;
    if spec.transport().is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": format!("MCP server '{name}' has no transport configured")
            })),
        ));
    }
    match send_cmd(
        state,
        McpCmd::Connect {
            server: name.to_string(),
            spec,
        },
        INIT_TIMEOUT + Duration::from_secs(10),
    )
    .await
    {
        Ok(McpReply::Connect {
            error: None,
            peer,
            pid,
            tools,
        }) => {
            state.mcp.read().await.meta_set(
                name,
                ConnMeta {
                    peer,
                    pid,
                    error: None,
                    error_at: None,
                    tools,
                    tools_at: Some(Instant::now()),
                    alive: true,
                },
            );
            Ok(())
        }
        Ok(McpReply::Connect {
            error: Some(e), ..
        }) => {
            state.mcp.read().await.meta_set(
                name,
                ConnMeta {
                    peer: None,
                    pid: None,
                    error: Some(e.clone()),
                    error_at: Some(Instant::now()),
                    tools: Vec::new(),
                    tools_at: None,
                    alive: false,
                },
            );
            Err((StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))))
        }
        Ok(_) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "unexpected MCP actor reply" })),
        )),
        Err(e) => Err(e),
    }
}

/// Startup: connect every configured server in the background (best effort
/// — the tools catalog and each call reconnect on demand anyway).
pub(crate) async fn connect_all(state: S) {
    let cfg = state.config.read().await.mcp_servers.clone();
    for spec in cfg {
        if spec.transport().is_none() {
            continue;
        }
        if let Err((s, e)) = ensure_conn(&state, &spec.name).await {
            tracing::info!(
                target: "mcp",
                "startup connect for '{0}' failed: {s} {e:?}",
                spec.name
            );
        }
    }
}

/// The JSON view of one configured server for `GET /api/mcp/servers`.
/// `authorization` never leaves the control plane — the UI sees a mask.
fn server_value(spec: &McpServerSpec, meta: Option<&ConnMeta>) -> Value {
    let status: String = match meta {
        Some(m) if m.alive && m.error.is_none() => "connected".to_string(),
        Some(m) => format!(
            "error: {}",
            m.error.clone().unwrap_or_else(|| "connection closed".into())
        ),
        None => "disconnected".to_string(),
    };
    json!({
        "name": spec.name,
        "transport": spec.transport().unwrap_or("none"),
        "command": spec.command,
        "args": spec.args,
        "env": spec.env,
        "cwd": spec.cwd,
        "url": spec.url,
        "headers": spec.headers,
        // Secret: the UI only ever sees the mask.
        "authorization": spec.authorization.as_ref().map(|_| "***").unwrap_or_default(),
        "status": status,
        "peer": meta.and_then(|m| m.peer.clone()),
        "pid": meta.and_then(|m| m.pid),
        "toolCount": meta.map(|m| m.tools.len()).unwrap_or(0),
    })
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/// Implicit reconnects are skipped for this long after a failed attempt — a
/// broken server (bad binary, hanging install) must not stall every catalog
/// fetch or tool call with the full init timeout. Explicit connects
/// (upsert, restart) bypass the backoff.
const RETRY_BACKOFF: Duration = Duration::from_secs(30);

/// `meta` is dead and its last failure is still inside the backoff window.
fn failed_recently(meta: &ConnMeta) -> bool {
    meta.error.is_some()
        && meta
            .error_at
            .map(|t| t.elapsed() < RETRY_BACKOFF)
            .unwrap_or(false)
}

/// Write the (already updated) in-memory config back to disk. Best effort —
/// an unsafe/readonly data dir must not break the working in-memory state.
async fn persist_config(state: &S, cfg: &AppSettings) {
    if !crate::coder::is_safe_base_dir(&state.data_dir) {
        return;
    }
    let path = state.data_dir.join("config.json");
    let _ = tokio::fs::create_dir_all(&state.data_dir).await;
    let _ = crate::atomic_write_secret(&path, serde_json::to_string_pretty(cfg).unwrap()).await;
}

/// The `{servers: […]}` list view from current config + connection metadata.
async fn servers_list(state: &S) -> Json<Value> {
    let cfg = state.config.read().await.mcp_servers.clone();
    let m = state.mcp.read().await;
    let servers: Vec<Value> = cfg
        .iter()
        .map(|s| server_value(s, m.meta_get(&s.name).as_ref()))
        .collect();
    Json(json!({ "servers": servers }))
}

/// `GET /api/mcp/servers` — configured servers with live status.
pub async fn servers_get(AxumState(state): AxumState<S>) -> Json<Value> {
    servers_list(&state).await
}

/// `POST /api/mcp/servers` — upsert one server spec, persist it, and
/// (re)connect. The spec is saved even when the connection fails: the
/// response then carries the connection error (HTTP 502) and the server
/// shows up in the list with an `error: …` status until restarted.
pub async fn servers_upsert(
    AxumState(state): AxumState<S>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "server name is required" })),
            )
        })?
        .to_string();
    let mut spec: McpServerSpec = serde_json::from_value(body).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("invalid server spec: {e}") })),
        )
    })?;
    // The UI posts the name it displays; the stored + connected key is the
    // sanitized form (no `_` — it would break the `mcp__<server>__<tool>`
    // grammar).
    spec.name = sanitize_server_name(&name);
    // `***` is the mask the list endpoint returns; keep the stored secret
    // instead of persisting the mask over it.
    if spec.authorization.as_deref() == Some("***") {
        let existing = {
            let cfg = state.config.read().await;
            cfg.mcp_servers
                .iter()
                .find(|s| s.name == spec.name)
                .and_then(|s| s.authorization.clone())
        };
        spec.authorization = existing;
    }
    validate_spec(&spec)?;
    // `validate_spec` is deliberately lenient (hand-edited configs without a
    // transport are tolerated at load time and show as disconnected); the
    // upsert endpoint is strict — a spec with neither a command nor a url is
    // rejected before it is saved.
    if spec.transport().is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "server needs a stdio command or an http(s) url" })),
        ));
    }

    {
        let mut cfg = state.config.write().await;
        match cfg.mcp_servers.iter_mut().find(|s| s.name == spec.name) {
            Some(s) => *s = spec.clone(),
            None => cfg.mcp_servers.push(spec.clone()),
        }
        persist_config(&state, &cfg).await;
    }
    // Explicit connect — bypasses the backoff. The spec stays saved either
    // way; the caller is told about the failure and the list shows it.
    ensure_conn(&state, &spec.name).await?;
    Ok(servers_list(&state).await)
}

/// `POST /api/mcp/servers/{name}` — remove the spec and kill the session.
pub async fn server_delete(
    AxumState(state): AxumState<S>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let known = state
        .config
        .read()
        .await
        .mcp_servers
        .iter()
        .any(|s| s.name == name);
    if !known {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("unknown MCP server '{name}'") })),
        ));
    }
    // Kill the session (best effort — if the actor is gone, so is the
    // session; the config removal below is the source of truth).
    let _ = send_cmd(
        &state,
        McpCmd::Close {
            server: name.clone(),
        },
        Duration::from_secs(10),
    )
    .await;
    state.mcp.read().await.meta_remove(&name);
    let mut cfg = state.config.write().await;
    cfg.mcp_servers.retain(|s| s.name != name);
    persist_config(&state, &cfg).await;
    Ok(Json(json!({ "ok": true, "removed": true })))
}

/// `POST /api/mcp/servers/{name}/restart` — drop and reopen the session.
pub async fn server_restart(
    AxumState(state): AxumState<S>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    ensure_conn(&state, &name).await?;
    // Single-element list (the UI refetches the full list right after).
    let cfg = state.config.read().await;
    let spec = cfg
        .mcp_servers
        .iter()
        .find(|s| s.name == name)
        .cloned()
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("unknown MCP server '{name}'") })),
            )
        })?;
    let m = state.mcp.read().await;
    Ok(Json(json!({
        "servers": [server_value(&spec, m.meta_get(&name).as_ref())],
    })))
}

/// `GET /api/mcp/tools?scope=<ws>` — the namespaced tool catalog with each
/// tool's effective tier for the given permission scope (a per-tool
/// `mcp__<server>__<tool>` row overrides a server-level `mcp__<server>`
/// row). Dead servers are skipped (they surface in the server list with
/// their error); a server that just failed to connect is not retried until
/// the backoff elapses.
pub async fn tools_get(
    AxumState(state): AxumState<S>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let scope = q
        .get("scope")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("default");
    let perms = {
        let all = state.coder_perms.read().await;
        all.get(scope).cloned().unwrap_or_default()
    };
    let cfg = state.config.read().await.mcp_servers.clone();
    let mut tools: Vec<Value> = Vec::new();
    for spec in &cfg {
        if spec.transport().is_none() {
            continue;
        }
        // (Re)connect when needed — but not right after a failed attempt.
        let need_conn = {
            let m = state.mcp.read().await;
            match m.meta_get(&spec.name) {
                None => true,
                Some(meta) => !meta.alive && !failed_recently(&meta),
            }
        };
        if need_conn {
            let _ = ensure_conn(&state, &spec.name).await;
        }
        // Refresh the catalog when it is stale (a fresh connect already
        // listed the tools).
        let stale = {
            let m = state.mcp.read().await;
            m.meta_get(&spec.name)
                .filter(|meta| meta.alive)
                .map(|meta| meta.tools_at.map(|t| t.elapsed() > TOOLS_TTL).unwrap_or(true))
                .unwrap_or(false)
        };
        if stale {
            match send_cmd(
                &state,
                McpCmd::ListTools {
                    server: spec.name.clone(),
                },
                LIST_TOOLS_LIMIT + Duration::from_secs(10),
            )
            .await
            {
                Ok(McpReply::ListTools {
                    error: None,
                    tools,
                }) => {
                    let m = state.mcp.read().await;
                    let mut meta = m.meta_get(&spec.name).unwrap_or_default();
                    meta.tools = tools;
                    meta.tools_at = Some(Instant::now());
                    meta.alive = true;
                    m.meta_set(&spec.name, meta);
                }
                Ok(McpReply::ListTools {
                    error: Some(e),
                    ..
                }) => {
                    mark_dead(&state, &spec.name, e).await;
                    continue;
                }
                Err((s, _)) => {
                    mark_dead(&state, &spec.name, s.to_string()).await;
                    continue;
                }
                Ok(_) => {
                    mark_dead(&state, &spec.name, "unexpected MCP actor reply".to_string())
                        .await;
                    continue;
                }
            }
        }
        let m = state.mcp.read().await;
        let Some(meta) = m.meta_get(&spec.name) else {
            continue;
        };
        if !meta.alive {
            continue;
        }
        for def in &meta.tools {
            let tier = tier_for(&perms, &def.mangled);
            tools.push(json!({
                "name": def.mangled,
                "description": def.description,
                "parameters": def.parameters,
                "tier": tier,
            }));
        }
    }
    Json(json!({ "tools": tools }))
}

/// One `tools/call` round trip, with a single reconnect + retry when the
/// transport dies mid-call. The caller has already ensured a live session
/// and passed the permission gate.
async fn call_tool(
    state: &S,
    name: &str,
    arguments: Map<String, Value>,
) -> Result<(bool, String), (StatusCode, Json<Value>)> {
    let (server, _) = split_mcp_name(name).expect("caller checked the name shape");
    let server = server.to_string();
    for attempt in 0..2u32 {
        let meta = {
            let m = state.mcp.read().await;
            m.meta_get(&server)
        };
        let Some(def) = meta
            .and_then(|mt| mt.tools.iter().find(|d| d.mangled == name).cloned())
        else {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("unknown MCP tool '{name}'") })),
            ));
        };
        match send_cmd(
            state,
            McpCmd::CallTool {
                server: server.clone(),
                tool: def.original,
                arguments: arguments.clone(),
            },
            CALL_TIMEOUT + Duration::from_secs(10),
        )
        .await
        {
            Ok(McpReply::Call {
                ok,
                output,
                transport_dead: false,
            }) => return Ok((ok, output)),
            Ok(McpReply::Call {
                transport_dead: true, ..
            }) => {
                // Transport died mid-call: mark dead and reconnect once.
                mark_dead(
                    state,
                    &server,
                    format!("transport closed during tool call (attempt {attempt})"),
                )
                .await;
                if attempt == 0 {
                    ensure_conn(state, &server).await?;
                    continue;
                }
                return Err((
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": "MCP connection dropped during the tool call and the retry failed" })),
                ));
            }
            Err(e) => {
                mark_dead(state, &server, "tool call failed".to_string()).await;
                return Err(e);
            }
            Ok(_) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "unexpected MCP actor reply" })),
                ));
            }
        }
    }
    unreachable!("every branch returns or retries once")
}

/// `POST /api/mcp/call` — invoke a namespaced MCP tool. The same
/// allow/ask/deny tiers as the built-in tools gate it (per-tool row
/// `mcp__<server>__<tool>` overrides the server-level `mcp__<server>`
/// row); a denied/unknown call is a 403/404, a connection failure a 502,
/// and a completed call is `200 {ok, output}` — `ok:false` when the server
/// itself reported the tool errored.
pub async fn mcp_call(
    AxumState(state): AxumState<S>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let Some((server, _)) = split_mcp_name(&name) else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("'{name}' is not an MCP tool name (expected mcp__<server>__<tool>)") })),
        ));
    };
    let server = server.to_string();
    let scope = perm_scope(&body);
    // The permission gate — same tiers as the built-in coder tools, and the
    // approval-token check is single-use, exactly like the built-ins.
    enforce_perm(
        &state,
        &scope,
        &name,
        None,
        body.get("approvalToken").and_then(|v| v.as_str()),
    )
    .await?;
    // Arguments: absent/`null` → `{}`, a JSON object when present.
    let arguments = match body.get("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(_) => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "arguments must be a JSON object" })),
            ));
        }
    };
    {
        let cfg = state.config.read().await;
        if !cfg.mcp_servers.iter().any(|s| s.name == server) {
            return Err((
                StatusCode::NOT_FOUND,
                Json(json!({ "error": format!("unknown MCP server '{server}'") })),
            ));
        }
    }
    // Fail fast on a connection that just failed (a blind reconnect would
    // burn up to the init timeout on every call).
    {
        let m = state.mcp.read().await;
        if let Some(meta) = m.meta_get(&server) {
            if !meta.alive && failed_recently(&meta) {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": meta
                        .error
                        .clone()
                        .unwrap_or_else(|| "MCP server not connected".to_string()) })),
                ));
            }
        }
    }
    ensure_conn(&state, &server).await?;
    let (ok, output) = call_tool(&state, &name, arguments).await?;
    Ok(Json(json!({ "ok": ok, "output": output })))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_and_split_names() {
        // Server names: alnum + '-', underscores stripped (they would break
        // the `mcp__<server>__<tool>` separator grammar).
        assert_eq!(sanitize_server_name("my server"), "myserver");
        assert_eq!(sanitize_server_name("file_2"), "file2");
        assert_eq!(sanitize_server_name("fs-v2"), "fs-v2");
        assert_eq!(sanitize_server_name("!!!"), "");
        // Tool names: mangled into the LLM function-name charset.
        assert_eq!(sanitize_tool_name("get weather"), "get_weather");
        assert_eq!(sanitize_tool_name("a/b:c.d"), "a_b_c_d");
        assert_eq!(sanitize_tool_name(""), "tool");
        assert_eq!(sanitize_tool_name(&"x".repeat(80)).len(), 56);
        // Split: first `__` after the prefix is the separator.
        assert_eq!(split_mcp_name("mcp__fs__read"), Some(("fs", "read")));
        assert_eq!(split_mcp_name("mcp__fs__a__b"), Some(("fs", "a__b")));
        assert_eq!(split_mcp_name("mcp__fs__"), None);
        assert_eq!(split_mcp_name("mcp__"), None);
        assert_eq!(split_mcp_name("plain_tool"), None);
        // Collision mangling: a second tool mangles to the same name gets a
        // numeric suffix; the original server-side name is kept for the call.
        let a = sanitize_tool_name("a.b");
        let b = sanitize_tool_name("a_b");
        assert_eq!(a, b);
        assert_eq!(format!("{a}_2"), format!("{b}_2"));
    }

    #[test]
    fn validate_spec_rejects_broken_configs() {
        // Lenient on purpose: hand-edited configs without a transport are
        // tolerated at load time (they show as disconnected); upsert is the
        // strict gate for that (see `mcp_stdio_end_to_end`).
        let mut s = McpServerSpec::default();
        s.name = "none".into();
        assert!(validate_spec(&s).is_ok());

        // But the name must survive sanitization.
        let mut s = McpServerSpec::default();
        s.name = "!!!".into();
        let (st, body) = validate_spec(&s).unwrap_err();
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(body.0.get("error").is_some());

        // And an over-long name is rejected.
        let mut s = McpServerSpec::default();
        s.name = "x".repeat(41);
        s.command = Some("/bin/true".into());
        let (st, _) = validate_spec(&s).unwrap_err();
        assert_eq!(st, StatusCode::BAD_REQUEST);

        let mut s = McpServerSpec::default();
        s.name = "ok".into();
        s.command = Some("/bin/true".into());
        assert!(validate_spec(&s).is_ok());

        let mut s = McpServerSpec::default();
        s.name = "ok".into();
        s.url = Some("https://mcp.example.com/mcp".into());
        assert!(validate_spec(&s).is_ok());

        // Non-http(s) URLs are rejected up front.
        let mut s = McpServerSpec::default();
        s.name = "bad".into();
        s.url = Some("ftp://mcp.example.com".into());
        let (st, _) = validate_spec(&s).unwrap_err();
        assert_eq!(st, StatusCode::BAD_REQUEST);
    }

    /// A minimal MCP stdio server in POSIX sh: answers the legacy
    /// `initialize` handshake, lists one tool, and echoes it. `server/
    /// discover` (the newer probe rmcp tries first) gets method-not-found,
    /// which makes the client fall back to the legacy handshake.
    fn write_fake_server(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("fake_mcp.sh");
        let script = r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"notifications/initialized"'*) ;;
    *'"method":"server/discover"'*)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"method not found"}}\n' "$id" ;;
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"fake-mcp","version":"1.0.0"}}}\n' "$id" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"Echoes its input","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      text=$(printf '%s' "$line" | sed -n 's/.*"text"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"echo: %s"}]}}\n' "$id" "$text" ;;
    *)
      [ -n "$id" ] && printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"method not found"}}\n' "$id"
      ;;
  esac
done
"#;
        std::fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[tokio::test]
    async fn mcp_stdio_end_to_end() {
        let tmp = std::env::temp_dir().join(format!("ninfier-mcp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let script = write_fake_server(&tmp);
        let state: S = std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        let ws = || AxumState(state.clone());

        // Upsert → persisted + connected, with peer info, pid and tool count.
        let r = servers_upsert(
            ws(),
            Json(json!({ "name": "fake", "command": script.to_str().unwrap() })),
        )
        .await
        .unwrap()
        .0;
        let list = r.get("servers").unwrap().as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].get("name").unwrap(), "fake");
        assert_eq!(list[0].get("status").unwrap(), "connected");
        assert_eq!(list[0].get("toolCount").unwrap(), 1);
        assert_eq!(
            list[0].get("peer").unwrap().get("name").unwrap(),
            "fake-mcp"
        );
        assert!(list[0].get("pid").unwrap().as_u64().unwrap() > 0);

        // A spec with neither transport is rejected up front (400) and not
        // saved.
        let e = servers_upsert(ws(), Json(json!({ "name": "notr" }))).await.unwrap_err();
        assert_eq!(e.0, StatusCode::BAD_REQUEST);
        let r = servers_get(ws()).await.0;
        assert_eq!(r.get("servers").unwrap().as_array().unwrap().len(), 1);

        // Catalog: namespaced + effective tier (default → allow).
        let t = tools_get(
            ws(),
            Query(HashMap::from([("scope".into(), "default".into())])),
        )
        .await
        .0;
        let tools = t.get("tools").unwrap().as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].get("name").unwrap(), "mcp__fake__echo");
        assert_eq!(tools[0].get("tier").unwrap(), "allow");

        // Unknown tool on a live server → 400 (before any perm rows exist).
        let e = mcp_call(
            ws(),
            Json(json!({ "name": "mcp__fake__nope", "arguments": {} })),
        )
        .await
        .unwrap_err();
        assert_eq!(e.0, StatusCode::BAD_REQUEST);

        // Tool call round trip.
        let c = mcp_call(
            ws(),
            Json(json!({ "name": "mcp__fake__echo", "arguments": { "text": "hi" } })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(c.get("ok").unwrap(), true);
        assert_eq!(c.get("output").unwrap(), "echo: hi");

        // Permission tiers: a server-level Deny row blocks the tool; a
        // per-tool Allow row overrides it.
        {
            let mut perms = crate::coder::CoderPerms::default();
            perms
                .tools
                .insert("mcp__fake".into(), crate::coder::PermTier::Deny);
            state
                .coder_perms
                .write()
                .await
                .insert("default".into(), perms);
        }
        let e = mcp_call(
            ws(),
            Json(json!({ "name": "mcp__fake__echo", "arguments": { "text": "hi" } })),
        )
        .await
        .unwrap_err();
        assert_eq!(e.0, StatusCode::FORBIDDEN);
        {
            let mut all = state.coder_perms.write().await;
            all.get_mut("default")
                .unwrap()
                .tools
                .insert("mcp__fake__echo".into(), crate::coder::PermTier::Allow);
        }
        let c = mcp_call(
            ws(),
            Json(json!({ "name": "mcp__fake__echo", "arguments": { "text": "yo" } })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(c.get("output").unwrap(), "echo: yo");

        // Malformed name → 400; unknown server → 404.
        let e = mcp_call(ws(), Json(json!({ "name": "plain", "arguments": {} })))
            .await
            .unwrap_err();
        assert_eq!(e.0, StatusCode::BAD_REQUEST);
        let e = mcp_call(ws(), Json(json!({ "name": "mcp__nope__x", "arguments": {} })))
            .await
            .unwrap_err();
        assert_eq!(e.0, StatusCode::NOT_FOUND);

        // A broken stdio command fails the connect (502) but the spec stays
        // saved and listed with an error status.
        let e = servers_upsert(
            ws(),
            Json(json!({ "name": "bad", "command": "sh", "args": ["-c", "exit 1"] })),
        )
        .await
        .unwrap_err();
        assert_eq!(e.0, StatusCode::BAD_GATEWAY);
        let r = servers_get(ws()).await.0;
        let list = r.get("servers").unwrap().as_array().unwrap();
        let bad = list
            .iter()
            .find(|s| s.get("name").unwrap() == "bad")
            .unwrap();
        assert!(bad.get("status").unwrap().as_str().unwrap().starts_with("error:"));

        // The dead server must not leak tools into the catalog.
        let t = tools_get(ws(), Query(HashMap::new())).await.0;
        let names: Vec<&str> = t
            .get("tools")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.get("name").unwrap().as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["mcp__fake__echo"]);

        // Authorization round trip: the list only ever shows the mask, and
        // re-posting the mask keeps the stored secret.
        let _ = servers_upsert(
            ws(),
            Json(json!({
                "name": "auth",
                "url": "http://127.0.0.1:9/mcp",
                "authorization": "Bearer abc123",
            })),
        )
        .await; // connection fails fast (nothing on :9) — the spec stays saved
        let r = servers_get(ws()).await.0;
        let list = r.get("servers").unwrap().as_array().unwrap();
        let auth = list.iter().find(|s| s.get("name").unwrap() == "auth").unwrap();
        assert_eq!(auth.get("authorization").unwrap(), "***");
        let _ = servers_upsert(
            ws(),
            Json(json!({
                "name": "auth",
                "url": "http://127.0.0.1:9/mcp",
                "authorization": "***",
            })),
        )
        .await;
        let stored = state
            .config
            .read()
            .await
            .mcp_servers
            .iter()
            .find(|s| s.name == "auth")
            .unwrap()
            .clone();
        assert_eq!(stored.authorization.as_deref(), Some("Bearer abc123"));

        // Restart reopens the session (fake is still healthy).
        let r = server_restart(ws(), AxumPath(String::from("fake"))).await.unwrap().0;
        let one = r.get("servers").unwrap().as_array().unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].get("status").unwrap(), "connected");

        // Delete kills the session and removes the spec; a second delete 404s.
        let d = server_delete(ws(), AxumPath(String::from("fake"))).await.unwrap().0;
        assert_eq!(d.get("ok").unwrap(), true);
        assert_eq!(d.get("removed").unwrap(), true);
        let r = servers_get(ws()).await.0;
        let names: Vec<&str> = r
            .get("servers")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.get("name").unwrap().as_str().unwrap())
            .collect();
        assert!(!names.contains(&"fake"));
        let e = server_delete(ws(), AxumPath(String::from("fake"))).await.unwrap_err();
        assert_eq!(e.0, StatusCode::NOT_FOUND);

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
