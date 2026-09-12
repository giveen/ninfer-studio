//! Config / profile-state / conversations route handlers.

// Rust guideline compliant 2026-07-28

use axum::body::Body;
use axum::extract::{Request, State as AxumState};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use crate::engine::S;
use crate::read_json;
use crate::types::{AppSettings, EngineProfile, ProfileState, SavedProfile};

pub(crate) async fn get_config(AxumState(state): AxumState<S>) -> Json<Value> {
    let c = state.config.read().await;
    Json(redact_config(serde_json::to_value(&*c).unwrap()))
}

/// The shape a secret field takes in every client-facing response. The real
/// value is never sent back over the API; the UI echoes this mask (or "")
/// for untouched fields and set_config preserves the stored secret on seeing
/// it unchanged.
pub(crate) const SECRET_MASK: &str = "********";

/// Redact every secret field (`hfToken`, `apiKey`) before a config value
/// reaches a client — see [`SECRET_MASK`].
pub(crate) fn redact_config(mut v: Value) -> Value {
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

pub(crate) async fn set_config(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let mut merged: AppSettings = state.config.read().await.clone();
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
    if let Err(e) = tokio::fs::create_dir_all(&state.data_dir).await {
        tracing::event!(
            name: "config.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            data_dir = ?state.data_dir,
            "could not create data dir {{data_dir}}: {{error}}",
        );
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("could not create data dir: {e}")));
    }
    if let Err(e) = tokio::fs::write(&path, serde_json::to_string_pretty(&merged).unwrap()).await {
        tracing::event!(
            name: "config.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            path = ?path,
            "could not write config to {{path}}: {{error}}",
        );
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("could not save config: {e}")));
    }
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
pub(crate) async fn profile_state_get(AxumState(state): AxumState<S>) -> Json<Value> {
    let p = state.data_dir.join("profile.json");
    match tokio::fs::read_to_string(&p).await {
        Ok(raw) => match serde_json::from_str::<ProfileState>(&raw) {
            Ok(ps) => Json(serde_json::to_value(&ps).unwrap_or_else(|_| json!({}))),
            Err(_) => Json(json!({ "profile": null, "artifact": "", "saved": [] })),
        },
        Err(_) => Json(json!({ "profile": null, "artifact": "", "saved": [] })),
    }
}

pub(crate) async fn profile_state_set(
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
    if let Some(v) = body.get("profile")
        && let Ok(p) = serde_json::from_value::<EngineProfile>(v.clone())
    {
        current.profile = Some(p);
    }
    if let Some(v) = body.get("artifact")
        && let Some(s) = v.as_str()
    {
        current.artifact = s.to_string();
    }
    if let Some(v) = body.get("saved")
        && let Ok(s) = serde_json::from_value::<Vec<SavedProfile>>(v.clone())
    {
        current.saved = s;
    }
    let p = state.data_dir.join("profile.json");
    if let Err(e) = tokio::fs::create_dir_all(&state.data_dir).await {
        tracing::event!(
            name: "profile_state.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            data_dir = ?state.data_dir,
            "could not create data dir {{data_dir}}: {{error}}",
        );
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("could not create data dir: {e}")));
    }
    if let Err(e) = tokio::fs::write(&p, serde_json::to_string_pretty(&current).unwrap()).await {
        tracing::event!(
            name: "profile_state.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            path = ?p,
            "could not write profile state to {{path}}: {{error}}",
        );
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("could not save profile state: {e}")));
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Conversations + chat params. Persisted to <data>/chats.json (web-only shapes
// stored as raw JSON) so chat history survives a fresh install / AppImage run —
// previously it lived in the webview localStorage, which is origin-bound.
// ---------------------------------------------------------------------------
pub(crate) async fn conversations_get(AxumState(state): AxumState<S>) -> Json<Value> {
    let p = state.data_dir.join("chats.json");
    match tokio::fs::read_to_string(&p).await {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(v) => Json(v),
            Err(_) => Json(json!({ "conversations": [], "params": null, "presets": [] })),
        },
        Err(_) => Json(json!({ "conversations": [], "params": null, "presets": [] })),
    }
}

pub(crate) async fn conversations_set(
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
    if let Some(v) = body.get("conversations")
        && v.is_array()
    {
        current["conversations"] = v.clone();
    }
    if body.get("params").is_some() {
        current["params"] = body["params"].clone();
    }
    if let Some(v) = body.get("presets")
        && v.is_array()
    {
        current["presets"] = v.clone();
    }
    let p = state.data_dir.join("chats.json");
    if let Err(e) = tokio::fs::create_dir_all(&state.data_dir).await {
        tracing::event!(
            name: "conversations.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            data_dir = ?state.data_dir,
            "could not create data dir {{data_dir}}: {{error}}",
        );
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("could not create data dir: {e}")));
    }
    if let Err(e) = tokio::fs::write(&p, serde_json::to_string_pretty(&current).unwrap()).await {
        tracing::event!(
            name: "conversations.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            path = ?p,
            "could not write conversations to {{path}}: {{error}}",
        );
        return Err((StatusCode::INTERNAL_SERVER_ERROR, format!("could not save conversations: {e}")));
    }
    Ok(Json(json!({ "ok": true })))
}

