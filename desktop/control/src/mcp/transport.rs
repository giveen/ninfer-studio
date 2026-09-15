//! MCP connection lifecycle + result rendering (actor thread only).
//!
//! Everything here is `!Send` and must never cross a `.await` into the
//! axum world. Depends on `types` + `naming`.

use super::naming::mangle_tools;
use super::types::{INIT_TIMEOUT, MAX_TOOL_OUTPUT, McpService, ToolDef};
use crate::types::McpServerSpec;
use axum::http::header::{HeaderName, HeaderValue};
use rmcp::ClientLifecycleMode;
use rmcp::model::{
    CallToolResult, ClientCapabilities, ClientInfo, ContentBlock, Implementation,
    InitializeRequestParams, ProtocolVersion,
};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::ClientServiceExt;
use serde_json::Value;
use std::collections::HashMap;
use std::pin::Pin;
use std::time::Duration;
use tokio::time::timeout;

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
pub(super) async fn connect(
    spec: &McpServerSpec,
) -> Result<(McpService, Option<Value>, Option<u32>), String> {
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
    let fut: Pin<Box<dyn Future<Output = Result<McpService, String>>>> = match spec.transport() {
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
                match (
                    HeaderName::from_bytes(k.as_bytes()),
                    HeaderValue::from_str(v),
                ) {
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
        // ensure_conn callers both reject that before we get here, but a
        // future caller might not: a broken config is a per-server error
        // string, never a panic in the actor thread.
        _ => Box::pin(async {
            Err("MCP server has no transport configured (needs `command` or `url`)".to_string())
        }),
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
pub(super) async fn fetch_tools(server: &str, svc: &McpService) -> Result<Vec<ToolDef>, String> {
    let tools = timeout(Duration::from_secs(30), svc.list_all_tools())
        .await
        .map_err(|_| format!("timed out listing tools from MCP server '{server}'"))?
        .map_err(|e| format!("tools/list failed on MCP server '{server}': {e}"))?;
    Ok(mangle_tools(server, &tools))
}

/// Render a `tools/call` result into the single text blob the agent loop
/// feeds back to the model. Binary payloads (images/audio) are described,
/// not dumped — base64 would only burn context.
pub(super) fn render_result(result: &CallToolResult) -> String {
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
