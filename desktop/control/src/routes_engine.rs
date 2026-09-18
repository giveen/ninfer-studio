//! Engine + status route handlers.

// Rust guideline compliant 2026-07-28

use crate::engine::{
    S, VRAM_FLOOR_GIB, discover_engines, engine_model_info, public_engine, refresh_engine_status,
    start_engine, stop_engine,
};
use crate::gpu::{gpu_stats, gpu_value};
use crate::models::{downloads_public, list_models};
use crate::read_json;
use crate::repo::{cancel_update, start_update, update_public};
use crate::routes_config::redact_config;
use crate::types::{ARTIFACTS, EngineProfile, args_equal, base_name, build_serve_args};
use axum::Json;
use axum::body::Body;
use axum::extract::{Request, State as AxumState};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) async fn engine_update_cancel(
    AxumState(state): AxumState<S>,
) -> Json<Value> {
    Json(cancel_update(&state).await)
}

pub(crate) async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

pub(crate) async fn status(AxumState(state): AxumState<S>) -> Json<Value> {
    refresh_engine_status(&state).await;
    let vram = {
        let eng = state.engine.read().await;
        match (eng.port, eng.state) {
            (
                Some(port),
                crate::types::EngineState::Running | crate::types::EngineState::Starting,
            ) => crate::engine::vram_status(&state.data_dir, port).await.map(
                |(runtime_gib, free_gib)| {
                    json!({
                        "runtimeGib": runtime_gib,
                        "freeGib": free_gib,
                        "floorGib": VRAM_FLOOR_GIB,
                        "under": free_gib < VRAM_FLOOR_GIB,
                    })
                },
            ),
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
    let config = serde_json::to_value(&*state.config.read().await).unwrap_or_else(|_| json!({}));
    Json(json!({
        "engine": engine,
        "engines": engines,
        "lastStart": serde_json::to_value(&*last_start).unwrap_or_else(|_| json!(null)),
        "gpu": gpu,
        "vram": vram,
        "config": redact_config(config),
        "artifacts": models.get("artifacts").cloned().unwrap_or_else(|| json!([])),
        "catalog": ARTIFACTS,
        "downloads": downloads,
        "update": update,
    }))
}

/// The primary engine plus every locally-discovered ninfer-serve process on
/// other ports (read-only external entries: pid, port, artifact, model, argv).
pub(crate) async fn engines_public(state: &S) -> Vec<Value> {
    let (primary_engine, p_port, p_pid) = {
        let primary = state.engine.read().await;
        (public_engine(&primary), primary.port, primary.pid)
    };
    let mut out = vec![primary_engine];
    let discovered = discover_engines().await;

    let futures = discovered.into_iter().filter_map(|d| {
        let port = d.port?;
        if p_port == Some(port) || p_pid == Some(d.pid) {
            return None;
        }
        Some(async move {
            let (model, _) = engine_model_info(state, port).await;
            json!({
                "state": crate::types::EngineState::External,
                "pid": d.pid,
                "port": port,
                "artifact": d.artifact,
                "modelId": model,
                "argv": d.argv,
                "startedAt": null,
                "logPath": null,
                "adopted": true,
                "failReason": null,
            })
        })
    });

    let external_engines = futures_util::future::join_all(futures).await;
    out.extend(external_engines);
    out
}

pub(crate) async fn engine_update(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let action = body
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let res = start_update(&state, action).await;
    if res.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let msg = res
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("update failed");
        return Err((StatusCode::BAD_REQUEST, msg.to_string()));
    }
    Ok(Json(res))
}

/// Recursively replace empty-string values with null. The web form uses "" as
/// "unset" for some fields; a typed Option<u64>/Option<bool> field cannot
/// deserialize from "" and would fail the entire profile parse.
pub(crate) fn sanitize_empty_strings(v: &mut Value) {
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

pub(crate) async fn engine_start(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    // Parse `profile` and `artifact` independently. A whole-body deserialization
    // previously fell back to defaults on any profile field error (e.g.
    // `kvCapacity: ""`), which silently dropped `artifact` and made a valid start
    // return a misleading `no_artifact`. Threading them separately means a
    // malformed profile field can never discard the chosen artifact.
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
            let msg = format!("engine profile could not be read ({e})");
            let mut redacted_profile = profile_val.clone();
            if let Value::Object(map) = &mut redacted_profile
                && map
                    .get("apiKey")
                    .and_then(|v| v.as_str())
                    .is_some_and(|s| !s.is_empty())
            {
                map.insert("apiKey".to_string(), Value::String("***".to_string()));
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

    if let Some(err) = profile_parse_error {
        return Ok(Json(json!({
            "ok": false,
            "message": err,
            "profileParseError": err
        })));
    }

    let artifact = body
        .get("artifact")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let result = start_engine(&state, profile, artifact).await;
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
pub(crate) struct EngineArgsBody {
    #[serde(default)]
    profile: Option<Value>,
    #[serde(default)]
    artifact: Option<String>,
}

fn extract_artifact(args: &[String]) -> Option<&str> {
    if let Some(art) = args.iter().find(|x| {
        x.ends_with(".ninfer")
            || x.ends_with(".gguf")
            || x.ends_with(".safetensors")
            || x.ends_with(".bin")
    }) {
        return Some(art.as_str());
    }
    let mut i = 0;
    while i < args.len() {
        if args[i].starts_with('-') {
            if i + 1 < args.len() && !args[i + 1].starts_with('-') {
                i += 2;
            } else {
                i += 1;
            }
        } else {
            return Some(args[i].as_str());
        }
    }
    None
}

pub(crate) async fn engine_args(
    AxumState(state): AxumState<S>,
    Json(body): Json<EngineArgsBody>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let mut sanitized = body.profile.clone().unwrap_or(Value::Null);
    sanitize_empty_strings(&mut sanitized);
    let (profile, profile_parse_error) = match serde_json::from_value::<EngineProfile>(sanitized) {
        Ok(p) => (p, None),
        Err(e) => {
            let msg = format!(
                "engine profile could not be read ({e}); using defaults for preview — check the settings you changed"
            );
            (EngineProfile::default(), Some(msg))
        }
    };
    let artifact = body.artifact.clone().unwrap_or_default();

    let (running, eng_port, running_args) = {
        let eng = state.engine.read().await;
        (
            matches!(
                eng.state,
                crate::types::EngineState::Running | crate::types::EngineState::External
            ),
            eng.port,
            eng.argv.clone(),
        )
    };
    let default_port = state.config.read().await.engine_port;
    let port = profile.port.unwrap_or(default_port);
    let port_match = eng_port.map(|p| p == port).unwrap_or(true);
    let form = build_serve_args(&profile, port);

    // Mirror of the UI's dirty rule: only meaningful for a matching port, and
    // an unreadable argv (adopted external engine) must never read as "changed".
    let dirty = if running && port_match {
        match running_args.as_deref().filter(|a| !a.is_empty()) {
            Some(ra) => {
                let running_artifact = extract_artifact(ra);
                !args_equal(ra, &form)
                    || base_name(&artifact) != base_name(running_artifact.unwrap_or(""))
            }
            None => {
                let last = state.last_start.read().await;
                match last.as_ref() {
                    Some(ls) => {
                        let art_opt = if artifact.is_empty() {
                            None
                        } else {
                            Some(artifact.as_str())
                        };
                        let running_form = build_serve_args(&ls.profile, ls.port);
                        ls.artifact.as_deref() != art_opt || !args_equal(&running_form, &form)
                    }
                    None => false,
                }
            }
        }
    } else {
        false
    };

    // The api key is the caller's own key (posted from their own UI) — mask it
    // in the response so the displayed command never shows a live credential.
    let mut args = form;
    if let Some(i) = args.iter().position(|a| a == "--api-key")
        && i + 1 < args.len()
        && !args[i + 1].is_empty()
    {
        args[i + 1] = "••••••••".to_string();
    }

    let mut res = json!({
        "args": args,
        "dirty": dirty,
        "portMatch": port_match,
    });
    if let Some(err) = profile_parse_error
        && let Value::Object(map) = &mut res
    {
        map.insert("profileParseError".to_string(), Value::String(err));
    }

    Ok(Json(res))
}

pub(crate) async fn engine_stop(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let external_pid = body
        .get("externalPid")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    let res = stop_engine(&state, external_pid).await;
    if res.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let msg = res
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("stop failed");
        return Err((StatusCode::BAD_REQUEST, msg.to_string()));
    }
    Ok(Json(res))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{State, now_ms};
    use std::sync::Arc;

    fn test_state() -> S {
        let dir = std::env::temp_dir().join(format!("ninfer_routes_engine_test_{}", now_ms()));
        Arc::new(State::new(dir.clone(), dir, None))
    }

    #[test]
    fn test_sanitize_empty_strings() {
        let mut v = json!({
            "model": "qwen",
            "kvCapacity": "",
            "nested": {
                "gpu": "",
                "ctx": 4096
            }
        });
        sanitize_empty_strings(&mut v);
        assert_eq!(
            v,
            json!({
                "model": "qwen",
                "kvCapacity": null,
                "nested": {
                    "gpu": null,
                    "ctx": 4096
                }
            })
        );
    }

    #[tokio::test]
    async fn test_engine_args_malformed_profile() {
        let state = test_state();
        let body = EngineArgsBody {
            profile: Some(json!({ "port": "not_a_number" })),
            artifact: Some("model.ninfer".into()),
        };

        let res = engine_args(AxumState(state), Json(body)).await.unwrap();
        assert!(res.0.get("profileParseError").is_some());
        assert_eq!(res.0["portMatch"], true);
    }

    #[tokio::test]
    async fn test_engine_start_malformed_profile_refuses_launch() {
        let state = test_state();
        let req = Request::builder()
            .body(Body::from(json!({ "profile": { "port": "invalid" } }).to_string()))
            .unwrap();

        let res = engine_start(AxumState(state), req).await.unwrap();
        assert_eq!(res.0["ok"], false);
        assert!(res.0.get("profileParseError").is_some());
    }
}

