//! Remote Access: serve the full app (SPA + API) on `0.0.0.0` instead of
//! loopback-only, so another device on the network can open it in a browser
//! and drive the same live backend — no separate sync layer needed, since
//! it's the same `State` the desktop webview already talks to.
//!
//! Deliberately unauthenticated (see SECURITY.md): the listener built by
//! `crate::build_router(state, false)` skips both the CORS allow-list and
//! the `guard_local_host` Host-header check that protect the loopback
//! listener, so anyone who can reach the port gets the same tool access as
//! the local user (shell, file writes, git, the headless browser). This is
//! a deliberate, user-opted-in tradeoff for zero-friction LAN access, not an
//! oversight — do not "fix" it by re-adding those layers without also adding
//! authentication, or the feature stops working as designed.

use crate::engine::S;
use crate::routes_config::persist_config;
use axum::Json;
use axum::extract::{Request, State as AxumState};
use axum::http::StatusCode;
use serde_json::{Value, json};

/// Best-effort LAN-facing IPv4 address of this machine, for display only
/// ("open this on your laptop: http://<ip>:<port>"). Uses the classic
/// UDP-connect trick: connecting a UDP socket never sends a packet (no
/// handshake), it only asks the OS to pick the outbound interface/address
/// for that route, so this returns instantly and needs no real connectivity
/// to 8.8.8.8. Returns `None` if the host has no route to the network at all
/// (no cable/Wi-Fi) — the caller falls back to "enter your IP manually".
fn detect_lan_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect(("8.8.8.8", 80)).ok()?;
    Some(sock.local_addr().ok()?.ip().to_string())
}

async fn status_json(state: &S) -> Value {
    let cfg = state.config.read().await;
    let running = state.remote.lock().await.is_some();
    json!({
        "enabled": cfg.remote_access_enabled,
        "running": running,
        "port": cfg.remote_access_port,
        "lanIp": detect_lan_ip(),
    })
}

pub(crate) async fn get_status(AxumState(state): AxumState<S>) -> Json<Value> {
    Json(status_json(&state).await)
}

/// Bind `0.0.0.0:port` and spawn the serve loop, replacing any listener
/// already running. The bind happens here (not inside the spawned task) so a
/// port-in-use error surfaces to the caller instead of silently failing in
/// the background.
pub async fn start(state: S, port: u16) -> std::io::Result<()> {
    stop(&state).await;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    let router = crate::build_router(state.clone(), false);
    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::event!(
                name: "remote_access.serve.failed",
                tracing::Level::ERROR,
                error = %e,
                "remote access server error: {{error}}",
            );
        }
    });
    *state.remote.lock().await = Some(handle);
    tracing::event!(name: "remote_access.started", tracing::Level::INFO, port, "remote access listening on http://0.0.0.0:{{port}}");
    Ok(())
}

/// Abort the live listener task, if any. Does not touch persisted config —
/// callers that mean "turn it off" also update `remote_access_enabled`.
pub async fn stop(state: &S) {
    if let Some(handle) = state.remote.lock().await.take() {
        handle.abort();
        let _ = handle.await;
        tracing::event!(name: "remote_access.stopped", tracing::Level::INFO, "remote access listener stopped");
    }
}

/// Resume Remote Access on app boot if it was left on last session — mirrors
/// `boot_adopt`'s "restore what the user last configured" behavior for the
/// engine. Best-effort: a bind failure (e.g. the port is now taken) is logged
/// and leaves the feature off rather than crashing startup.
pub async fn boot_start(state: &S) {
    let (enabled, port) = {
        let cfg = state.config.read().await;
        (cfg.remote_access_enabled, cfg.remote_access_port)
    };
    if !enabled {
        return;
    }
    if let Err(e) = start(state.clone(), port).await {
        tracing::event!(
            name: "remote_access.boot_start.failed",
            tracing::Level::ERROR,
            error = %e,
            port,
            "could not resume remote access on http://0.0.0.0:{{port}}: {{error}}",
        );
    }
}

pub(crate) async fn post_start(
    AxumState(state): AxumState<S>,
    req: Request<axum::body::Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body = crate::read_json(req).await?;
    let raw_port = body
        .get("port")
        .and_then(|v| v.as_u64());

    if let Some(p) = raw_port {
        if p == 0 || p > 65535 {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("invalid port {p}: must be between 1 and 65535"),
            ));
        }
    }

    let port = raw_port
        .map(|v| v as u16)
        .unwrap_or(state.config.read().await.remote_access_port);

    if port == 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            "invalid port 0: must be between 1 and 65535".to_string(),
        ));
    }

    start(state.clone(), port).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not bind 0.0.0.0:{port}: {e}"),
        )
    })?;

    let mut cfg = state.config.read().await.clone();
    cfg.remote_access_enabled = true;
    cfg.remote_access_port = port;

    if let Err(e) = persist_config(&state, &cfg).await {
        stop(&state).await;
        return Err(e);
    }

    Ok(Json(status_json(&state).await))
}

pub(crate) async fn post_stop(
    AxumState(state): AxumState<S>,
) -> Result<Json<Value>, (StatusCode, String)> {
    stop(&state).await;
    let mut cfg = state.config.read().await.clone();
    cfg.remote_access_enabled = false;
    persist_config(&state, &cfg).await?;
    Ok(Json(status_json(&state).await))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_lan_ip_does_not_panic() {
        let _ = detect_lan_ip();
    }
}
