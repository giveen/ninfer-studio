//! NInfer Studio control plane — axum HTTP server.
//!
//! Mirrors the zero-dependency Node sidecar 1:1 so the web app is unchanged:
//!   /api/*        management endpoints (status, config, engine, logs, models, downloads, gpu)
//!   /health,/v1/* SSE-safe proxy to the engine port
//!   /…            static hosting of the built web app (SPA fallback)

// Rust guideline compliant 2026-07-28

pub mod coder;
pub mod engine;
pub mod gpu;
pub mod models;
pub mod repo;
pub mod types;

use crate::engine::{
    discover_engines, engine_health, engine_model_info, public_engine, refresh_engine_status,
    start_engine, stop_engine, S, VRAM_FLOOR_GIB,
};
use crate::gpu::{gpu_stats, gpu_value};
use crate::models::{downloads_public, list_models, start_download};
use crate::repo::{start_update, update_public};
use crate::types::{
    args_equal, base_name, build_serve_args, strip_extended_prefix, AppEvent, ARTIFACTS, AppSettings, EngineProfile,
    LastStart, ProfileState, SavedProfile, State,
};
use tokio::sync::mpsc::UnboundedSender;
use axum::body::Body;
use axum::extract::{Query, Request, State as AxumState};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// Cap on a request body this control plane will buffer in memory — large
/// enough for chat/coder payloads (file attachments, long conversations)
/// without letting a client exhaust memory with an unbounded body.
const MAX_REQUEST_BODY_BYTES: usize = 32 * 1024 * 1024;

/// Threshold below which `tail_file` reads the whole file rather than seeking
/// to a tail window, and the size of that tail window for larger files —
/// generous enough to contain the requested line count for any log this app
/// produces.
const LOG_TAIL_WINDOW_BYTES: usize = 512 * 1024;

/// Timeout for the `/v1/*` proxy to the engine — generation requests can run
/// long (large max_tokens, slow hardware), so this is much longer than a
/// typical HTTP timeout rather than a duplicated/undocumented guess.
const ENGINE_PROXY_TIMEOUT_SECS: u64 = 3600;

// ---------------------------------------------------------------------------
// App construction
// ---------------------------------------------------------------------------
pub fn build_router(state: S) -> Router {
    let dist = state.dist_dir.clone();
    let index = dist.join("index.html");
    let spa = tower_http::services::ServeFile::new(index.clone());
    Router::new()
        .route("/api/health", get(health))
        .route("/api/status", get(status))
        .route("/api/config", get(get_config).post(set_config))
        .route("/api/profile-state", get(profile_state_get).post(profile_state_set))
        .route("/api/conversations", get(conversations_get).post(conversations_set))
        .route("/api/engine/start", post(engine_start))
        .route("/api/engine/stop", post(engine_stop))
        .route("/api/logs", get(logs))
        .route("/api/models", get(api_models))
        .route("/api/models/download", post(models_download))
        .route("/api/engine/update", post(engine_update))
        .route("/api/engine/args", post(engine_args))
        .route("/api/gpu", get(gpu))
        // Coding harness — control-plane endpoints (mirror apps/sidecar/server.js)
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
        .route("/api/coder/fs/b64", post(coder::fs_b64))
        .route("/api/coder/fs/patch", post(coder::fs_patch))
        .route("/api/coder/grep", post(coder::grep))
        .route("/api/coder/memory", get(coder::memory_get).post(coder::memory_set))
        .route("/api/coder/glob", post(coder::glob))
        .route("/api/coder/web/fetch", post(coder::web_fetch))
        .route("/api/coder/web/search", post(coder::web_search))
        .route("/health", get(proxy))
        .route("/v1/{*path}", axum::routing::any(proxy))
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

pub async fn serve(state: S, port: u16) -> std::io::Result<()> {
    serve_until_ready(state, port, None).await
}

/// Bind + serve, sending `()` on `ready` once the listener is up (if given).
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

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async fn status(AxumState(state): AxumState<S>) -> Json<Value> {
    refresh_engine_status(&state).await;
    let vram = {
        let eng = state.engine.read().await;
        match (eng.port, eng.state.as_str()) {
            (Some(port), s) if s == "running" || s == "starting" => engine::vram_status(&state.data_dir, port)
                .await
                .map(|(runtime_gib, free_gib)| {
                    json!({
                        "runtimeGib": runtime_gib,
                        "freeGib": free_gib,
                        "floorGib": VRAM_FLOOR_GIB,
                        "under": free_gib < VRAM_FLOOR_GIB,
                    })
                }),
            _ => None,
        }
    };
    let engine = public_engine(&*state.engine.read().await);
    let last_start = state.last_start.read().await;
    let engines = engines_public(&state).await;
    let gpu = gpu_value(&gpu_stats().await);
    let models = list_models(&state).await;
    let downloads = downloads_public(&state).await;
    let update = update_public(&state).await;
    let config = serde_json::to_value(&*state.config.read().await).unwrap();
    Json(json!({
        "engine": engine,
        "engines": engines,
        "lastStart": serde_json::to_value(&*last_start).unwrap(),
        "gpu": gpu,
        "vram": vram,
        "config": redact_config(config),
        "artifacts": models["artifacts"],
        "catalog": ARTIFACTS,
        "downloads": downloads,
        "update": update,
    }))
}

/// The primary engine plus every locally-discovered ninfer-serve process on
/// other ports (read-only external entries: pid, port, artifact, model, argv).
async fn engines_public(state: &S) -> Vec<Value> {
    let primary = state.engine.read().await;
    let mut out = vec![public_engine(&primary)];
    let p_port = primary.port;
    let p_pid = primary.pid;
    for d in discover_engines().await {
        let Some(port) = d.port else {
            continue;
        };
        if p_port == Some(port) || p_pid == Some(d.pid) {
            continue;
        }
        let (model, _) = engine_model_info(state, port).await;
        out.push(json!({
            "state": "external",
            "pid": d.pid,
            "port": port,
            "artifact": d.artifact,
            "modelId": model,
            "argv": d.argv,
            "startedAt": null,
            "logPath": null,
            "adopted": true,
            "failReason": null,
        }));
    }
    out
}

#[derive(Deserialize)]
struct UpdateBody {
    action: Option<String>,
}

async fn engine_update(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let parsed: UpdateBody = serde_json::from_value(body).unwrap_or(UpdateBody {
        action: None,
    });
    let action = parsed.action.unwrap_or_default();
    Ok(Json(start_update(&state, &action).await))
}

/// Recursively replace empty-string values with null. The web form uses "" as
/// "unset" for some fields; a typed Option<u64>/Option<bool> field cannot
/// deserialize from "" and would fail the entire profile parse.
fn sanitize_empty_strings(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (_, val) in map.iter_mut() {
                if val.as_str() == Some("") {
                    *val = Value::Null;
                } else {
                    sanitize_empty_strings(val);
                }
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                sanitize_empty_strings(item);
            }
        }
        _ => {}
    }
}

async fn engine_start(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    // Parse `profile` and `artifact` independently. A whole-body deserialization
    // previously fell back to defaults on any profile field error (e.g.
    // `kvCapacity: ""`), which silently dropped `artifact` and made a valid start
    // return a misleading `no_artifact`. The Node sidecar already threads them
    // separately; mirror that here so a malformed profile field can never
    // discard the chosen artifact.
    let profile_val = body.get("profile").cloned().unwrap_or(Value::Null);
    // Empty strings ("") are how the UI represents an unset field, but a ''
    // against a typed Option<u64>/Option<f64> field fails the WHOLE profile
    // parse. Coerce '' to null (unset) first; then parse strictly and — if it
    // still fails — never fall back silently: report the error in the response
    // so a dropped profile is visible instead of looking like "the GUI ignored
    // my settings".
    let mut sanitized = profile_val.clone();
    sanitize_empty_strings(&mut sanitized);
    let (profile, profile_parse_error) = match serde_json::from_value::<EngineProfile>(sanitized) {
        Ok(p) => (p, None),
        Err(e) => {
            let msg = format!(
                "engine profile could not be read ({e}); the engine will start with defaults — check the settings you changed"
            );
            // The raw (pre-parse) profile can carry `apiKey` — never log it
            // verbatim, even on a parse failure the typed EngineProfile
            // (whose Debug impl already redacts it) never gets constructed.
            let mut redacted_profile = profile_val.clone();
            if let Value::Object(map) = &mut redacted_profile {
                if map.get("apiKey").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty()) {
                    map.insert("apiKey".to_string(), Value::String("***".to_string()));
                }
            }
            tracing::event!(
                name: "engine.start.profile_parse_error",
                tracing::Level::WARN,
                error = %e,
                profile = %redacted_profile,
                "{msg}",
            );
            (EngineProfile::default(), Some(msg))
        }
    };
    let artifact = body.get("artifact").and_then(|v| v.as_str()).map(|s| s.to_string());
    let mut result = start_engine(&state, profile, artifact).await;
    if let Some(err) = profile_parse_error {
        if let Value::Object(map) = &mut result {
            map.insert("profileParseError".to_string(), Value::String(err));
        }
    }
    Ok(Json(result))
}

/// `POST /api/engine/args` — server is the source of truth for the launch
/// command and the restart-dirty check (P0-2: the web UI previously carried a
/// third copy of the launch-arg builder plus its own dirty logic; both lived
/// in EngineScreen.tsx and could drift from the builder that actually spawns
/// the engine). Response:
///   args        launch argv for the posted profile, api key masked
///   dirty       settings differ from the running engine (only computed while
///               an engine matching the profile's port is up)
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineArgsBody {
    #[serde(default)]
    profile: Option<Value>,
    #[serde(default)]
    artifact: Option<String>,
}

async fn engine_args(
    AxumState(state): AxumState<S>,
    Json(body): Json<EngineArgsBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let mut sanitized = body.profile.clone().unwrap_or(Value::Null);
    sanitize_empty_strings(&mut sanitized);
    let profile: EngineProfile =
        serde_json::from_value(sanitized).unwrap_or_else(|_| EngineProfile::default());
    let artifact = body.artifact.clone().unwrap_or_default();

    let (eng, last, cfg) = (state.engine.read().await, state.last_start.read().await, state.config.read().await);
    let port = profile.port.unwrap_or(cfg.engine_port);
    let running = eng.state == "running" || eng.state == "external";
    let port_match = eng.port.map(|p| p == port).unwrap_or(true);
    let running_args = eng.argv.as_deref().filter(|a| !a.is_empty());
    let form = build_serve_args(&profile, port);

    // Mirror of the UI's dirty rule: only meaningful for a matching port, and
    // an unreadable argv (adopted external engine) must never read as "changed".
    let dirty = if running && port_match {
        match running_args {
            Some(ra) => {
                let running_artifact = ra.iter().find(|x| !x.starts_with('-'));
                !args_equal(ra, &form)
                    || base_name(&artifact)
                        != base_name(running_artifact.map(|s| s.as_str()).unwrap_or(""))
            }
            None => match last.as_ref() {
                // The UI normalizes "" to null for the artifact, so an empty
                // artifact here means "none" as well.
                Some(ls) => {
                    let art_opt = if artifact.is_empty() { None } else { Some(artifact.as_str()) };
                    ls.artifact.as_deref() != art_opt
                        || serde_json::to_string(&ls.profile).ok() != serde_json::to_string(&profile).ok()
                }
                None => false,
            },
        }
    } else {
        false
    };

    // The api key is the caller's own key (posted from their own UI) — mask it
    // in the response so the displayed command never shows a live credential.
    let mut args = form;
    if let Some(i) = args.iter().position(|a| a == "--api-key") {
        if i + 1 < args.len() && !args[i + 1].is_empty() {
            args[i + 1] = "••••••••".to_string();
        }
    }

    Ok(Json(json!({
        "args": args,
        "dirty": dirty,
        "portMatch": port_match,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopBody {
    external_pid: Option<u32>,
}

async fn engine_stop(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let parsed: StopBody = serde_json::from_value(body).unwrap_or(StopBody {
        external_pid: None,
    });
    Ok(Json(stop_engine(&state, parsed.external_pid).await))
}

#[derive(Deserialize)]
struct LogsQuery {
    n: Option<usize>,
}

async fn logs(AxumState(state): AxumState<S>, Query(q): Query<LogsQuery>) -> Json<Value> {
    let n = q.n.unwrap_or(400);
    let log_path = state.engine.read().await.log_path.clone();
    let Some(path) = log_path else {
        return Json(json!({ "lines": [], "size": 0 }));
    };
    let tail = tail_file(&path, n).await;
    Json(json!({ "lines": tail.0, "size": tail.1 }))
}

async fn tail_file(path: &str, lines: usize) -> (Vec<String>, u64) {
    let Ok(md) = tokio::fs::metadata(path).await else {
        return (vec![], 0);
    };
    let size = md.len();
    if size <= LOG_TAIL_WINDOW_BYTES as u64 {
        let Ok(text) = tokio::fs::read_to_string(path).await else {
            return (vec![], size);
        };
        let lines: Vec<String> = text.lines().rev().take(lines).collect::<Vec<_>>().into_iter().rev().map(|l| l.to_string()).collect();
        return (lines, size);
    }
    let mut buf = vec![0u8; LOG_TAIL_WINDOW_BYTES];
    let Ok(mut f) = tokio::fs::File::open(path).await else {
        return (vec![], size);
    };
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let Ok(_pos) = f.seek(std::io::SeekFrom::End(-(buf.len() as i64))).await else {
        return (vec![], size);
    };
    let _ = f.read_exact(&mut buf).await;
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<String> = text.lines().rev().take(lines).collect::<Vec<_>>().into_iter().rev().map(|l| l.to_string()).collect();
    (lines, size)
}

async fn api_models(AxumState(state): AxumState<S>) -> Json<Value> {
    let mut v = list_models(&state).await;
    v["catalog"] = json!(ARTIFACTS);
    Json(v)
}

async fn models_download(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
    let body = read_json(req).await?;
    Ok(Json(start_download(&state, body).await))
}

async fn gpu(AxumState(state): AxumState<S>) -> Json<Value> {
    let _ = state;
    Json(gpu_value(&gpu_stats().await))
}

async fn get_config(AxumState(state): AxumState<S>) -> Json<Value> {
    let c = state.config.read().await;
    Json(redact_config(serde_json::to_value(&*c).unwrap()))
}

/// The shape a secret field takes in every client-facing response. The real
/// value is never sent back over the API; the UI echoes this mask (or "")
/// for untouched fields and set_config preserves the stored secret on seeing
/// it unchanged.
const SECRET_MASK: &str = "********";

/// Redact every secret field (`hfToken`, `apiKey`) before a config value
/// reaches a client — see [`SECRET_MASK`].
fn redact_config(mut v: Value) -> Value {
    let is_set = |field: &str| {
        v.get(field)
            .and_then(|t| t.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    };
    let hf_set = is_set("hfToken");
    let api_set = is_set("apiKey");
    if let Some(obj) = v.as_object_mut() {
        obj.insert("hfToken".into(), json!(if hf_set { SECRET_MASK } else { "" }));
        obj.insert("apiKey".into(), json!(if api_set { SECRET_MASK } else { "" }));
    }
    v
}

async fn set_config(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let mut merged: AppSettings = {
        let c = state.config.read().await.clone();
        c
    };
    if let Some(v) = body.get("ninferPath").and_then(|v| v.as_str()) {
        merged.ninfer_path = v.into();
    }
    if let Some(v) = body.get("modelsDir").and_then(|v| v.as_str()) {
        merged.models_dir = v.into();
    }
    if let Some(v) = body.get("enginePort").and_then(|v| v.as_u64()) {
        merged.engine_port = v as u16;
    }
    if let Some(v) = body.get("apiKey").and_then(|v| v.as_str()) {
        // "********" = untouched field (the UI only ever has the mask) — keep
        // the stored secret. Any other value, including "", replaces it.
        if v != SECRET_MASK {
            merged.api_key = v.into();
        }
    }
    if let Some(v) = body.get("hfCli").and_then(|v| v.as_str()) {
        merged.hf_cli = v.into();
    }
    if let Some(v) = body.get("hfToken").and_then(|v| v.as_str()) {
        // "********" = untouched field (the UI only ever has the mask) — keep
        // the stored secret. Any other value, including "", replaces it.
        if v != SECRET_MASK {
            merged.hf_token = v.into();
        }
    }
    if let Some(v) = body.get("buildCommand").and_then(|v| v.as_str()) {
        merged.build_command = v.into();
    }
    if let Some(v) = body.get("coderWorkspace").and_then(|v| v.as_str()) {
        merged.coder_workspace = v.into();
    }
    if let Some(v) = body.get("coderSandbox").and_then(|v| v.as_bool()) {
        merged.coder_sandbox = v;
    }
    if let Some(v) = body.get("sandboxBinds").and_then(|v| v.as_array()) {
        merged.sandbox_binds = v.iter().filter_map(|x| x.as_str().map(String::from)).collect();
    }
    let path = state.data_dir.join("config.json");
    let _ = tokio::fs::create_dir_all(&state.data_dir).await;
    let _ = tokio::fs::write(&path, serde_json::to_string_pretty(&merged).unwrap()).await;
    {
        let mut c = state.config.write().await;
        *c = merged.clone();
    }
    Ok(Json(redact_config(serde_json::to_value(&merged).unwrap())))
}

// ---------------------------------------------------------------------------
// Per-user profile state (engine profile + artifact + saved named profiles).
// Persisted to <data>/profile.json so it survives a restart; mirrors the web
// app's former browser-localStorage blob.
// ---------------------------------------------------------------------------
async fn profile_state_get(AxumState(state): AxumState<S>) -> Json<Value> {
    let p = state.data_dir.join("profile.json");
    match tokio::fs::read_to_string(&p).await {
        Ok(raw) => match serde_json::from_str::<ProfileState>(&raw) {
            Ok(ps) => Json(serde_json::to_value(&ps).unwrap_or_else(|_| json!({}))),
            Err(_) => Json(json!({ "profile": null, "artifact": "", "saved": [] })),
        },
        Err(_) => Json(json!({ "profile": null, "artifact": "", "saved": [] })),
    }
}

async fn profile_state_set(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body = read_json(req).await?;
    let mut current: ProfileState = {
        let p = state.data_dir.join("profile.json");
        match tokio::fs::read_to_string(&p).await {
            Ok(raw) => serde_json::from_str::<ProfileState>(&raw).unwrap_or_default(),
            Err(_) => ProfileState::default(),
        }
    };
    if let Some(v) = body.get("profile") {
        if let Ok(p) = serde_json::from_value::<EngineProfile>(v.clone()) {
            current.profile = Some(p);
        }
    }
    if let Some(v) = body.get("artifact") {
        if let Some(s) = v.as_str() {
            current.artifact = s.to_string();
        }
    }
    if let Some(v) = body.get("saved") {
        if let Ok(s) = serde_json::from_value::<Vec<SavedProfile>>(v.clone()) {
            current.saved = s;
        }
    }
    let p = state.data_dir.join("profile.json");
    tokio::fs::create_dir_all(&state.data_dir).await.ok();
    tokio::fs::write(&p, serde_json::to_string_pretty(&current).unwrap()).await.ok();
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Conversations + chat params. Persisted to <data>/chats.json (web-only shapes
// stored as raw JSON) so chat history survives a fresh install / AppImage run —
// previously it lived in the webview localStorage, which is origin-bound.
// ---------------------------------------------------------------------------
async fn conversations_get(AxumState(state): AxumState<S>) -> Json<Value> {
    let p = state.data_dir.join("chats.json");
    match tokio::fs::read_to_string(&p).await {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(v) => Json(v),
            Err(_) => Json(json!({ "conversations": [], "params": null, "presets": [] })),
        },
        Err(_) => Json(json!({ "conversations": [], "params": null, "presets": [] })),
    }
}

async fn conversations_set(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body = read_json(req).await?;
    let mut current: Value = {
        let p = state.data_dir.join("chats.json");
        match tokio::fs::read_to_string(&p).await {
            Ok(raw) => serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({})),
            Err(_) => json!({}),
        }
    };
    if let Some(v) = body.get("conversations") {
        if v.is_array() {
            current["conversations"] = v.clone();
        }
    }
    if body.get("params").is_some() {
        current["params"] = body["params"].clone();
    }
    if let Some(v) = body.get("presets") {
        if v.is_array() {
            current["presets"] = v.clone();
        }
    }
    let p = state.data_dir.join("chats.json");
    tokio::fs::create_dir_all(&state.data_dir).await.ok();
    tokio::fs::write(&p, serde_json::to_string_pretty(&current).unwrap()).await.ok();
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Engine API proxy (SSE-safe)
// ---------------------------------------------------------------------------
/// Choose the engine port for a proxied request. When the JSON body names a
/// model, route to the engine that serves it; otherwise fall back to the
/// primary engine (or the single discovered one, or the configured port).
async fn route_port(state: &S, body: &[u8]) -> Result<u16, String> {
    let model: Option<String> = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()));
    let mut cands: Vec<(u16, Option<String>)> = Vec::new();
    {
        let primary = state.engine.read().await;
        if let (Some(p), st) = (primary.port, primary.state.as_str()) {
            if st == "running" || st == "external" || st == "starting" {
                cands.push((p, primary.model_id.clone()));
            }
        }
    }
    for d in discover_engines().await {
        let Some(port) = d.port else {
            continue;
        };
        if cands.iter().any(|(p, _)| *p == port) {
            continue;
        }
        let (m, _) = engine_model_info(state, port).await;
        if let Some(m) = m {
            cands.push((port, Some(m)));
        }
    }
    if let Some(m) = model {
        if let Some((p, _)) = cands.iter().find(|(_, cm)| cm.as_deref() == Some(m.as_str())) {
            return Ok(*p);
        }
        if cands.len() > 1 {
            let avail = cands
                .iter()
                .map(|(p, cm)| format!("{} (:{p})", cm.clone().unwrap_or_else(|| "?".into())))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!("no engine serves model '{m}' — available: {avail}"));
        }
    }
    if let Some((p, _)) = cands.first() {
        return Ok(*p);
    }
    Ok(state.config.read().await.engine_port)
}

/// Merge request defaults into the body. Two sources, both with client fields
/// winning:
///   1. `defaults_json` — a free-form JSON object merged as top-level defaults
///      (so external clients inherit per-tool config).
///   2. `reasoning_effort` — a dedicated UI control that sets the top-level
///      `reasoning_effort` field for every request. It overrides the generic
///      default for this single key (it's the explicit control).
///
/// Returns the re-serialized body, or `None` if neither source applies / on any
/// parse error.
fn merge_default_request_params(
    body: &[u8],
    defaults_json: &str,
    reasoning_effort: &str,
) -> Option<Vec<u8>> {
    let defaults_trimmed = defaults_json.trim();
    let re_trimmed = reasoning_effort.trim();
    if defaults_trimmed.is_empty() && re_trimmed.is_empty() {
        return None;
    }
    let mut body_val: serde_json::Value = serde_json::from_slice(body).ok()?;

    // 1. generic top-level defaults (client fields win)
    if !defaults_trimmed.is_empty() {
        if let serde_json::Value::Object(defaults_map) =
            serde_json::from_str::<serde_json::Value>(defaults_json).ok()?
        {
            if let serde_json::Value::Object(body_map) = &mut body_val {
                for (k, v) in defaults_map {
                    body_map.entry(k).or_insert(v);
                }
            }
        }
    }

    // 2. reasoning effort → top-level reasoning_effort field
    //    (client explicit value wins; the dedicated control beats the generic
    //     default for this one key)
    if !re_trimmed.is_empty() {
        if let serde_json::Value::Object(body_map) = &mut body_val {
            body_map
                .entry("reasoning_effort")
                .or_insert_with(|| serde_json::Value::String(reasoning_effort.to_string()));
        }
    }

    serde_json::to_vec(&body_val).ok()
}

async fn proxy(AxumState(state): AxumState<S>, req: Request<Body>) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req.headers().clone();

    let body_bytes = match axum::body::to_bytes(req.into_body(), MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "body too large").into_response(),
    };

    // Inject configured default request params + reasoning effort (client fields
    // win) so external clients hitting the endpoint inherit them without
    // per-tool configuration.
    let (defaults_json, reasoning_effort) = {
        let c = state.config.read().await;
        (c.default_request_params.clone(), c.reasoning_effort.clone())
    };
    let body_bytes = match merge_default_request_params(&body_bytes, &defaults_json, &reasoning_effort) {
        Some(v) => v.into(),
        None => body_bytes,
    };

    let port = match route_port(&state, &body_bytes).await {
        Ok(p) => p,
        Err(msg) => return (StatusCode::BAD_REQUEST, msg).into_response(),
    };
    let api_key = { state.config.read().await.api_key.clone() };
    let target = format!("http://127.0.0.1:{port}{}", uri.path());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(ENGINE_PROXY_TIMEOUT_SECS))
        .build()
        .ok();
    let Some(client) = client else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "client build failed").into_response();
    };

    let mut rb = client.request(method, &target);
    if let Some(ct) = headers.get(header::CONTENT_TYPE) {
        if let Ok(v) = ct.to_str() {
            rb = rb.header(header::CONTENT_TYPE, v);
        }
    }
    // inject the configured engine API key when the client sent no auth header
    if !api_key.is_empty()
        && headers.get(header::AUTHORIZATION).is_none()
        && headers.get("x-api-key").is_none()
    {
        rb = rb.bearer_auth(&api_key);
    }
    let resp = rb.body(body_bytes.to_vec()).send().await;

    let Ok(resp) = resp else {
        return (StatusCode::BAD_GATEWAY, "engine unreachable").into_response();
    };

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let request_id = resp.headers().get("x-request-id").and_then(|v| v.to_str().ok()).map(|s| s.to_string());

    let mut resp_headers = HeaderMap::new();
    if let Some(ct) = content_type {
        resp_headers.insert(header::CONTENT_TYPE, ct.parse().unwrap());
    }
    if let Some(rid) = request_id {
        resp_headers.insert("x-request-id", rid.parse().unwrap());
    }
    resp_headers.insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());

    // stream the body through (SSE-safe: chunks piped as they arrive)
    let stream = resp.bytes_stream();
    let body = Body::from_stream(futures_util::StreamExt::boxed(stream));
    let mut builder = Response::builder().status(status);
    for (k, v) in resp_headers.iter() {
        builder = builder.header(k, v);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "bad response").into_response())
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
    if let Ok(raw) = tokio::fs::read_to_string(&p).await {
        if let Ok(mut cfg) = serde_json::from_str::<AppSettings>(&raw) {
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
    }
    // load the last-start record (dirty indicator for the Engine tab)
    let p = state.data_dir.join("last-start.json");
    if let Ok(raw) = tokio::fs::read_to_string(&p).await {
        if let Ok(ls) = serde_json::from_str::<LastStart>(&raw) {
            *state.last_start.write().await = Some(ls);
        }
    }
    state
}
