//! MCP HTTP routes: server CRUD, tool catalog, tool invocation.
//!
//! Depends on `types` + `naming` + `actor`. The stdio end-to-end test lives
//! here — it hits the route handlers, not the actor internals.

use super::actor::{ensure_conn, mark_dead, send_cmd};
use super::naming::{sanitize_server_name, split_mcp_name, validate_spec};
use super::types::{CALL_TIMEOUT, LIST_TOOLS_LIMIT, TOOLS_TTL, ConnMeta, McpCmd, McpReply};
use crate::coder::{enforce_perm, perm_scope, tier_for};
use crate::engine::S;
use crate::types::{AppSettings, McpServerSpec};
use axum::Json;
use axum::extract::{Path as AxumPath, Query, State as AxumState};
use axum::http::StatusCode;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::time::{Duration, Instant};


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

/// The JSON view of one configured server for `GET /api/mcp/servers`.
/// `authorization` never leaves the control plane — the UI sees a mask.
fn server_value(spec: &McpServerSpec, meta: Option<&ConnMeta>) -> Value {
    let status: String = match meta {
        Some(m) if m.alive && m.error.is_none() => "connected".to_string(),
        Some(m) => format!(
            "error: {}",
            m.error
                .clone()
                .unwrap_or_else(|| "connection closed".into())
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
                .map(|meta| {
                    meta.tools_at
                        .map(|t| t.elapsed() > TOOLS_TTL)
                        .unwrap_or(true)
                })
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
                Ok(McpReply::ListTools { error: None, tools }) => {
                    let m = state.mcp.read().await;
                    let mut meta = m.meta_get(&spec.name).unwrap_or_default();
                    meta.tools = tools;
                    meta.tools_at = Some(Instant::now());
                    meta.alive = true;
                    m.meta_set(&spec.name, meta);
                }
                Ok(McpReply::ListTools { error: Some(e), .. }) => {
                    mark_dead(&state, &spec.name, e).await;
                    continue;
                }
                Err((s, _)) => {
                    mark_dead(&state, &spec.name, s.to_string()).await;
                    continue;
                }
                Ok(_) => {
                    mark_dead(&state, &spec.name, "unexpected MCP actor reply".to_string()).await;
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
        let Some(def) = meta.and_then(|mt| mt.tools.iter().find(|d| d.mangled == name).cloned())
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
                transport_dead: true,
                ..
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
                    Json(
                        json!({ "error": "MCP connection dropped during the tool call and the retry failed" }),
                    ),
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
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let Some((server, _)) = split_mcp_name(&name) else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "error": format!("'{name}' is not an MCP tool name (expected mcp__<server>__<tool>)") }),
            ),
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
        if let Some(meta) = m.meta_get(&server)
            && !meta.alive
            && failed_recently(&meta)
        {
            return Err((
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": meta
                    .error
                    .clone()
                    .unwrap_or_else(|| "MCP server not connected".to_string()) })),
            ));
        }
    }
    ensure_conn(&state, &server).await?;
    let (ok, output) = call_tool(&state, &name, arguments).await?;
    Ok(Json(json!({ "ok": ok, "output": output })))
}
