//! Config / profile-state / conversations route handlers.

// Rust guideline compliant 2026-07-28

use crate::engine::S;
use crate::read_json;
use crate::types::{AppSettings, EngineProfile, ProfileState, SavedProfile};
use axum::Json;
use axum::body::Body;
use axum::extract::{Request, State as AxumState};
use axum::http::StatusCode;
use serde_json::{Value, json};

pub(crate) async fn get_config(AxumState(state): AxumState<S>) -> Json<Value> {
    let mut c = state.config.read().await.clone();
    // An empty `chat_computer_use_dir` means "never customized" — not
    // "deliberately blank" (there's no UI action that clears it back to "").
    // Resolve it to the live OS temp dir on every read rather than only at
    // `AppSettings::default()` time, since a config.json saved before this
    // field existed (or saved while the toggle was off) already persists an
    // explicit "" that a load-time default can never see past.
    if c.chat_computer_use_dir.is_empty() {
        c.chat_computer_use_dir = std::env::temp_dir().to_string_lossy().into_owned();
    }
    Json(redact_config(serde_json::to_value(&c).unwrap()))
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
    let cloud_api_set = is_set("cloudProviderApiKey");
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "hfToken".into(),
            json!(if hf_set { SECRET_MASK } else { "" }),
        );
        obj.insert(
            "apiKey".into(),
            json!(if api_set { SECRET_MASK } else { "" }),
        );
        obj.insert(
            "cloudProviderApiKey".into(),
            json!(if cloud_api_set { SECRET_MASK } else { "" }),
        );
    }
    v
}

pub(crate) async fn set_config(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
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
        merged.sandbox_binds = v
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect();
    }
    if let Some(v) = body.get("chatReflectionModel").and_then(|v| v.as_str()) {
        merged.chat_reflection_model = v.into();
    }
    if let Some(v) = body.get("chatBrowserTier").and_then(|v| v.as_str())
        && matches!(v, "allow" | "ask" | "deny")
    {
        merged.chat_browser_tier = v.into();
    }
    if let Some(v) = body.get("chatMemoryToolTier").and_then(|v| v.as_str())
        && matches!(v, "allow" | "ask" | "deny")
    {
        merged.chat_memory_tool_tier = v.into();
    }
    if let Some(v) = body
        .get("chatDeepResearchMaxAngles")
        .and_then(|v| v.as_u64())
        && (1..=10).contains(&v)
    {
        merged.chat_deep_research_max_angles = v as u32;
    }
    if let Some(v) = body
        .get("chatDeepResearchMaxSteps")
        .and_then(|v| v.as_u64())
        && (1..=30).contains(&v)
    {
        merged.chat_deep_research_max_steps = v as u32;
    }
    if let Some(v) = body
        .get("chatReflectionCritiqueMaxTokens")
        .and_then(|v| v.as_u64())
        && (50..=4000).contains(&v)
    {
        merged.chat_reflection_critique_max_tokens = v as u32;
    }
    if let Some(v) = body.get("chatComputerUseEnabled").and_then(|v| v.as_bool()) {
        merged.chat_computer_use_enabled = v;
    }
    if let Some(v) = body.get("chatComputerUseDir").and_then(|v| v.as_str()) {
        merged.chat_computer_use_dir = v.into();
    }
    if let Some(v) = body.get("chatComputerUsePerms").and_then(|v| v.as_str()) {
        merged.chat_computer_use_perms = v.into();
    }
    if let Some(v) = body.get("currencySymbol").and_then(|v| v.as_str()) {
        merged.currency_symbol = v.into();
    }
    if let Some(v) = body.get("costPerKwh").and_then(|v| v.as_f64())
        && v >= 0.0
    {
        merged.cost_per_kwh = v;
    }
    if let Some(v) = body.get("cloudProviderEnabled").and_then(|v| v.as_bool()) {
        merged.cloud_provider_enabled = v;
    }
    if let Some(v) = body.get("cloudProviderBaseUrl").and_then(|v| v.as_str()) {
        merged.cloud_provider_base_url = v.into();
    }
    if let Some(v) = body.get("cloudProviderApiKey").and_then(|v| v.as_str())
        && v != SECRET_MASK
    {
        merged.cloud_provider_api_key = v.into();
    }
    if let Some(v) = body
        .get("cloudProviderDefaultModel")
        .and_then(|v| v.as_str())
    {
        merged.cloud_provider_default_model = v.into();
    }
    if let Some(v) = body
        .get("cloudProviderPrimaryModel")
        .and_then(|v| v.as_str())
    {
        merged.cloud_provider_primary_model = v.into();
    }
    if let Some(v) = body
        .get("cloudProviderSubagentModel")
        .and_then(|v| v.as_str())
    {
        merged.cloud_provider_subagent_model = v.into();
    }
    if let Some(v) = body
        .get("cloudProviderExtraHeaders")
        .and_then(|v| v.as_str())
    {
        merged.cloud_provider_extra_headers = v.into();
    }
    if let Some(v) = body.get("cloudFallbackToLocal").and_then(|v| v.as_bool()) {
        merged.cloud_fallback_to_local = v;
    }
    if let Some(v) = body.get("cloudSmartTiering").and_then(|v| v.as_bool()) {
        merged.cloud_smart_tiering = v;
    }
    if let Some(v) = body.get("cloudPruneContext").and_then(|v| v.as_bool()) {
        merged.cloud_prune_context = v;
    }
    if let Some(v) = body.get("cloudUseLocalCompactor").and_then(|v| v.as_bool()) {
        merged.cloud_use_local_compactor = v;
    }
    if let Some(v) = body.get("cloudUseForPrimary").and_then(|v| v.as_bool()) {
        merged.cloud_use_for_primary = v;
    }
    if let Some(v) = body.get("cloudUseForSubagent").and_then(|v| v.as_bool()) {
        merged.cloud_use_for_subagent = v;
    }
    persist_config(&state, &merged).await?;
    Ok(Json(redact_config(serde_json::to_value(&merged).unwrap())))
}

pub(crate) async fn cloud_test(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let base_url = body
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("https://api.openai.com/v1");
    let api_key_raw = body.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    // An empty key or the redaction mask means "use the saved key" — the UI
    // only ever holds the mask, never the real secret (see `redact_config`).
    let api_key = if api_key_raw.trim().is_empty() || api_key_raw == SECRET_MASK {
        state.config.read().await.cloud_provider_api_key.clone()
    } else {
        api_key_raw.to_string()
    };
    let extra_headers = body
        .get("extraHeaders")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let base = base_url.trim().trim_end_matches('/');
    let url = if base.ends_with("/models") {
        base.to_string()
    } else {
        format!("{base}/models")
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_default();

    let mut req_builder = client.get(&url);
    if !api_key.trim().is_empty() {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", api_key.trim()));
    }
    if !extra_headers.trim().is_empty()
        && let Ok(parsed) = serde_json::from_str::<serde_json::Map<String, Value>>(extra_headers) {
        for (k, v) in parsed {
            if let Some(s) = v.as_str() {
                // Skip invalid header names/values instead of panicking
                // inside reqwest's `TryFrom` conversion.
                let name: Result<axum::http::HeaderName, _> = k.parse();
                let value: Result<axum::http::HeaderValue, _> = s.parse();
                if let (Ok(name), Ok(value)) = (name, value) {
                    req_builder = req_builder.header(name, value);
                }
            }
        }
    }
    let t0 = std::time::Instant::now();
    match req_builder.send().await {
        Ok(res) => {
            let latency_ms = t0.elapsed().as_millis() as u64;
            let status = res.status();
            if !status.is_success() {
                let text = res.text().await.unwrap_or_default();
                let err_msg = if text.len() > 200 {
                    &text[..200]
                } else {
                    &text
                };
                return Ok(Json(json!({
                    "ok": false,
                    "latencyMs": latency_ms,
                    "models": [],
                    "error": format!("HTTP {status}: {}", if err_msg.is_empty() { "request failed" } else { err_msg })
                })));
            }
            let data: Value = res.json().await.unwrap_or_default();
            let mut models = Vec::new();
            if let Some(arr) = data.get("data").and_then(|v| v.as_array()) {
                for item in arr {
                    if let Some(id) = item
                        .as_str()
                        .or_else(|| item.get("id").and_then(|v| v.as_str()))
                        && !id.is_empty() {
                        models.push(id.to_string());
                    }
                }
            }
            models.sort();
            Ok(Json(json!({
                "ok": true,
                "latencyMs": latency_ms,
                "models": models
            })))
        }
        Err(e) => {
            let latency_ms = t0.elapsed().as_millis() as u64;
            Ok(Json(json!({
                "ok": false,
                "latencyMs": latency_ms,
                "models": [],
                "error": e.to_string()
            })))
        }
    }
}

/// Write `cfg` to `<data>/config.json` and install it as the live config.
/// Shared by [`set_config`] and any other handler that mutates settings with
/// a side effect beyond a plain field edit (e.g. `remote::start`/`stop`).
pub(crate) async fn persist_config(
    state: &S,
    cfg: &AppSettings,
) -> Result<(), (StatusCode, String)> {
    let path = state.data_dir.join("config.json");
    if let Err(e) = tokio::fs::create_dir_all(&state.data_dir).await {
        tracing::event!(
            name: "config.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            data_dir = ?state.data_dir,
            "could not create data dir {{data_dir}}: {{error}}",
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not create data dir: {e}"),
        ));
    }
    if let Err(e) =
        crate::atomic_write_secret(&path, serde_json::to_string_pretty(cfg).unwrap()).await
    {
        tracing::event!(
            name: "config.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            path = ?path,
            "could not write config to {{path}}: {{error}}",
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not save config: {e}"),
        ));
    }
    *state.config.write().await = cfg.clone();
    Ok(())
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
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not create data dir: {e}"),
        ));
    }
    if let Err(e) = crate::atomic_write(&p, serde_json::to_string_pretty(&current).unwrap()).await {
        tracing::event!(
            name: "profile_state.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            path = ?p,
            "could not write profile state to {{path}}: {{error}}",
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not save profile state: {e}"),
        ));
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
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not create data dir: {e}"),
        ));
    }
    if let Err(e) = crate::atomic_write(&p, serde_json::to_string_pretty(&current).unwrap()).await {
        tracing::event!(
            name: "conversations.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            path = ?p,
            "could not write conversations to {{path}}: {{error}}",
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not save conversations: {e}"),
        ));
    }
    Ok(Json(json!({ "ok": true })))
}
