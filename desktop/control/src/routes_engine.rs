//! Engine + status route handlers.

// Rust guideline compliant 2026-07-28

use axum::body::Body;
use axum::extract::{Request, State as AxumState};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use crate::engine::{
    discover_engines, engine_model_info, public_engine, refresh_engine_status,
    start_engine, stop_engine, S, VRAM_FLOOR_GIB,
};
use crate::gpu::{gpu_stats, gpu_value};
use crate::models::{downloads_public, list_models};
use crate::read_json;
use crate::repo::{start_update, update_public};
use crate::routes_config::redact_config;
use crate::types::{args_equal, base_name, build_serve_args, EngineProfile, ARTIFACTS};

pub(crate) async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

pub(crate) async fn status(AxumState(state): AxumState<S>) -> Json<Value> {
    refresh_engine_status(&state).await;
    let vram = {
        let eng = state.engine.read().await;
        match (eng.port, eng.state) {
            (Some(port), crate::types::EngineState::Running | crate::types::EngineState::Starting) => crate::engine::vram_status(&state.data_dir, port)
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
pub(crate) async fn engines_public(state: &S) -> Vec<Value> {
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
        }));
    }
    out
}

#[derive(Deserialize)]
pub(crate) struct UpdateBody {
    action: Option<String>,
}

pub(crate) async fn engine_update(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
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

pub(crate) async fn engine_start(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
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
            let msg = format!(
                "engine profile could not be read ({e}); the engine will start with defaults — check the settings you changed"
            );
            // The raw (pre-parse) profile can carry `apiKey` — never log it
            // verbatim, even on a parse failure the typed EngineProfile
            // (whose Debug impl already redacts it) never gets constructed.
            let mut redacted_profile = profile_val.clone();
            if let Value::Object(map) = &mut redacted_profile
                && map.get("apiKey").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty())
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
    let artifact = body.get("artifact").and_then(|v| v.as_str()).map(|s| s.to_string());
    let mut result = start_engine(&state, profile, artifact).await;
    if let Some(err) = profile_parse_error
        && let Value::Object(map) = &mut result
    {
        map.insert("profileParseError".to_string(), Value::String(err));
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
pub(crate) struct EngineArgsBody {
    #[serde(default)]
    profile: Option<Value>,
    #[serde(default)]
    artifact: Option<String>,
}

pub(crate) async fn engine_args(
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
    let running = matches!(eng.state, crate::types::EngineState::Running | crate::types::EngineState::External);
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
    if let Some(i) = args.iter().position(|a| a == "--api-key")
        && i + 1 < args.len()
        && !args[i + 1].is_empty()
    {
        args[i + 1] = "••••••••".to_string();
    }

    Ok(Json(json!({
        "args": args,
        "dirty": dirty,
        "portMatch": port_match,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopBody {
    external_pid: Option<u32>,
}

pub(crate) async fn engine_stop(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let parsed: StopBody = serde_json::from_value(body).unwrap_or(StopBody {
        external_pid: None,
    });
    Ok(Json(stop_engine(&state, parsed.external_pid).await))
}

