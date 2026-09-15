//! MCP actor: dedicated driver thread + command dispatcher + handler bridge.
//!
//! rmcp's running client service is `!Send`, so all sessions live on one
//! current-thread tokio runtime (`actor_entry`). Routes talk to it through
//! `(command, reply)` round trips (`send_cmd`). Depends on
use super::transport::{connect, fetch_tools, render_result};
use super::types::{CALL_TIMEOUT, ConnMeta, INIT_TIMEOUT, McpCmd, McpReply};
use crate::coder::PanicGuard;
use crate::engine::S;
use axum::Json;
use axum::http::StatusCode;
use rmcp::ServiceError;
use rmcp::model::{CallToolRequestParams, CallToolResponse};
use serde_json::json;
use axum::http::StatusCode;
use rmcp::model::{CallToolRequestParams, CallToolResponse};
use rmcp::ServiceError;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::task::LocalSet;
use tokio::time::timeout;

/// Driver-thread entry: a private current-thread tokio runtime + `LocalSet`
/// so the `!Send` rmcp services can exist (mirrors the Obscura browser
/// driver in `coder/browser.rs`). Runs until the process exits.
pub(super) fn actor_entry(rx: UnboundedReceiver<(McpCmd, UnboundedSender<McpReply>)>) {
    let res = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build();
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
    let conns: Arc<Mutex<HashMap<String, Arc<super::types::McpService>>>> =
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
                            conns.lock().unwrap().insert(server.clone(), svc);
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
                            let params = CallToolRequestParams::new(tool).with_arguments(arguments);
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

/// One (command, reply) round trip through the actor. `limit` is the
/// handler-side ceiling — the actor enforces its own (shorter) timeouts,
/// so `limit` only fires if the actor itself wedged.
pub(super) async fn send_cmd(
    state: &S,
    cmd: McpCmd,
    limit: Duration,
) -> Result<McpReply, (StatusCode, Json<serde_json::Value>)> {
    let manager = state.mcp.read().await;
    let Some(tx) = manager.channel() else {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "MCP actor failed to start" })),
        ));
    };
    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::unbounded_channel();
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
pub(super) async fn mark_dead(state: &S, name: &str, reason: String) {
    let m = state.mcp.read().await;
    let mut meta = m.meta_get(name).unwrap_or_default();
    meta.alive = false;
    meta.error = Some(reason);
    meta.error_at = Some(Instant::now());
    m.meta_set(name, meta);
}

/// Ensure `name` has a live session (connect or reconnect), and record the
/// result in the manager's metadata. Shared by upsert/restart/tools/call.
pub(crate) async fn ensure_conn(state: &S, name: &str) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
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
        Ok(McpReply::Connect { error: Some(e), .. }) => {
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
