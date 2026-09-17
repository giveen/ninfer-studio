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

#[derive(Debug)]
pub struct RemoteSlot {
    pub port: u16,
    pub handle: tokio::task::JoinHandle<()>,
    pub shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

static LAN_IP_CACHE: std::sync::Mutex<Option<(std::time::Instant, Option<String>)>> =
    std::sync::Mutex::new(None);

/// Best-effort LAN-facing IPv4 address of this machine, for display only
/// ("open this on your laptop: http://<ip>:<port>"). Uses the classic
/// UDP-connect trick: connecting a UDP socket never sends a packet (no
/// handshake), it only asks the OS to pick the outbound interface/address
/// for that route, so this returns instantly and needs no real connectivity
/// to 8.8.8.8. Results are cached for 10s to avoid repeated socket creation.
pub(crate) fn detect_lan_ip() -> Option<String> {
    if let Ok(guard) = LAN_IP_CACHE.lock()
        && let Some((ts, ref ip)) = *guard
        && ts.elapsed() < std::time::Duration::from_secs(10)
    {
        return ip.clone();
    }
    let fresh_ip = (|| {
        let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
        sock.connect(("8.8.8.8", 80)).ok()?;
        Some(sock.local_addr().ok()?.ip().to_string())
    })();
    if let Ok(mut guard) = LAN_IP_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), fresh_ip.clone()));
    }
    fresh_ip
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
/// already running. The bind happens before stopping the old listener (when
/// changing ports) so a port-in-use error surfaces to the caller without
/// destroying the existing listener setup.
pub(crate) async fn start(state: S, port: u16) -> std::io::Result<()> {
    let current_running_port = {
        let guard = state.remote.lock().await;
        guard.as_ref().map(|s| s.port)
    };

    if current_running_port == Some(port) {
        stop(&state).await;
        let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
        let router = crate::build_router(state.clone(), false);
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
            {
                tracing::event!(
                    name: "remote_access.serve.failed",
                    tracing::Level::ERROR,
                    error = %e,
                    "remote access server error",
                );
            }
        });
        *state.remote.lock().await = Some(RemoteSlot {
            port,
            handle,
            shutdown_tx: Some(shutdown_tx),
        });
        tracing::event!(name: "remote_access.started", tracing::Level::INFO, port, "remote access listening on http://0.0.0.0:{port}");
        return Ok(());
    }

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    stop(&state).await;
    let router = crate::build_router(state.clone(), false);
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
        {
            tracing::event!(
                name: "remote_access.serve.failed",
                tracing::Level::ERROR,
                error = %e,
                "remote access server error",
            );
        }
    });
    *state.remote.lock().await = Some(RemoteSlot {
        port,
        handle,
        shutdown_tx: Some(shutdown_tx),
    });
    tracing::event!(name: "remote_access.started", tracing::Level::INFO, port, "remote access listening on http://0.0.0.0:{port}");
    Ok(())
}

/// Stop the live listener task gracefully, if any. Does not touch persisted config —
/// callers that mean "turn it off" also update `remote_access_enabled`.
pub(crate) async fn stop(state: &S) {
    let slot = state.remote.lock().await.take();
    if let Some(slot) = slot {
        if let Some(tx) = slot.shutdown_tx {
            let _ = tx.send(());
        } else {
            slot.handle.abort();
        }
        let _ = slot.handle.await;
        tracing::event!(name: "remote_access.stopped", tracing::Level::INFO, "remote access listener stopped");
    }
}

/// Resume Remote Access on app boot if it was left on last session — mirrors
/// `boot_adopt`'s "restore what the user last configured" behavior for the
/// engine. Best-effort: a bind failure (e.g. the port is now taken) is logged
/// and leaves the feature off rather than crashing startup.
pub(crate) async fn boot_start(state: &S) {
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
            "could not resume remote access on http://0.0.0.0:{port}: {e}",
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
        if p < 1024 || p > 65535 {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("invalid port {p}: must be between 1024 and 65535"),
            ));
        }
    }

    let port = raw_port
        .map(|v| v as u16)
        .unwrap_or(state.config.read().await.remote_access_port);

    if port < 1024 {
        return Err((
            StatusCode::BAD_REQUEST,
            "invalid port: must be between 1024 and 65535".to_string(),
        ));
    }

    let control_port = crate::control_plane_port();
    if port == control_port {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("port {port} collides with the control-plane port"),
        ));
    }

    let old_cfg = state.config.read().await.clone();
    let mut new_cfg = old_cfg.clone();
    new_cfg.remote_access_enabled = true;
    new_cfg.remote_access_port = port;

    persist_config(&state, &new_cfg).await?;

    if let Err(e) = start(state.clone(), port).await {
        let _ = persist_config(&state, &old_cfg).await;
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not bind 0.0.0.0:{port}: {e}"),
        ));
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
    use std::sync::Arc;

    #[test]
    fn test_detect_lan_ip_does_not_panic() {
        let _ = detect_lan_ip();
    }

    #[tokio::test]
    async fn test_post_start_validates_port_range_and_collisions() {
        let dir = std::env::temp_dir().join(format!("remote-test-{}", crate::memstore::mem_rand_suffix()));
        let state = Arc::new(crate::types::State::new(dir.clone(), std::path::PathBuf::from("."), None));

        // Invalid privileged port 80
        let req = Request::builder()
            .body(axum::body::Body::from(r#"{"port": 80}"#))
            .unwrap();
        let res = post_start(AxumState(state.clone()), req).await;
        assert!(res.is_err());
        assert_eq!(res.unwrap_err().0, StatusCode::BAD_REQUEST);

        // Out of range port 65536
        let req2 = Request::builder()
            .body(axum::body::Body::from(r#"{"port": 65536}"#))
            .unwrap();
        let res2 = post_start(AxumState(state.clone()), req2).await;
        assert!(res2.is_err());
        assert_eq!(res2.unwrap_err().0, StatusCode::BAD_REQUEST);

        // Control plane port collision
        let cport = crate::control_plane_port();
        let req3 = Request::builder()
            .body(axum::body::Body::from(format!(r#"{{"port": {cport}}}"#)))
            .unwrap();
        let res3 = post_start(AxumState(state.clone()), req3).await;
        assert!(res3.is_err());
        assert_eq!(res3.unwrap_err().0, StatusCode::BAD_REQUEST);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

