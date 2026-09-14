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

use crate::coder::{enforce_perm, perm_scope, tier_for};
use crate::engine::S;
use crate::types::McpServerSpec;
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
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::timeout;

/// A live MCP session (rmcp's running client service).
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

/// A live connection (or the last known failure of one). `service` is an
/// `Arc` so an in-flight `tools/call` keeps the session alive while the
/// manager drops the connection (reconnect / delete / child exited).
struct McpConn {
    service: Option<Arc<McpService>>,
    /// Peer's `serverInfo` (name/version), for the UI.
    peer: Option<Value>,
    /// Child-process pid for stdio servers (for the UI).
    pid: Option<u32>,
    /// Last connection error; `None` while alive.
    error: Option<String>,
    tools: Vec<ToolDef>,
    tools_at: Option<Instant>,
}

impl fmt::Debug for McpConn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpConn")
            .field("alive", &self.alive())
            .field("pid", &self.pid)
            .field("error", &self.error)
            .field("tools", &self.tools.len())
            .finish()
    }
}

impl McpConn {
    fn alive(&self) -> bool {
        self.service.as_ref().is_some_and(|s| !s.is_closed())
    }
}

/// One connection slot per configured server.
#[derive(Debug, Default)]
pub struct McpManager {
    conns: HashMap<String, McpConn>,
}

// ---------------------------------------------------------------------------
// Tool-name namespacing
// ---------------------------------------------------------------------------

/// Sanitize a user-supplied server name: keep `[A-Za-z0-9-]`. Underscores
/// are reserved for the `mcp__<server>__<tool>` separators, so they are
/// dropped rather than translated (the name stays a stable, unique id).
fn sanitize_server_name(raw: &str) -> String {
    raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect()
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
            description: t.description.as_deref().map(String::from).unwrap_or_default(),
            parameters: serde_json::to_value(t.input_schema.as_ref())
                .unwrap_or_else(|_| json!({ "type": "object" })),
        });
    }
    defs
}

/// Validate a spec before it is persisted: a usable non-empty name and
/// exactly one transport. (`AppSettings::load` tolerates a hand-edited
/// config that violates this; the upsert endpoint is strict.)
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
// Connection lifecycle
// ---------------------------------------------------------------------------

fn client_info() -> ClientInfo {
    InitializeRequestParams::new(
        ClientCapabilities::default(),
        Implementation::new("ninfier-studio", env!("CARGO_PKG_VERSION")),
    )
}

/// The protocol-version ladder offered during the handshake: prefer the
/// current stable revisions, fall back to the original streamable-HTTP
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
    // Both arms build their transport synchronously, then race the handshake
    // against INIT_TIMEOUT. (Boxed because the two transports are different
    // types; the future is awaited here, not spawned, so no Send bound is
    // needed.)
    let mut pid: Option<u32> = None;
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
                    let key = k.to_ascii_lowercase();
                    if key == "authorization" {
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
            None => unreachable!("connect called with a spec that has no transport"),
        };
    let svc = fut.await?;
    let peer = svc
        .peer_info()
        .and_then(|p| serde_json::to_value(p.as_ref()).ok());
    Ok((svc, peer, pid))
}

/// Refresh the cached `tools/list` for a live service.
async fn fetch_tools(server: &str, svc: &McpService) -> Result<Vec<ToolDef>, String> {
    let tools = timeout(Duration::from_secs(30), svc.list_all_tools())
        .await
        .map_err(|_| format!("timed out listing tools from MCP server '{server}'"))?
        .map_err(|e| format!("tools/list failed on MCP server '{server}': {e}"))?;
    Ok(mangle_tools(server, &tools))
}

/// Ensure `name` has a live connection, connecting (or reconnecting) as
/// needed. Callers hold no `mcp` lock (this one takes the write lock).
pub(crate) async fn ensure_conn(state: &S, name: &str) -> Result<(), (StatusCode, Json<Value>)> {
    let mut m = state.mcp.write().await;
    ensure_conn_inner(state, &mut m, name)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))))
}

/// `ensure_conn` core, for callers that already hold the `mcp` write lock
/// (the tools catalog refreshes several servers in one pass).
async fn ensure_conn_inner(state: &S, m: &mut McpManager, name: &str) -> Result<(), String> {
    let spec = {
        let cfg = state.config.read().await;
        cfg.mcp_servers
            .iter()
            .find(|s| s.name == name)
            .cloned()
            .ok_or_else(|| format!("unknown MCP server '{name}'"))?
    };
    if spec.transport().is_none() {
        return Err(format!(
            "MCP server '{name}' has no usable transport (set command or url)"
        ));
    }
    if m.conns.get(name).is_some_and(|c| c.alive()) {
        return Ok(());
    }
    // Drop the dead slot: dropping the service Arc cancels the rmcp event
    // loop, which closes the transport — the stdio child is killed by its
    // own cleanup, the HTTP session just ends.
    m.conns.remove(name);
    match connect(&spec).await {
        Ok((svc, peer, pid)) => {
            let svc = Arc::new(svc);
            // A tools/list failure doesn't kill the connection — the server
            // is up; tools just can't be listed right now. Callers surface
            // the (empty) catalog and `tools/call` falls back to the raw
            // suffix, which works for the common case of LLM-safe names.
            let tools = fetch_tools(name, &svc).await.unwrap_or_default();
            m.conns.insert(
                name.to_string(),
                McpConn {
                    service: Some(svc),
                    peer,
                    pid,
                    error: None,
                    tools,
                    tools_at: Some(Instant::now()),
                },
            );
            Ok(())
        }
        Err(e) => {
            m.conns.insert(
                name.to_string(),
                McpConn {
                    service: None,
                    peer: None,
                    pid: None,
                    error: Some(e.clone()),
                    tools: vec![],
                    tools_at: None,
                },
            );
            Err(e)
        }
    }
}

/// Connect every configured server. Fired at control-plane startup (and
/// after a config reload); failures are recorded per server, never fatal.
pub(crate) async fn connect_all(state: S) {
    let specs = state.config.read().await.mcp_servers.clone();
    for spec in specs {
        if let Err(e) = ensure_conn(&state, &spec.name).await {
            tracing::warn!(target: "mcp", "startup connect failed for '{}': {:?}", spec.name, e.1);
        }
    }
}

/// Serialize one configured server for the management endpoints.
fn server_value(spec: &McpServerSpec, conn: Option<&McpConn>) -> Value {
    let status: String = match conn {
        Some(c) if c.alive() => "connected".to_string(),
        Some(c) => format!(
            "error: {}",
            c.error.clone().unwrap_or_else(|| "connection closed".into())
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
        "peer": conn.and_then(|c| c.peer.clone()),
        "pid": conn.and_then(|c| c.pid),
        "toolCount": conn.map(|c| c.tools.len()).unwrap_or(0),
    })
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
            ContentBlock::Image(img) => parts.push(format!(
                "[image, {} — {} bytes of base64 omitted]",
                img.mime_type,
                img.data.len()
            )),
            ContentBlock::Audio(a) => parts.push(format!(
                "[audio, {} — {} bytes of base64 omitted]",
                a.mime_type,
                a.data.len()
            )),
            ContentBlock::Resource(r) => parts
                .push(serde_json::to_string(r).unwrap_or_else(|_| "[resource omitted]".into())),
            ContentBlock::ResourceLink(r) => parts
                .push(serde_json::to_string(r).unwrap_or_else(|_| "[resource link omitted]".into())),
            // `ContentBlock` is non-exhaustive in rmcp — future content kinds
            // are described, never dumped raw.
            other => {
                let v = serde_json::to_value(other).unwrap_or(Value::Null);
                let kind = v
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("unknown");
                parts.push(format!("[{kind} content omitted]"));
            }
        }
    }
    let mut out = parts.join("\n");
    if let Some(sc) = &result.structured_content {
        if !out.is_empty() {
            out.push('\n');
        }
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
// Routes: /api/mcp/*
// ---------------------------------------------------------------------------

/// `GET /api/mcp/servers` — configured servers with live status.
pub async fn servers_get(AxumState(state): AxumState<S>) -> Json<Value> {
    let cfg = state.config.read().await.clone();
    let m = state.mcp.read().await;
    let servers: Vec<Value> = cfg
        .mcp_servers
        .iter()
        .map(|spec| server_value(spec, m.conns.get(&spec.name)))
        .collect();
    Json(json!({ "servers": servers }))
}

/// `POST /api/mcp/servers` — upsert one server spec, persist it, and (re)
/// connect. The connection is always dropped first so an edited spec takes
/// effect immediately.
pub async fn servers_upsert(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let mut spec: McpServerSpec = serde_json::from_value(req)
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid server spec: {e}") })),
            )
        })?;
    let raw_name = spec.name.trim().to_string();
    spec.name = sanitize_server_name(&raw_name);
    if let Some(u) = spec.url.as_mut() {
        *u = u.trim().to_string();
    }
    if let Some(c) = spec.command.as_mut() {
        *c = c.trim().to_string();
    }
    validate_spec(&spec)?;

    {
        let mut cfg = state.config.write().await;
        match cfg.mcp_servers.iter().position(|s| s.name == spec.name) {
            Some(i) => cfg.mcp_servers[i] = spec.clone(),
            None => cfg.mcp_servers.push(spec.clone()),
        }
    }
    let cfg = state.config.read().await.clone();
    crate::routes_config::persist_config(&state, &cfg)
        .await
        .map_err(|(_, e)| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))))?;

    {
        let mut m = state.mcp.write().await;
        m.conns.remove(&spec.name);
    }
    ensure_conn(&state, &spec.name).await?;
    Ok(servers_get(AxumState(state.clone())).await)
}

/// `POST /api/mcp/servers/{name}` — drop the connection and remove the
/// spec from the persisted config. (POST rather than DELETE: the control
/// plane's CORS allow-list only carries GET/POST.)
pub async fn server_delete(
    AxumState(state): AxumState<S>,
    AxumPath(name): AxumPath<String>,
) -> Json<Value> {
    {
        let mut m = state.mcp.write().await;
        m.conns.remove(&name);
    }
    let changed = {
        let mut cfg = state.config.write().await;
        let before = cfg.mcp_servers.len();
        cfg.mcp_servers.retain(|s| s.name != name);
        cfg.mcp_servers.len() != before
    };
    if changed {
        let cfg = state.config.read().await.clone();
        if let Err((s, e)) = crate::routes_config::persist_config(&state, &cfg).await {
            // The in-memory state is already updated; without this the
            // removal would silently come back on the next start.
            tracing::warn!(target: "mcp", "config not persisted after removing MCP server '{name}': {s} {e}");
        }
    }
    Json(json!({ "ok": true, "removed": changed }))
}

/// `POST /api/mcp/servers/{name}/restart` — force a reconnect now.
pub async fn server_restart(
    AxumState(state): AxumState<S>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    {
        let mut m = state.mcp.write().await;
        m.conns.remove(&name);
    }
    ensure_conn(&state, &name).await?;
    Ok(servers_get(AxumState(state.clone())).await)
}

/// `GET /api/mcp/tools?scope=<workspace>` — the merged catalog of
/// `mcp__<server>__<tool>` definitions (LLM-ready), each annotated with its
/// effective permission tier for `scope` (per-tool row wins over the
/// per-server `mcp__<server>` row; default `allow`). Servers are connected
/// (or reconnected) here on demand, and stale `tools/list` caches are
/// refreshed.
pub async fn tools_get(
    AxumState(state): AxumState<S>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let scope = q.get("scope").map(String::as_str).unwrap_or("default");
    let perms = state
        .coder_perms
        .read()
        .await
        .get(scope)
        .cloned()
        .unwrap_or_default();
    let cfg = state.config.read().await.mcp_servers.clone();
    let mut m = state.mcp.write().await;
    let mut tools: Vec<Value> = Vec::new();
    for spec in &cfg {
        if spec.transport().is_none() {
            continue;
        }
        if let Err(e) = ensure_conn_inner(&state, &mut m, &spec.name).await {
            tracing::warn!(target: "mcp", "tools refresh failed for '{}': {e}", spec.name);
            continue;
        }
        if let Some(c) = m.conns.get_mut(&spec.name) {
            if c.alive() && c.tools_at.map(|t| t.elapsed() > TOOLS_TTL).unwrap_or(true) {
                if let Some(svc) = &c.service {
                    if let Ok(fresh) = fetch_tools(&spec.name, svc).await {
                        c.tools = fresh;
                        c.tools_at = Some(Instant::now());
                    }
                }
            }
            for td in &c.tools {
                tools.push(json!({
                    "name": td.mangled,
                    "description": td.description,
                    "parameters": td.parameters,
                    "tier": serde_json::to_value(tier_for(&perms, &td.mangled)).unwrap(),
                }));
            }
        }
    }
    Json(json!({ "tools": tools }))
}

/// `POST /api/mcp/call` — body `{ name: "mcp__<server>__<tool>",
/// arguments?: object, scope?: string, approvalToken?: string }`.
///
/// Permission gate first (same allow/ask/deny tiers as the built-in tools,
/// re-checked server-side via `enforce_perm` so a client-side dispatcher
/// cannot route around `deny`/`ask`), then the `tools/call`. Tool-level
/// failures come back as `{ ok: false, output }` — the agent loop feeds
/// that straight to the model, which is usually the better outcome than an
/// HTTP error for a single misbehaving external tool.
pub async fn mcp_call(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let name = req
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(json!({ "error": "name required" }))))?;
    let (server, _tool) = split_mcp_name(name).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("'{name}' is not an mcp__<server>__<tool> name") })),
        )
    })?;
    // A name for a server that isn't configured is a 404, not a connection
    // error — the model can react to "no such server" without burning a
    // reconnect attempt.
    if !state.config.read().await.mcp_servers.iter().any(|s| s.name == server) {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("unknown MCP server '{server}'") })),
        ));
    }
    let scope = perm_scope(&req);
    let token = req.get("approvalToken").and_then(|v| v.as_str());
    enforce_perm(&state, &scope, name, None, token).await?;

    let arguments: Map<String, Value> = match req.get("arguments") {
        Some(Value::Object(o)) => o.clone(),
        Some(Value::Null) | None => Map::new(),
        Some(_) => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "arguments must be an object" })),
            ))
        }
    };

    // Up to two attempts: a transport-level failure (child died, HTTP
    // session dropped) gets one reconnect + retry; protocol-level errors
    // are surfaced to the agent as-is.
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let (svc, original) = {
            ensure_conn(&state, server).await?;
            let m = state.mcp.read().await;
            let conn = m.conns.get(server);
            let svc = conn
                .and_then(|c| c.service.clone())
                .ok_or_else(|| {
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(json!({ "error": format!("MCP server '{server}' is not connected") })),
                    )
                })?;
            // Mangled name → the server's own tool name; fall back to the raw
            // suffix when the cache is empty (works whenever the server's
            // tool names are already LLM-safe, which is the common case).
            let mangled_tool = &name[MCP_PREFIX.len() + server.len() + 2..];
            let original = conn
                .and_then(|c| c.tools.iter().find(|t| t.mangled == name))
                .map(|t| t.original.clone())
                .unwrap_or_else(|| mangled_tool.to_string());
            (svc, original)
        };

        let params = CallToolRequestParams::new(original.as_str()).with_arguments(arguments.clone());
        match timeout(CALL_TIMEOUT, svc.call_tool_once(params)).await {
            Ok(Ok(CallToolResponse::Complete(result))) => {
                let failed = result.is_error == Some(true);
                if failed {
                    tracing::info!(target: "mcp", "tool '{name}' reported an error result");
                }
                return Ok(Json(json!({
                    "ok": !failed,
                    "output": render_result(&result),
                })));
            }
            Ok(Ok(CallToolResponse::InputRequired(_))) => {
                // SEP-2322 multi-round interactive input: we don't drive
                // those rounds (the human-facing dialog doesn't exist here),
                // so tell the model what happened instead of hanging.
                return Ok(Json(json!({
                    "ok": false,
                    "output": format!(
                        "MCP tool '{name}' requested interactive multi-round input, \
                         which this client does not provide."
                    ),
                })));
            }
            // `CallToolResponse` is `#[non_exhaustive]`: a newer rmcp release
            // may add variants. Surface them instead of silently dropping the
            // response.
            Ok(Ok(_)) => {
                return Ok(Json(json!({
                    "ok": false,
                    "output": format!(
                        "MCP tool '{name}' returned an unsupported response shape"
                    ),
                })));
            }
            Ok(Err(e))
                if matches!(
                    e,
                    ServiceError::TransportClosed | ServiceError::TransportSend(_)
                ) &&
                    attempt < 2 =>
            {
                // Connection died mid-call: drop the slot and retry once
                // through a fresh connection.
                let mut m = state.mcp.write().await;
                m.conns.remove(server);
                continue;
            }
            Ok(Err(e)) => {
                let msg = format!("MCP call '{name}' failed: {e}");
                tracing::warn!(target: "mcp", "{msg}");
                return Ok(Json(json!({ "ok": false, "output": msg })));
            }
            Err(_) => {
                let msg = format!(
                    "MCP call '{name}' timed out after {}s",
                    CALL_TIMEOUT.as_secs()
                );
                tracing::warn!(target: "mcp", "{msg}");
                return Ok(Json(json!({ "ok": false, "output": msg })));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coder::{perms_approve, CoderPerms, PermTier};

    fn tmp_state() -> (S, std::path::PathBuf) {
        let tmp = std::env::temp_dir().join(format!("ninfier-mcp-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let state: S = Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        (state, tmp)
    }

    #[test]
    fn sanitize_server_name_drops_underscores_and_junk() {
        assert_eq!(sanitize_server_name("my server!"), "myserver");
        assert_eq!(sanitize_server_name("a_b c-d"), "abcd-d");
        assert_eq!(sanitize_server_name("__"), "");
    }

    #[test]
    fn sanitize_tool_name_is_llm_safe() {
        assert_eq!(sanitize_tool_name("get-weather@now"), "get-weather_now");
        assert_eq!(sanitize_tool_name("!!!"), "tool");
        let long = "x".repeat(100);
        assert_eq!(sanitize_tool_name(&long).len(), 56);
    }

    #[test]
    fn split_mcp_name_parses_server_and_tool() {
        assert_eq!(
            split_mcp_name("mcp__github__create_issue"),
            Some(("github", "create_issue"))
        );
        // the tool part may itself contain `__`
        assert_eq!(split_mcp_name("mcp__srv__a__b"), Some(("srv", "a__b")));
        assert_eq!(split_mcp_name("mcp__"), None);
        assert_eq!(split_mcp_name("mcp__github"), None);
        assert_eq!(split_mcp_name("mcp__github__"), None);
        assert_eq!(split_mcp_name("read"), None);
        assert_eq!(split_mcp_name("mcp___x"), None);
    }

    #[test]
    fn mangle_tools_namespaces_and_dedupes() {
        // build two colliding tools by hand via serde
        let v1: Tool = serde_json::from_value(json!({
            "name": "echo",
            "description": "d1",
            "inputSchema": { "type": "object" }
        }))
        .unwrap();
        let v2: Tool = serde_json::from_value(json!({
            "name": "echo",
            "description": "d2",
            "inputSchema": { "type": "object" }
        }))
        .unwrap();
        let defs = mangle_tools("echo-server", &[v1, v2]);
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[0].mangled, "mcp__echo-server__echo");
        assert_eq!(defs[1].mangled, "mcp__echo-server__echo_2");
        assert_eq!(defs[0].original, "echo");
        assert_eq!(defs[0].description, "d1");
    }

    #[test]
    fn spec_transport_selection() {
        let both = McpServerSpec {
            name: "x".into(),
            command: Some("uvx".into()),
            url: Some("https://example.com/mcp".into()),
            ..Default::default()
        };
        assert_eq!(both.transport(), Some("stdio"), "command wins");
        let none = McpServerSpec {
            name: "x".into(),
            ..Default::default()
        };
        assert_eq!(none.transport(), None);
        let http = McpServerSpec {
            name: "x".into(),
            url: Some("https://example.com/mcp".into()),
            ..Default::default()
        };
        assert_eq!(http.transport(), Some("http"));
    }

    #[tokio::test]
    async fn tier_falls_back_to_server_row() {
        let mut tools = HashMap::new();
        tools.insert("mcp__github".to_string(), PermTier::Deny);
        let perms = CoderPerms {
            tools: tools.clone(),
            deny_paths: vec![],
        };
        assert_eq!(
            crate::coder::tier_for(&perms, "mcp__github__push"),
            PermTier::Deny
        );
        // a per-tool row overrides the per-server row
        tools.insert("mcp__github__push".to_string(), PermTier::Allow);
        let perms = CoderPerms {
            tools,
            deny_paths: vec![],
        };
        assert_eq!(
            crate::coder::tier_for(&perms, "mcp__github__push"),
            PermTier::Allow
        );
        assert_eq!(
            crate::coder::tier_for(&perms, "mcp__github__other"),
            PermTier::Deny
        );
        // non-MCP names never consult the server row
        assert_eq!(crate::coder::tier_for(&perms, "bash"), PermTier::Allow);
    }

    #[tokio::test]
    async fn call_rejects_bad_names() {
        let (state, tmp) = tmp_state();
        let e = mcp_call(AxumState(state.clone()), Json(json!({ "name": "read" })))
            .await
            .unwrap_err();
        assert_eq!(e.0, StatusCode::BAD_REQUEST);
        let e = mcp_call(
            AxumState(state.clone()),
            Json(json!({ "name": "mcp__nosuch__tool" })),
        )
        .await
        .unwrap_err();
        assert_eq!(e.0, StatusCode::NOT_FOUND, "unknown server is a 404");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A minimal MCP stdio server: implements the legacy initialize
    /// handshake plus tools/list + tools/call (echo). The `server/discover`
    /// probe (sent by the `Auto` lifecycle) is answered with
    /// method-not-found, so rmcp falls back to legacy initialize instantly.
    const ECHO_SERVER_PY: &str = r#"
import json, sys

def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        method = msg.get("method")
        rid = msg.get("id")
        if rid is None:
            continue  # notification
        if method == "server/discover":
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}})
        elif method == "initialize":
            send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "echo", "version": "0.1.0"}}})
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [{
                "name": "echo",
                "description": "Echo the input text back",
                "inputSchema": {"type": "object",
                                "properties": {"text": {"type": "string"}},
                                "required": ["text"]}}]}})
        elif method == "tools/call":
            args = msg.get("params", {}).get("arguments", {})
            send({"jsonrpc": "2.0", "id": rid, "result": {
                "content": [{"type": "text", "text": args.get("text", "")}],
                "isError": False}})
        else:
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}})

main()
"#;

    fn find_python() -> Option<String> {
        ["python3", "python"]
            .iter()
            .find(|bin| {
                std::process::Command::new(bin)
                    .arg("--version")
                    .output()
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            })
            .map(|s| s.to_string())
    }

    #[tokio::test]
    async fn end_to_end_stdio_server() {
        let python = match find_python() {
            Some(p) => p,
            None => {
                eprintln!("skip: no python interpreter available for the MCP stdio e2e test");
                return;
            }
        };
        let (state, tmp) = tmp_state();
        let script = tmp.join("mcp_echo.py");
        std::fs::write(&script, ECHO_SERVER_PY).unwrap();

        let spec = McpServerSpec {
            name: "echo".into(),
            command: Some(python),
            args: vec![script.to_string_lossy().into_owned()],
            ..Default::default()
        };
        {
            let mut cfg = state.config.write().await;
            cfg.mcp_servers.push(spec);
        }

        // connect + discover
        ensure_conn(&state, "echo").await.expect("connect to the stdio echo server");

        // catalog
        let catalog = tools_get(AxumState(state.clone()), Query(HashMap::new()))
            .await
            .0;
        let tools = catalog["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1, "one echo tool: {catalog}");
        assert_eq!(tools[0]["name"], "mcp__echo__echo");
        assert_eq!(tools[0]["tier"], "allow");

        // call
        let res = mcp_call(
            AxumState(state.clone()),
            Json(json!({ "name": "mcp__echo__echo", "arguments": { "text": "hello mcp" } })),
        )
        .await
        .expect("tools/call")
        .0;
        assert_eq!(res["ok"], true, "{res}");
        assert_eq!(res["output"], "hello mcp", "{res}");

        // per-server deny tier blocks it (server-side enforcement)
        {
            let mut all = state.coder_perms.write().await;
            let mut t = HashMap::new();
            t.insert("mcp__echo".to_string(), PermTier::Deny);
            all.insert(
                "default".to_string(),
                CoderPerms {
                    tools: t,
                    deny_paths: vec![],
                },
            );
        }
        let e = mcp_call(
            AxumState(state.clone()),
            Json(json!({ "name": "mcp__echo__echo", "arguments": { "text": "x" } })),
        )
        .await
        .unwrap_err();
        assert_eq!(e.0, StatusCode::FORBIDDEN, "{e:?}");

        // ask tier: blocked without a token…
        {
            let mut all = state.coder_perms.write().await;
            let mut t = HashMap::new();
            t.insert("mcp__echo".to_string(), PermTier::Ask);
            all.insert(
                "default".to_string(),
                CoderPerms {
                    tools: t,
                    deny_paths: vec![],
                },
            );
        }
        let e = mcp_call(
            AxumState(state.clone()),
            Json(json!({ "name": "mcp__echo__echo", "arguments": { "text": "x" } })),
        )
        .await
        .unwrap_err();
        assert_eq!(e.0, StatusCode::FORBIDDEN, "ask without token: {e:?}");

        // …allowed with a fresh approval token (the exact flow the UI's
        // approval dialog drives).
        let approval = perms_approve(
            AxumState(state.clone()),
            Json(json!({ "tool": "mcp__echo__echo", "scope": "default" })),
        )
        .await
        .expect("mint approval token");
        let token = approval.0["token"].as_str().expect("token").to_string();
        let res = mcp_call(
            AxumState(state.clone()),
            Json(json!({
                "name": "mcp__echo__echo",
                "arguments": { "text": "approved" },
                "approvalToken": token
            })),
        )
        .await
        .expect("tools/call with approval token")
        .0;
        assert_eq!(res["ok"], true, "{res}");
        assert_eq!(res["output"], "approved", "{res}");

        // status shows connected
        let servers = servers_get(AxumState(state.clone())).await.0;
        assert_eq!(servers["servers"][0]["status"], "connected", "{servers}");

        // delete drops the connection and the spec
        let del = server_delete(AxumState(state.clone()), AxumPath("echo".to_string())).await.0;
        assert_eq!(del["removed"], true, "{del}");
        let m = state.mcp.read().await;
        assert!(m.conns.get("echo").is_none());
        drop(m);
        let cfg = state.config.read().await;
        assert!(cfg.mcp_servers.is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn upsert_rejects_specs_without_transport() {
        let (state, tmp) = tmp_state();
        let e = servers_upsert(
            AxumState(state.clone()),
            Json(json!({ "name": "bad" })),
        )
        .await
        .unwrap_err();
        assert_eq!(e.0, StatusCode::BAD_REQUEST, "{e:?}");
        let cfg = state.config.read().await;
        assert!(cfg.mcp_servers.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
