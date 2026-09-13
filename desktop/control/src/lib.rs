//! NInfer Studio control plane — axum HTTP server.
//!
//! The single control-plane implementation (dev standalone and in-process under Tauri):
//!   /api/*        management endpoints (status, config, engine, logs, models, downloads, gpu)
//!   /health,/v1/* SSE-safe proxy to the engine port
//!   /…            static hosting of the built web app (SPA fallback)

// Rust guideline compliant 2026-07-28

pub mod coder;
pub mod engine;
pub mod gpu;
pub mod models;
pub mod proxy;
pub mod repo;
pub mod routes_config;
pub mod routes_data;
pub mod routes_engine;
pub mod types;
use crate::engine::{engine_health, refresh_engine_status, S};
use crate::types::{strip_extended_prefix, AppEvent, AppSettings, LastStart, State};
use tokio::sync::mpsc::UnboundedSender;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use tokio::io::AsyncBufReadExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Cap on a request body this control plane will buffer in memory — large
/// enough for chat/coder payloads (file attachments, long conversations)
/// without letting a client exhaust memory with an unbounded body.
pub(crate) const MAX_REQUEST_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Threshold below which `tail_file` reads the whole file rather than seeking
/// to a tail window, and the size of that tail window for larger files —
/// generous enough to contain the requested line count for any log this app
/// produces.
pub(crate) const LOG_TAIL_WINDOW_BYTES: usize = 512 * 1024;

/// Rolling-log size for background jobs (model downloads in models.rs, repo
/// pull/build updates in repo.rs): only the most recent lines matter for
/// diagnosing a failure, so both pumps cap per-line length and the tail the
/// same way, via [`append_log_line`].
pub(crate) const LOG_TAIL_LINES: usize = 2000;
pub(crate) const LOG_TAIL_LINE_CHARS: usize = 2000;

/// Strip the Python/library env AppImage's AppRun sets for its own bundled
/// runtime (`PYTHONHOME`, `PYTHONPATH`, `LD_LIBRARY_PATH`) before spawning an
/// external interpreter or tool. Inherited unchanged, `PYTHONHOME` in
/// particular points a spawned Python (e.g. a uv-tool-installed `hf` CLI) at
/// the AppImage's bundled stdlib instead of its own, which fails during
/// interpreter bootstrap with a "no Python frame" fatal error before any user
/// code runs. Only relevant on Linux, where AppImage is the packaging format.
pub(crate) fn clear_appimage_env(cmd: &mut tokio::process::Command) {
    cmd.env_remove("PYTHONHOME")
        .env_remove("PYTHONPATH")
        .env_remove("LD_LIBRARY_PATH");
}

/// Append `line` to a rolling job log, keeping only the most recent
/// `max_lines` lines.
pub(crate) fn append_log_line(out: &mut String, line: &str, max_lines: usize) {
    let lines: Vec<&str> = out.lines().chain(std::iter::once(line)).collect();
    let start = lines.len().saturating_sub(max_lines);
    *out = lines[start..].join("\n");
}

/// Drain `reader` line by line, truncating each line to
/// [`LOG_TAIL_LINE_CHARS`] and invoking `on_line` (owned, so the callback can
/// be an async closure) per line until EOF. Shared by the stdout/stderr pumps
/// of the model-download and repo-update jobs.
pub(crate) async fn pump_log_lines<S, F, Fut>(mut reader: S, mut on_line: F)
where
    S: tokio::io::AsyncBufRead + Unpin,
    F: FnMut(String) -> Fut,
    Fut: std::future::Future,
{
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf).await {
            Ok(n) if n > 0 => {}
            _ => break,
        }
        let line: String = buf.chars().take(LOG_TAIL_LINE_CHARS).collect();
        on_line(line).await;
    }
}

// ---------------------------------------------------------------------------
// App construction
// ---------------------------------------------------------------------------
pub fn build_router(state: S) -> Router {
    let dist = state.dist_dir.clone();
    let index = dist.join("index.html");
    let spa = tower_http::services::ServeFile::new(index.clone());
    Router::new()
        .route("/api/health", get(routes_engine::health))
        .route("/api/status", get(routes_engine::status))
        .route("/api/config", get(routes_config::get_config).post(routes_config::set_config))
        .route("/api/profile-state", get(routes_config::profile_state_get).post(routes_config::profile_state_set))
        .route("/api/conversations", get(routes_config::conversations_get).post(routes_config::conversations_set))
        .route("/api/engine/start", post(routes_engine::engine_start))
        .route("/api/engine/stop", post(routes_engine::engine_stop))
        .route("/api/logs", get(routes_data::logs))
        .route("/api/models", get(routes_data::api_models))
        .route("/api/models/download", post(routes_data::models_download))
        .route("/api/engine/update", post(routes_engine::engine_update))
        .route("/api/engine/args", post(routes_engine::engine_args))
        .route("/api/gpu", get(routes_data::gpu))
        // Coding harness — control-plane endpoints
        .route("/api/coder/workspace", get(coder::workspace_get).post(coder::workspace_set))
        .route("/api/coder/tree", get(coder::tree))
        .route("/api/coder/dirs", get(coder::dirs))
        .route("/api/coder/repo_map", get(coder::repo_map))
        .route("/api/coder/fs/read", post(coder::fs_read))
        .route("/api/coder/fs/write", post(coder::fs_write))
        .route("/api/coder/fs/edit", post(coder::fs_edit))
        .route("/api/coder/exec", post(coder::exec))
        .route("/api/coder/jobs/{id}", get(coder::job_get))
        .route("/api/coder/jobs/{id}/kill", post(coder::job_kill))
        .route("/api/coder/safe-mode", get(coder::safe_mode_get).post(coder::safe_mode_set))
        .route("/api/coder/sandbox", get(coder::sandbox_get).post(coder::sandbox_set))
        .route("/api/coder/search", get(coder::search))
        .route("/api/coder/diff", get(coder::diff))
        .route("/api/coder/perms", get(coder::perms_get).post(coder::perms_set))
        .route("/api/coder/perms/approve", post(coder::perms_approve))
        .route("/api/coder/fs/b64", post(coder::fs_b64))
        .route("/api/coder/fs/patch", post(coder::fs_patch))
        .route("/api/coder/grep", post(coder::grep))
        .route("/api/coder/memory", get(coder::memory_get).post(coder::memory_set))
        .route("/api/coder/glob", post(coder::glob))
        .route("/api/coder/web/fetch", post(coder::web_fetch))
        .route("/api/coder/browser", post(coder::browser))
        .route("/api/coder/web/search", post(coder::web_search))
        .route("/health", get(proxy::proxy))
        .route("/v1/{*path}", axum::routing::any(proxy::proxy))
        .with_state(state)
        .fallback_service(
            tower_http::services::ServeDir::new(dist).not_found_service(spa),
        )
        // The bundled webview (origin tauri://localhost) may call the
        // in-process control plane on 127.0.0.1 cross-origin in release
        // builds; dev Vite proxies server-side. Anything else — i.e. random
        // websites — must not be able to call this API: allow-list origins
        // instead of the previous permissive CORS, and reject foreign Host
        // headers (DNS rebinding) below.
        .layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin([
                    header::HeaderValue::from_static("tauri://localhost"),
                    header::HeaderValue::from_static("http://tauri.localhost"),
                    header::HeaderValue::from_static("http://localhost:5173"),
                    header::HeaderValue::from_static("http://127.0.0.1:5173"),
                ])
                .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
                .allow_headers([header::CONTENT_TYPE]),
        )
        .layer(axum::middleware::from_fn(guard_local_host))
}

/// Reject requests whose Host (or Origin) does not point at this machine.
/// A loopback API is still browser-reachable through DNS rebinding: an
/// attacker page rebinds its own domain to 127.0.0.1 and the browser sends
/// same-origin requests with the attacker's Host header. Checking Host closes
/// that vector for every route at once.
async fn guard_local_host(req: Request<Body>, next: axum::middleware::Next) -> axum::response::Response {
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    // Strip the port ("[::1]:8787" -> "[::1]"); IPv6 literals keep brackets.
    let bare = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    let host_ok = matches!(bare, "127.0.0.1" | "localhost" | "[::1]" | "::1" | "tauri.localhost");
    let origin_ok = match req.headers().get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        Some(o) => {
            let bare = o
                .trim_start_matches("http://")
                .trim_start_matches("https://")
                .trim_start_matches("tauri://");
            bare.starts_with("127.0.0.1")
                || bare.starts_with("localhost")
                || bare.starts_with("[::1]")
                || bare.starts_with("tauri.localhost")
        }
        None => true, // non-browser clients (curl, the engine probe) send none
    };
    if host_ok && origin_ok {
        next.run(req).await
    } else {
        (StatusCode::FORBIDDEN, "forbidden host").into_response()
    }
}

/// Bind + serve on `port` (see [`serve_until_ready`] for a variant that
/// signals once the listener is bound).
///
/// # Errors
/// Returns an error if `port` cannot be bound (already in use, or
/// insufficient permissions), or if the server's `accept` loop fails.
pub async fn serve(state: S, port: u16) -> std::io::Result<()> {
    serve_until_ready(state, port, None).await
}

/// Bind + serve, sending `()` on `ready` once the listener is up (if given).
///
/// # Errors
/// Returns an error if `port` cannot be bound (already in use, or
/// insufficient permissions), or if the server's `accept` loop fails.
pub async fn serve_until_ready(
    state: S,
    port: u16,
    ready: Option<std::sync::mpsc::Sender<()>>,
) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    tracing::event!(
        name: "control_plane.listen",
        tracing::Level::INFO,
        port,
        dist.dir = ?state.dist_dir,
        "listening on http://127.0.0.1:{{port}} (dist: {{dist.dir}})",
    );
    if let Some(tx) = ready {
        let _ = tx.send(());
    }
    axum::serve(listener, build_router(state)).await
}

/// Boot-time adoption of an externally running engine on the configured port.
pub async fn boot_adopt(state: &S) {
    let port = state.config.read().await.engine_port;
    let mut eng = state.engine.write().await;
    eng.port = Some(port);
    eng.log_path = Some(state.data_dir.join(format!("engine-{port}.log")).to_string_lossy().to_string());
    drop(eng);
    if engine_health(port).await {
        refresh_engine_status(state).await;
        tracing::event!(
            name: "engine.adopt.found",
            tracing::Level::INFO,
            port,
            "external engine detected on port {{port}}",
        );
    } else {
        tracing::event!(
            name: "engine.adopt.absent",
            tracing::Level::INFO,
            port,
            "no engine detected on port {{port}}",
        );
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
pub(crate) async fn read_json(req: Request<Body>) -> Result<Value, (StatusCode, String)> {
    let bytes = axum::body::to_bytes(req.into_body(), MAX_REQUEST_BODY_BYTES)
        .await
        .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "body too large".to_string()))?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid JSON body: {e}")))
}

// ---------------------------------------------------------------------------
// Runtime entry: load config, boot, serve
// ---------------------------------------------------------------------------
pub fn default_data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("NINFIER_STUDIO_DATA") {
        return PathBuf::from(d);
    }
    // Linux: ~/.config/ninfier-studio · Windows: ~/AppData/Roaming/ninfier-studio
    // (no macOS build). Settings persist here so they survive a fresh pull /
    // reinstall of the app.
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ninfier-studio")
}

pub fn default_dist_dir() -> PathBuf {
    if let Ok(d) = std::env::var("NINFIER_STUDIO_DIST") {
        return PathBuf::from(d);
    }
    // repo layout: desktop/control -> project root -> apps/web/dist
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    root.join("apps/web/dist")
        .canonicalize()
        .unwrap_or_else(|_| root.join("apps/web/dist"))
}

pub async fn init_state(event_tx: Option<UnboundedSender<AppEvent>>) -> S {
    let data_dir = default_data_dir();
    let dist_dir = default_dist_dir();
    let state = Arc::new(State::new(data_dir, dist_dir, event_tx));
    // load persisted config
    let p = state.data_dir.join("config.json");
    if let Ok(raw) = tokio::fs::read_to_string(&p).await
        && let Ok(mut cfg) = serde_json::from_str::<AppSettings>(&raw)
    {
        let defaults = AppSettings::default();
        if cfg.models_dir.is_empty() {
            cfg.models_dir = defaults.models_dir;
        }
        if cfg.engine_port == 0 {
            cfg.engine_port = defaults.engine_port;
        }
        if cfg.hf_cli.is_empty() {
            cfg.hf_cli = defaults.hf_cli;
        }
        if cfg.ninfer_path.is_empty() {
            cfg.ninfer_path = defaults.ninfer_path;
        }
        if cfg.build_command.is_empty() {
            cfg.build_command = defaults.build_command;
        }
        // Legacy values may carry the Windows extended-length prefix
        // (`\\?\`) from an older canonicalize; normalize so the UI
        // (which keys workspaces by plain paths) matches on restart.
        cfg.coder_workspace = strip_extended_prefix(&cfg.coder_workspace).to_string();
        *state.config.write().await = cfg;
    }
    // load the last-start record (dirty indicator for the Engine tab)
    let p = state.data_dir.join("last-start.json");
    if let Ok(raw) = tokio::fs::read_to_string(&p).await
        && let Ok(ls) = serde_json::from_str::<LastStart>(&raw)
    {
        *state.last_start.write().await = Some(ls);
    }
    state
}
#[cfg(test)]
mod log_pump_tests {
    use super::*;

    #[test]
    fn append_log_line_keeps_only_the_recent_tail() {
        let mut out = String::new();
        for i in 0..(LOG_TAIL_LINES + 5) {
            append_log_line(&mut out, &format!("line-{i}"), LOG_TAIL_LINES);
        }
        let lines = out.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), LOG_TAIL_LINES);
        // Oldest lines dropped, newest kept, in order.
        assert_eq!(lines[0], "line-5");
        assert_eq!(lines.last().unwrap(), &format!("line-{}", LOG_TAIL_LINES + 4));
    }

    #[tokio::test]
    async fn pump_log_lines_truncates_long_lines_and_stops_at_eof() {
        let input = format!("short\n{}\nend\n", "x".repeat(LOG_TAIL_LINE_CHARS + 100));
        let mut out = String::new();
        pump_log_lines(tokio::io::BufReader::new(std::io::Cursor::new(input.into_bytes())), |line| {
            // read_line hands each line WITH its trailing newline; EOF ends
            // the loop with no extra empty line (3 lines in → 3 invocations).
            out.push_str(&line);
            async {}
        })
        .await;
        // Truncating the 2100-char line to 2000 chars chops off its trailing
        // newline, so the next line concatenates onto it (pre-existing
        // behavior of the original pumps; only a cosmetic edge case for
        // abnormally long lines).
        assert_eq!(out, format!("short\n{}end\n", "x".repeat(LOG_TAIL_LINE_CHARS)));
    }
}
