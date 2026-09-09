//! NInfer Studio control plane — axum HTTP server.
//!
//! Mirrors the zero-dependency Node sidecar 1:1 so the web app is unchanged:
//!   /api/*        management endpoints (status, config, engine, logs, models, downloads, gpu)
//!   /health,/v1/* SSE-safe proxy to the engine port
//!   /…            static hosting of the built web app (SPA fallback)

pub mod engine;
pub mod gpu;
pub mod models;
pub mod repo;
pub mod types;

use crate::engine::{
    discover_engines, engine_health, engine_model_id, public_engine, refresh_engine_status,
    start_engine, stop_engine, S,
};
use crate::gpu::{gpu_stats, gpu_value};
use crate::models::{downloads_public, list_models, start_download};
use crate::repo::{start_update, update_public};
use crate::types::{AppEvent, ARTIFACTS, AppSettings, EngineProfile, LastStart, State};
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
        .route("/api/engine/start", post(engine_start))
        .route("/api/engine/stop", post(engine_stop))
        .route("/api/logs", get(logs))
        .route("/api/models", get(api_models))
        .route("/api/models/download", post(models_download))
        .route("/api/engine/update", post(engine_update))
        .route("/api/gpu", get(gpu))
        .route("/health", get(proxy))
        .route("/v1/{*path}", axum::routing::any(proxy))
        .with_state(state)
        .fallback_service(
            tower_http::services::ServeDir::new(dist).not_found_service(spa),
        )
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
    eprintln!(
        "[ninfier-control] listening on http://127.0.0.1:{port} (dist: {:?})",
        state.dist_dir
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
        eprintln!("[ninfier-control] engine port {port} — external engine detected");
    } else {
        eprintln!("[ninfier-control] engine port {port} — no engine detected");
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async fn read_json(req: Request<Body>) -> Result<Value, (StatusCode, String)> {
    let bytes = axum::body::to_bytes(req.into_body(), 32 * 1024 * 1024)
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
        "config": config,
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
    let mut out = vec![public_engine(&*primary)];
    let p_port = primary.port;
    let p_pid = primary.pid;
    for d in discover_engines().await {
        let Some(port) = d.port else {
            continue;
        };
        if p_port == Some(port) || p_pid == Some(d.pid) {
            continue;
        }
        let model = engine_model_id(state, port).await;
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

#[derive(Deserialize)]
struct StartBody {
    profile: Option<EngineProfile>,
    artifact: Option<String>,
}

async fn engine_start(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let parsed: StartBody = serde_json::from_value(body).unwrap_or(StartBody {
        profile: None,
        artifact: None,
    });
    let profile = parsed.profile.unwrap_or_default();
    Ok(Json(
        start_engine(&state, profile, parsed.artifact).await,
    ))
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
    if size <= 512 * 1024 {
        let Ok(text) = tokio::fs::read_to_string(path).await else {
            return (vec![], size);
        };
        let lines: Vec<String> = text.lines().rev().take(lines).collect::<Vec<_>>().into_iter().rev().map(|l| l.to_string()).collect();
        return (lines, size);
    }
    let mut buf = vec![0u8; 512 * 1024];
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
    Json(serde_json::to_value(&*c).unwrap())
}

async fn set_config(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let mut merged: AppSettings = {
        let c = state.config.read().await.clone();
        c
    };
    if let Some(v) = body.get("engineBinary").and_then(|v| v.as_str()) {
        merged.engine_binary = v.into();
    }
    if let Some(v) = body.get("engineCli").and_then(|v| v.as_str()) {
        merged.engine_cli = v.into();
    }
    if let Some(v) = body.get("modelsDir").and_then(|v| v.as_str()) {
        merged.models_dir = v.into();
    }
    if let Some(v) = body.get("enginePort").and_then(|v| v.as_u64()) {
        merged.engine_port = v as u16;
    }
    if let Some(v) = body.get("apiKey").and_then(|v| v.as_str()) {
        merged.api_key = v.into();
    }
    if let Some(v) = body.get("hfCli").and_then(|v| v.as_str()) {
        merged.hf_cli = v.into();
    }
    if let Some(v) = body.get("repoDir").and_then(|v| v.as_str()) {
        merged.repo_dir = v.into();
    }
    if let Some(v) = body.get("buildCommand").and_then(|v| v.as_str()) {
        merged.build_command = v.into();
    }
    let path = state.data_dir.join("config.json");
    let _ = tokio::fs::create_dir_all(&state.data_dir).await;
    let _ = tokio::fs::write(&path, serde_json::to_string_pretty(&merged).unwrap()).await;
    {
        let mut c = state.config.write().await;
        *c = merged.clone();
    }
    Ok(Json(serde_json::to_value(&merged).unwrap()))
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
        if let Some(m) = engine_model_id(state, port).await {
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

async fn proxy(AxumState(state): AxumState<S>, req: Request<Body>) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req.headers().clone();

    let body_bytes = match axum::body::to_bytes(req.into_body(), 32 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "body too large").into_response(),
    };

    let port = match route_port(&state, &body_bytes).await {
        Ok(p) => p,
        Err(msg) => return (StatusCode::BAD_REQUEST, msg).into_response(),
    };
    let api_key = { state.config.read().await.api_key.clone() };
    let target = format!("http://127.0.0.1:{port}{}", uri.path());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3600))
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
    resp_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
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
    let cwd = std::env::current_dir().unwrap_or_default();
    let candidate = cwd.join("data");
    if candidate.is_dir() {
        return candidate;
    }
    dirs::data_local_dir()
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
            if cfg.engine_binary.is_empty() {
                cfg.engine_binary = defaults.engine_binary;
            }
            if cfg.models_dir.is_empty() {
                cfg.models_dir = defaults.models_dir;
            }
            if cfg.engine_port == 0 {
                cfg.engine_port = defaults.engine_port;
            }
            if cfg.hf_cli.is_empty() {
                cfg.hf_cli = defaults.hf_cli;
            }
            if cfg.repo_dir.is_empty() {
                cfg.repo_dir = defaults.repo_dir;
            }
            if cfg.build_command.is_empty() {
                cfg.build_command = defaults.build_command;
            }
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
