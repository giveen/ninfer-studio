//! Engine API proxy (SSE-safe) + port routing.

// Rust guideline compliant 2026-07-28

use crate::MAX_REQUEST_BODY_BYTES;
use crate::engine::{S, discover_engines, engine_model_info};
use crate::usage::{RequestSource, is_loggable_completion_path, wrap_for_usage_logging};
use axum::body::Body;
use axum::extract::{Request, State as AxumState};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use std::time::Duration;

/// Timeout for the `/v1/*` proxy to the engine — generation requests can run
/// long (large max_tokens, slow hardware), so this is much longer than a
/// typical HTTP timeout rather than a duplicated/undocumented guess.
pub(crate) const ENGINE_PROXY_TIMEOUT_SECS: u64 = 3600;

// ---------------------------------------------------------------------------
// Engine API proxy (SSE-safe)
// ---------------------------------------------------------------------------
/// Choose the engine port for a proxied request. When the JSON body names a
/// model, route to the engine that serves it; otherwise fall back to the
/// Wait until the engine on `port` is ready (or transition from Starting to Running once health passes).
/// Only waits if the managed engine is actively in `Starting` state.
pub(crate) async fn wait_for_engine_ready(state: &S, port: u16) -> Result<(), String> {
    let start_time = std::time::Instant::now();
    let max_wait = std::time::Duration::from_secs(120);

    loop {
        let eng_state = {
            let eng = state.engine.read().await;
            eng.state
        };

        match eng_state {
            crate::types::EngineState::Starting => {
                if crate::engine::engine_health(port).await {
                    let mut eng = state.engine.write().await;
                    if eng.state == crate::types::EngineState::Starting {
                        eng.state = crate::types::EngineState::Running;
                    }
                    return Ok(());
                }
            }
            _ => {
                // Running, External, Stopped, Failed, Stopping — return immediately without waiting
                return Ok(());
            }
        }

        if start_time.elapsed() >= max_wait {
            return Err(format!(
                "timeout waiting for engine on port {port} to become ready"
            ));
        }

        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

/// Choose the engine port for a proxied request. When the JSON body names a
/// model, route to the engine that serves it; otherwise fall back to the
/// primary engine (or the single discovered one, or the configured port).
pub(crate) async fn route_port(state: &S, body: &[u8]) -> Result<u16, String> {
    let model: Option<String> = serde_json::from_slice::<Value>(body).ok().and_then(|v| {
        v.get("model")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
    });
    let mut cands: Vec<(u16, Option<String>)> = Vec::new();
    {
        let primary = state.engine.read().await;
        if let Some(p) = primary.port
            && matches!(
                primary.state,
                crate::types::EngineState::Running
                    | crate::types::EngineState::External
                    | crate::types::EngineState::Starting
            )
        {
            cands.push((p, primary.model_id.clone()));
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
    let port = if let Some(m) = model {
        if let Some((p, _)) = cands
            .iter()
            .find(|(_, cm)| cm.as_deref() == Some(m.as_str()))
        {
            *p
        } else if cands.len() > 1 {
            let avail = cands
                .iter()
                .map(|(p, cm)| format!("{} (:{p})", cm.clone().unwrap_or_else(|| "?".into())))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!("no engine serves model '{m}' — available: {avail}"));
        } else if let Some((p, _)) = cands.first() {
            *p
        } else {
            state.config.read().await.engine_port
        }
    } else if let Some((p, _)) = cands.first() {
        *p
    } else {
        state.config.read().await.engine_port
    };

    wait_for_engine_ready(state, port).await?;
    Ok(port)
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
pub(crate) fn merge_default_request_params(
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
    if !defaults_trimmed.is_empty()
        && let serde_json::Value::Object(defaults_map) =
            serde_json::from_str::<serde_json::Value>(defaults_json).ok()?
        && let serde_json::Value::Object(body_map) = &mut body_val
    {
        for (k, v) in defaults_map {
            body_map.entry(k).or_insert(v);
        }
    }

    // 2. reasoning effort → top-level reasoning_effort field
    //    (client explicit value wins; the dedicated control beats the generic
    //     default for this one key)
    if !re_trimmed.is_empty()
        && let serde_json::Value::Object(body_map) = &mut body_val
    {
        body_map
            .entry("reasoning_effort")
            .or_insert_with(|| serde_json::Value::String(reasoning_effort.to_string()));
    }

    serde_json::to_vec(&body_val).ok()
}

pub(crate) async fn proxy(AxumState(state): AxumState<S>, req: Request<Body>) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req.headers().clone();
    // Set once per listener by `build_router` (loopback vs Remote Access) —
    // read before the request is consumed below.
    let source = req
        .extensions()
        .get::<RequestSource>()
        .copied()
        .unwrap_or(RequestSource::Local);

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
    let body_bytes =
        match merge_default_request_params(&body_bytes, &defaults_json, &reasoning_effort) {
            Some(v) => v.into(),
            None => body_bytes,
        };

    // Usage logging is best-effort and only cares about completion-shaped
    // endpoints; the request model (if named) seeds the logged event when the
    // engine's own response doesn't echo one back.
    let should_log = is_loggable_completion_path(uri.path());
    let request_model: Option<String> = if should_log {
        serde_json::from_slice::<Value>(&body_bytes)
            .ok()
            .and_then(|v| {
                v.get("model")
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            })
    } else {
        None
    };

    let base_url = headers
        .get("x-ninfer-base-url")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let api_key_override = headers
        .get("x-ninfer-api-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let port_opt = if base_url.is_none() {
        match route_port(&state, &body_bytes).await {
            Ok(p) => Some(p),
            Err(msg) => return (StatusCode::BAD_REQUEST, msg).into_response(),
        }
    } else {
        None
    };
    // Usage logging should attribute a request to the actual model artifact
    // (e.g. "qwen3_8_27b_nvfp4.ninfer") rather than the OpenAI-facing public
    // alias (e.g. "qwen3.8-27b") both the request and the engine's own
    // response echo back — the alias is a display/compat label (see
    // BasicsTab's "Public model alias"), not the file actually loaded. Only
    // known when `port` is this control plane's own managed engine; a
    // request routed to a separately discovered/external engine has no
    // artifact info available, so it keeps the alias (see `route_port`).
    let request_model = {
        let eng = state.engine.read().await;
        if let Some(port) = port_opt {
            if eng.port == Some(port) {
                eng.artifact
                    .as_deref()
                    .map(crate::types::base_name)
                    .map(str::to_string)
                    .or(request_model)
            } else {
                request_model
            }
        } else {
            request_model
        }
    };
    // Usage speed stats: capture when we hand the request to the engine
    // (the tap measures first-chunk and stream-end against this) and whether
    // the client asked for a streamed response (only those give a
    // prefill/decode split worth measuring).
    let (usage_started, usage_streaming) = if should_log {
        (
            Some(std::time::Instant::now()),
            serde_json::from_slice::<Value>(&body_bytes)
                .ok()
                .and_then(|v| v.get("stream").and_then(|s| s.as_bool()))
                .unwrap_or(false),
        )
    } else {
        (None, false)
    };
    let api_key = match api_key_override {
        Some(k) => k,
        None => state.config.read().await.api_key.clone(),
    };

    let target = if let Some(base) = base_url {
        let path = uri.path();
        let path = if path.starts_with("/v1/") {
            &path[3..]
        } else {
            path
        }; // Trim /v1/ for raw base urls
        format!("{}{}", base.trim_end_matches('/'), path)
    } else {
        format!("http://127.0.0.1:{}{}", port_opt.unwrap(), uri.path())
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(ENGINE_PROXY_TIMEOUT_SECS))
        .build()
        .ok();
    let Some(client) = client else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "client build failed").into_response();
    };

    let extra_headers_override = headers
        .get("x-ninfer-extra-headers")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let mut rb = client.request(method, &target);
    if let Some(ct) = headers.get(header::CONTENT_TYPE)
        && let Ok(v) = ct.to_str()
    {
        rb = rb.header(header::CONTENT_TYPE, v);
    }
    if let Some(ref eh) = extra_headers_override {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Map<String, Value>>(eh) {
            for (k, v) in parsed {
                if let Some(s) = v.as_str() {
                    let name: Result<axum::http::HeaderName, _> = k.parse();
                    let value: Result<axum::http::HeaderValue, _> = s.parse();
                    if let (Ok(name), Ok(value)) = (name, value) {
                        rb = rb.header(name, value);
                    }
                }
            }
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
    let request_id = resp
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let mut resp_headers = HeaderMap::new();
    if let Some(ct) = content_type {
        resp_headers.insert(header::CONTENT_TYPE, ct.parse().unwrap());
    }
    if let Some(rid) = request_id {
        resp_headers.insert("x-request-id", rid.parse().unwrap());
    }
    resp_headers.insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());

    // stream the body through (SSE-safe: chunks piped as they arrive), tapped
    // for usage logging on completion-shaped endpoints only.
    let stream = futures_util::StreamExt::boxed(resp.bytes_stream());
    let stream = if should_log {
        wrap_for_usage_logging(
            state.clone(),
            request_model,
            source,
            usage_streaming,
            usage_started,
            stream,
        )
    } else {
        stream
    };
    let body = Body::from_stream(stream);
    let mut builder = Response::builder().status(status);
    for (k, v) in resp_headers.iter() {
        builder = builder.header(k, v);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "bad response").into_response())
}
