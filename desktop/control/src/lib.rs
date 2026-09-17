//! NInfer Studio control plane — axum HTTP server.
//!
//! The single control-plane implementation (dev standalone and in-process under Tauri):
//!   /api/*        management endpoints (status, config, engine, logs, models, downloads, gpu)
//!   /health,/v1/* SSE-safe proxy to the engine port
//!   /…            static hosting of the built web app (SPA fallback)

// Rust guideline compliant 2026-07-28

pub mod agent;
pub mod chat;
pub mod coder;
pub mod engine;
pub mod gpu;
pub mod mcp;
pub mod memstore;
pub mod models;
pub mod power;
pub mod proxy;
pub mod remote;
pub mod repo;
pub mod routes_config;
pub mod routes_data;
pub mod routes_engine;
pub mod sandbox;
pub mod types;
pub mod usage;
use crate::engine::{S, engine_health, refresh_engine_status};
use crate::types::{AppEvent, AppSettings, LastStart, State, strip_extended_prefix};
use axum::Router;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Request};
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};
use tokio::sync::mpsc::UnboundedSender;

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

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

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
    if max_lines == 0 {
        out.clear();
        return;
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(line);

    let line_count = out.as_bytes().iter().filter(|&&b| b == b'\n').count() + 1;
    if line_count > max_lines {
        let excess = line_count - max_lines;
        let mut drop_idx = 0;
        let mut found = 0;
        for (i, &b) in out.as_bytes().iter().enumerate() {
            if b == b'\n' {
                found += 1;
                if found == excess {
                    drop_idx = i + 1;
                    break;
                }
            }
        }
        if drop_idx > 0 {
            out.drain(..drop_idx);
        }
    }
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
    let max_bytes = (LOG_TAIL_LINE_CHARS * 4) as u64;
    loop {
        buf.clear();
        match (&mut reader).take(max_bytes).read_line(&mut buf).await {
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
/// Build the router. `restrict_to_local` gates the CORS allow-list and the
/// `guard_local_host` Host check: the loopback listener (`serve_until_ready`)
/// passes `true`; the Remote Access listener (`remote::start`) passes `false`
/// since a device on the network sends a Host/Origin that would otherwise be
/// rejected — see `remote.rs` for why that's intentional, not a hole.
pub fn build_router(state: S, restrict_to_local: bool) -> Router {
    let dist = state.dist_dir.clone();
    let index = dist.join("index.html");
    let spa = tower_http::services::ServeFile::new(index.clone());
    // Tag every request on this router with its listener, read back by
    // `proxy::proxy` for usage logging (see `usage.rs`) — the loopback
    // listener passes `restrict_to_local: true`, Remote Access `false`.
    let request_source = if restrict_to_local {
        crate::usage::RequestSource::Local
    } else {
        crate::usage::RequestSource::Remote
    };
    let router = Router::new()
        .route("/api/usage", get(usage::usage_stats))
        .route("/api/usage/reset", post(usage::usage_reset))
        .route("/api/health", get(routes_engine::health))
        .route("/api/status", get(routes_engine::status))
        .route(
            "/api/config",
            get(routes_config::get_config).post(routes_config::set_config),
        )
        .route("/api/cloud/test", post(routes_config::cloud_test))
        .route(
            "/api/profile-state",
            get(routes_config::profile_state_get).post(routes_config::profile_state_set),
        )
        .route(
            "/api/conversations",
            get(routes_config::conversations_get).post(routes_config::conversations_set),
        )
        .route("/api/engine/start", post(routes_engine::engine_start))
        .route("/api/engine/stop", post(routes_engine::engine_stop))
        .route("/api/logs", get(routes_data::logs))
        .route("/api/models", get(routes_data::api_models))
        .route("/api/models/download", post(routes_data::models_download))
        .route("/api/models/upgrade", post(routes_data::models_upgrade))
        .route("/api/models/convert", post(routes_data::models_convert))
        .route("/api/engine/update", post(routes_engine::engine_update))
        .route(
            "/api/engine/update/cancel",
            post(routes_engine::engine_update_cancel),
        )
        .route("/api/engine/args", post(routes_engine::engine_args))
        .route("/api/gpu", get(routes_data::gpu))
        // Coding harness — control-plane endpoints
        .route(
            "/api/coder/workspace",
            get(coder::workspace_get).post(coder::workspace_set),
        )
        .route("/api/coder/tree", get(coder::tree))
        .route("/api/coder/dirs", get(coder::dirs))
        .route("/api/coder/repo_map", get(coder::repo_map))
        .route("/api/coder/fs/read", post(coder::fs_read))
        .route("/api/coder/fs/write", post(coder::fs_write))
        .route("/api/coder/fs/edit", post(coder::fs_edit))
        .route("/api/coder/exec", post(coder::exec))
        .route("/api/coder/jobs/{id}", get(coder::job_get))
        .route("/api/coder/jobs/{id}/kill", post(coder::job_kill))
        .route(
            "/api/coder/safe-mode",
            get(coder::safe_mode_get).post(coder::safe_mode_set),
        )
        .route(
            "/api/coder/commit-approval",
            get(coder::commit_approval_get).post(coder::commit_approval_set),
        )
        .route(
            "/api/chat/agent-research",
            get(chat::agent_research_get).post(chat::agent_research_set),
        )
        .route(
            "/api/chat/memory-enabled",
            get(chat::memory_enabled_get).post(chat::memory_enabled_set),
        )
        .route(
            "/api/chat/reflection-enabled",
            get(chat::reflection_enabled_get).post(chat::reflection_enabled_set),
        )
        .route(
            "/api/chat/deep-research-enabled",
            get(chat::deep_research_enabled_get).post(chat::deep_research_enabled_set),
        )
        .route(
            "/api/coder/sandbox",
            get(coder::sandbox_get).post(coder::sandbox_set),
        )
        .route("/api/coder/search", get(coder::search))
        .route("/api/coder/diff", get(coder::diff))
        .route(
            "/api/coder/perms",
            get(coder::perms_get).post(coder::perms_set),
        )
        .route("/api/coder/perms/approve", post(coder::perms_approve))
        .route("/api/coder/fs/b64", post(coder::fs_b64))
        .route("/api/coder/fs/patch", post(coder::fs_patch))
        .route("/api/coder/grep", post(coder::grep))
        .route(
            "/api/coder/memory",
            get(coder::memory_get).post(coder::memory_set),
        )
        .route(
            "/api/chat/memory",
            get(chat::memory_get).post(chat::memory_set),
        )
        .route("/api/coder/glob", post(coder::glob))
        .route("/api/coder/web/fetch", post(coder::web_fetch))
        .route("/api/coder/browser", post(coder::browser))
        .route("/api/coder/web/search", post(coder::web_search))
        // MCP — external tool servers (stdio / streamable-HTTP); their tools
        // reach the agent loop as `mcp__<server>__<tool>` through the same
        // allow/ask/deny tiers as the built-in tools (see `mcp.rs`).
        .route(
            "/api/mcp/servers",
            get(mcp::servers_get).post(mcp::servers_upsert),
        )
        .route("/api/mcp/servers/{name}", post(mcp::server_delete))
        .route("/api/mcp/servers/{name}/restart", post(mcp::server_restart))
        .route("/api/mcp/tools", get(mcp::tools_get))
        .route("/api/mcp/call", post(mcp::mcp_call))
        .route("/api/remote", get(remote::get_status))
        .route("/api/remote/start", post(remote::post_start))
        .route("/api/remote/stop", post(remote::post_stop))
        .route("/health", get(proxy::proxy))
        // Server-side agent runs (the webview's tool loop, moved here —
        // runs survive window close; clients attach over SSE).
        .nest("/api/agent", crate::agent::run::router())
        .route("/v1/{*path}", axum::routing::any(proxy::proxy))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .layer(axum::extract::Extension(request_source))
        .with_state(state)
        .fallback_service(tower_http::services::ServeDir::new(dist).not_found_service(spa));
    if !restrict_to_local {
        return router;
    }
    router
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

fn strip_host_port(host: &str) -> &str {
    let host = host.trim();
    if host.starts_with('[') {
        if let Some(end_bracket_idx) = host.find(']') {
            let rest = &host[end_bracket_idx + 1..];
            if rest.is_empty() || rest.starts_with(':') {
                return &host[..=end_bracket_idx];
            }
        }
    }
    if host.bytes().filter(|&b| b == b':').count() > 1 {
        return host;
    }
    if let Some((h, _port)) = host.rsplit_once(':') {
        return h;
    }
    host
}

fn is_local_origin(origin: &str) -> bool {
    let bare = origin
        .trim()
        .strip_prefix("http://")
        .or_else(|| origin.trim().strip_prefix("https://"))
        .or_else(|| origin.trim().strip_prefix("tauri://"))
        .unwrap_or(origin.trim());
    let authority = bare.split('/').next().unwrap_or(bare);
    let host = strip_host_port(authority);
    matches!(
        host,
        "127.0.0.1" | "localhost" | "[::1]" | "::1" | "tauri.localhost"
    )
}

/// Reject requests whose Host (or Origin) does not point at this machine.
/// A loopback API is still browser-reachable through DNS rebinding: an
/// attacker page rebinds its own domain to 127.0.0.1 and the browser sends
/// same-origin requests with the attacker's Host header. Checking Host closes
/// that vector for every route at once.
async fn guard_local_host(
    req: Request<Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let bare = strip_host_port(host);
    let host_ok = matches!(
        bare,
        "127.0.0.1" | "localhost" | "[::1]" | "::1" | "tauri.localhost"
    );
    let origin_ok = match req
        .headers()
        .get(header::ORIGIN)
        .and_then(|o| o.to_str().ok())
    {
        Some(o) => is_local_origin(o),
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
    axum::serve(listener, build_router(state, true)).await
}

/// Resolve the control plane port from `NINFIER_STUDIO_PORT` env var, falling back to 8787.
pub fn control_plane_port() -> u16 {
    std::env::var("NINFIER_STUDIO_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8787)
}

/// Unified boot sequence for both standalone dev mode and the Tauri desktop app:
/// 1. Boot-time engine adoption (`boot_adopt`)
/// 2. Remote Access listener initialization (`remote::boot_start`), with conflict checks
/// 3. Loopback server binding (`serve_until_ready`)
pub async fn boot(
    state: S,
    port: u16,
    ready: Option<std::sync::mpsc::Sender<()>>,
) -> std::io::Result<()> {
    boot_adopt(&state).await;

    let remote_port = state.config.read().await.remote_access_port;
    if remote_port == port {
        tracing::event!(
            name: "remote_access.port_conflict",
            tracing::Level::WARN,
            port,
            "Remote Access port ({port}) conflicts with control plane port ({port}); disabling Remote Access on boot"
        );
    } else {
        remote::boot_start(&state).await;
    }

    serve_until_ready(state, port, ready).await
}

/// Boot-time adoption of an externally running engine on the configured port.
pub async fn boot_adopt(state: &S) {
    let port = state.config.read().await.engine_port;
    let mut eng = state.engine.write().await;
    eng.port = Some(port);
    eng.log_path = Some(
        state
            .data_dir
            .join(format!("engine-{port}.log"))
            .to_string_lossy()
            .to_string(),
    );
    drop(eng);
    if engine_health(&state, port).await {
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
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("length limit exceeded") || msg.contains("too large") {
                (StatusCode::PAYLOAD_TOO_LARGE, "body too large".to_string())
            } else {
                (StatusCode::BAD_REQUEST, format!("failed to read request body: {msg}"))
            }
        })?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid JSON body: {e}")))
}

fn make_tmp_path(path: &Path) -> PathBuf {
    let pid = std::process::id();
    let cnt = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("tmp");
    path.with_file_name(format!(".{file_name}.{pid}.{cnt}.tmp"))
}

/// Write `contents` to `path` atomically: write to a sibling `.tmp` file
/// then rename over the target. A crash or power loss mid-write leaves
/// either the old file or the new one intact — never a half-written,
/// corrupt `config.json`/`profile.json`/`chats.json`/`last-start.json`.
pub async fn atomic_write(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    let tmp = make_tmp_path(path);
    if let Err(e) = tokio::fs::write(&tmp, contents.as_ref()).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}

/// Same as [`atomic_write`], additionally locking the file down to owner
/// read/write (`0600`) — for `config.json`, which holds `apiKey`/`hfToken`
/// in the clear and would otherwise inherit the umask's default (typically
/// world-readable `0644`).
pub async fn atomic_write_secret(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    let tmp = make_tmp_path(path);
    #[cfg(unix)]
    {
        let mut options = tokio::fs::OpenOptions::new();
        options
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600);
        let mut file = match options.open(&tmp).await {
            Ok(f) => f,
            Err(e) => return Err(e),
        };
        if let Err(e) = tokio::io::AsyncWriteExt::write_all(&mut file, contents.as_ref()).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
        if let Err(e) = file.sync_all().await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
    }
    #[cfg(not(unix))]
    {
        if let Err(e) = tokio::fs::write(&tmp, contents.as_ref()).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
    }
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
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
    let dist_index = dist_dir.join("index.html");
    if !dist_index.exists() {
        tracing::event!(
            name: "control_plane.dist.missing",
            tracing::Level::WARN,
            dist_dir = ?dist_dir,
            index_path = ?dist_index,
            "web dist UI missing at {:?} (run 'pnpm build' in apps/web) — API active, but static web UI will return 404",
            dist_index
        );
    }
    let state = Arc::new(State::new(data_dir, dist_dir, event_tx));
    // load persisted config
    let p = state.data_dir.join("config.json");
    if let Ok(raw) = tokio::fs::read_to_string(&p).await {
        match serde_json::from_str::<AppSettings>(&raw) {
            Ok(mut cfg) => {
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
                cfg.ninfer_path = strip_extended_prefix(&cfg.ninfer_path).to_string();
                cfg.models_dir = strip_extended_prefix(&cfg.models_dir).to_string();
                cfg.chat_computer_use_dir =
                    strip_extended_prefix(&cfg.chat_computer_use_dir).to_string();
                *state.config.write().await = cfg;
            }
            Err(e) => {
                let bad_path = state.data_dir.join("config.json.bad");
                let _ = tokio::fs::rename(&p, &bad_path).await;
                tracing::event!(
                    name: "config.load.failed",
                    tracing::Level::WARN,
                    error = %e,
                    path = ?p,
                    bad_path = ?bad_path,
                    "config.json is corrupt, renamed to config.json.bad and falling back to defaults: {{error}}",
                );
            }
        }
    }
    // load the last-start record (dirty indicator for the Engine tab)
    let p = state.data_dir.join("last-start.json");
    if let Ok(raw) = tokio::fs::read_to_string(&p).await
        && let Ok(ls) = serde_json::from_str::<LastStart>(&raw)
    {
        *state.last_start.write().await = Some(ls);
    }
    // Background GPU energy sampler (see `power.rs`) — started once here so
    // both boot paths (the Tauri app and the standalone dev binary, which
    // both call `init_state`) get it without duplicating the wiring.
    tokio::spawn(power::run_power_sampler(state.clone()));
    // Connect configured MCP servers in the background (see `mcp.rs`) — a
    // broken server records its own per-server error and never blocks
    // startup.
    tokio::spawn(mcp::connect_all(state.clone()));
    state
}

#[cfg(test)]
mod tests {
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
        assert_eq!(
            lines.last().unwrap(),
            &format!("line-{}", LOG_TAIL_LINES + 4)
        );
    }

    #[tokio::test]
    async fn pump_log_lines_truncates_long_lines_and_stops_at_eof() {
        let input = format!("short\n{}\nend\n", "x".repeat(LOG_TAIL_LINE_CHARS + 100));
        let mut out = String::new();
        pump_log_lines(
            tokio::io::BufReader::new(std::io::Cursor::new(input.into_bytes())),
            |line| {
                out.push_str(&line);
                async {}
            },
        )
        .await;
        assert_eq!(
            out,
            format!("short\n{}end\n", "x".repeat(LOG_TAIL_LINE_CHARS))
        );
    }

    #[test]
    fn strip_host_port_handles_ipv4_ipv6_and_hostnames() {
        assert_eq!(strip_host_port("127.0.0.1:8080"), "127.0.0.1");
        assert_eq!(strip_host_port("127.0.0.1"), "127.0.0.1");
        assert_eq!(strip_host_port("localhost:5173"), "localhost");
        assert_eq!(strip_host_port("localhost"), "localhost");
        assert_eq!(strip_host_port("[::1]:8787"), "[::1]");
        assert_eq!(strip_host_port("[::1]"), "[::1]");
        assert_eq!(strip_host_port("::1"), "::1");
        assert_eq!(strip_host_port("tauri.localhost:3000"), "tauri.localhost");
    }

    #[test]
    fn is_local_origin_rejects_prefix_injection_and_allows_valid() {
        assert!(is_local_origin("http://localhost:5173"));
        assert!(is_local_origin("http://127.0.0.1:5173"));
        assert!(is_local_origin("tauri://localhost"));
        assert!(is_local_origin("http://[::1]:8787"));
        assert!(is_local_origin("http://[::1]"));
        assert!(is_local_origin("http://::1"));

        // Prefix injection attempts MUST be rejected
        assert!(!is_local_origin("http://localhost.evil.com"));
        assert!(!is_local_origin("http://127.0.0.1.attacker.com"));
        assert!(!is_local_origin("http://[::1].evil.com"));
        assert!(!is_local_origin("http://tauri.localhost.fake.net"));
    }

    #[tokio::test]
    async fn atomic_write_secret_creates_unique_tmp_and_0600_permissions() {
        let dir = std::env::temp_dir().join(format!("test-secret-{}", std::process::id()));
        let _ = tokio::fs::create_dir_all(&dir).await;
        let target = dir.join("secret.json");
        atomic_write_secret(&target, b"super-secret-data")
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read_to_string(&target).await.unwrap(),
            "super-secret-data"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = tokio::fs::metadata(&target).await.unwrap();
            assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        }
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn atomic_write_handles_concurrent_writes() {
        let dir = std::env::temp_dir().join(format!("test-atomic-{}", std::process::id()));
        let _ = tokio::fs::create_dir_all(&dir).await;
        let target = dir.join("config.json");
        let mut handles = vec![];
        for i in 0..10 {
            let target_clone = target.clone();
            handles.push(tokio::spawn(async move {
                atomic_write(&target_clone, format!("data-{i}")).await
            }));
        }
        for h in handles {
            h.await.unwrap().unwrap();
        }
        let content = tokio::fs::read_to_string(&target).await.unwrap();
        assert!(content.starts_with("data-"));
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
