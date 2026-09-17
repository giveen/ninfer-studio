//! Engine API proxy (SSE-safe) + port routing.

// Rust guideline compliant 2026-07-28

use crate::MAX_REQUEST_BODY_BYTES;
use crate::engine::{S, discover_engines, engine_model_info};
use crate::usage::{RequestSource, is_loggable_completion_path, wrap_for_usage_logging};
use axum::body::{Body, Bytes};
use axum::extract::{Request, State as AxumState};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;

/// Timeout for the `/v1/*` proxy to the engine — generation requests can run
/// long (large max_tokens, slow hardware), so this is much longer than a
/// typical HTTP timeout rather than a duplicated/undocumented guess.
pub(crate) const ENGINE_PROXY_TIMEOUT_SECS: u64 = 3600;

// ---------------------------------------------------------------------------
// Engine API proxy (SSE-safe)
// ---------------------------------------------------------------------------

/// Wait until the engine on `port` is ready (or transition from Starting to Running once health passes).
/// For the managed engine, only waits when it is in `Starting` state.
pub(crate) async fn wait_for_engine_ready(state: &S, port: u16) -> Result<(), String> {
    let start_time = std::time::Instant::now();
    let max_wait = std::time::Duration::from_secs(120);

    let is_managed = {
        let eng = state.engine.read().await;
        eng.port == Some(port)
    };

    if !is_managed {
        loop {
            if crate::engine::engine_health(state, port).await {
                return Ok(());
            }
            if start_time.elapsed() >= max_wait {
                return Err(format!(
                    "timeout waiting for engine on port {port} to become ready"
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }

    loop {
        let eng_state = {
            let eng = state.engine.read().await;
            if eng.port != Some(port) {
                return Ok(());
            }
            eng.state
        };

        match eng_state {
            crate::types::EngineState::Starting => {
                if crate::engine::engine_health(state, port).await {
                    let mut eng = state.engine.write().await;
                    if eng.port == Some(port) && eng.state == crate::types::EngineState::Starting {
                        eng.state = crate::types::EngineState::Running;
                    }
                    return Ok(());
                }
            }
            _ => {
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

    // 1. Short-circuit: check if primary managed engine matches model or if no model was requested
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
            if let Some(ref req_m) = model {
                if primary.model_id.as_deref() == Some(req_m.as_str()) {
                    wait_for_engine_ready(state, p).await?;
                    return Ok(p);
                }
            } else {
                wait_for_engine_ready(state, p).await?;
                return Ok(p);
            }
        }
    }

    // 2. Fallback: discover other running engines
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
            return Err(format!("503: no engine serves model '{m}' — available: {avail}"));
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
    let serde_json::Value::Object(ref mut body_map) = body_val else {
        return None;
    };

    let client_had_re = body_map.contains_key("reasoning_effort");

    // 1. generic top-level defaults (client fields win)
    if !defaults_trimmed.is_empty() {
        match serde_json::from_str::<serde_json::Value>(defaults_json) {
            Ok(serde_json::Value::Object(defaults_map)) => {
                for (k, v) in defaults_map {
                    body_map.entry(k).or_insert(v);
                }
            }
            Ok(_) => {
                tracing::warn!("default_request_params is not a JSON object");
            }
            Err(e) => {
                tracing::warn!("invalid default_request_params JSON: {e}");
            }
        }
    }

    // 2. reasoning effort → top-level reasoning_effort field
    //    (client explicit value wins; the dedicated control beats the generic
    //     default for this one key)
    if !re_trimmed.is_empty() && !client_had_re {
        body_map.insert(
            "reasoning_effort".to_string(),
            serde_json::Value::String(re_trimmed.to_string()),
        );
    }

    serde_json::to_vec(&body_val).ok()
}

pub(crate) async fn proxy(AxumState(state): AxumState<S>, req: Request<Body>) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req.headers().clone();
    let base_url = headers
        .get("x-ninfer-base-url")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let api_key_override = headers
        .get("x-ninfer-api-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let source = if base_url.is_some() {
        RequestSource::Remote
    } else {
        req.extensions()
            .get::<RequestSource>()
            .copied()
            .unwrap_or(RequestSource::Local)
    };

    let body_bytes = match axum::body::to_bytes(req.into_body(), MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "body too large").into_response(),
    };

    let (defaults_json, reasoning_effort) = {
        let c = state.config.read().await;
        (c.default_request_params.clone(), c.reasoning_effort.clone())
    };
    let body_bytes: Bytes =
        match merge_default_request_params(&body_bytes, &defaults_json, &reasoning_effort) {
            Some(v) => v.into(),
            None => body_bytes,
        };

    let parsed_body: Option<Value> = serde_json::from_slice(&body_bytes).ok();

    let should_log = is_loggable_completion_path(uri.path());
    let request_model: Option<String> = if should_log {
        parsed_body
            .as_ref()
            .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()))
    } else {
        None
    };

    let port_opt = if base_url.is_none() {
        match route_port(&state, &body_bytes).await {
            Ok(p) => Some(p),
            Err(msg) => {
                let status = if msg.starts_with("503") {
                    StatusCode::SERVICE_UNAVAILABLE
                } else {
                    StatusCode::BAD_REQUEST
                };
                return (status, msg).into_response();
            }
        }
    } else {
        None
    };

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

    let (usage_started, usage_streaming) = if should_log {
        (
            Some(std::time::Instant::now()),
            parsed_body
                .as_ref()
                .and_then(|v| v.get("stream").and_then(|s| s.as_bool()))
                .unwrap_or(false),
        )
    } else {
        (None, false)
    };

    let api_key = if base_url.is_some() {
        let cfg = state.config.read().await;
        crate::routes_config::resolve_secret(
            api_key_override.as_deref(),
            &cfg.cloud_provider_api_key,
        )
    } else {
        match api_key_override {
            Some(k) => k,
            None => state.config.read().await.api_key.clone(),
        }
    };

    let target = if let Some(ref base) = base_url {
        let path = uri.path();
        let path = if path.starts_with("/v1/") {
            &path[3..]
        } else {
            path
        };
        format!("{}{}", base.trim_end_matches('/'), path)
    } else {
        format!("http://127.0.0.1:{}{}", port_opt.unwrap(), uri.path())
    };

    let client = state.http_client.clone();
    let mut rb = client.request(method, &target);

    // Forward client headers except host, content-length, and x-ninfer-* control headers
    for (k, v) in headers.iter() {
        let k_str = k.as_str();
        if k_str.eq_ignore_ascii_case("host")
            || k_str.eq_ignore_ascii_case("content-length")
            || k_str.starts_with("x-ninfer-")
        {
            continue;
        }
        rb = rb.header(k, v);
    }

    let extra_headers_override = headers
        .get("x-ninfer-extra-headers")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if let Some(ref eh) = extra_headers_override
        && let Ok(parsed) = serde_json::from_str::<serde_json::Map<String, Value>>(eh)
    {
        for (k, v) in parsed {
            if let Some(s) = v.as_str() {
                let name: Result<HeaderName, _> = k.parse();
                let value: Result<HeaderValue, _> = s.parse();
                if let (Ok(name), Ok(value)) = (name, value) {
                    rb = rb.header(name, value);
                }
            }
        }
    }

    // Inject configured engine API key only when client sent no auth header
    if !api_key.is_empty()
        && headers.get(header::AUTHORIZATION).is_none()
        && headers.get("x-api-key").is_none()
    {
        rb = rb.bearer_auth(&api_key);
    }

    if base_url.is_some() {
        tracing::info!("Proxying /v1 request to cloud: target={}", target);
    }

    let resp = rb.body(body_bytes).send().await;

    let resp = match resp {
        Ok(r) => r,
        Err(err) => {
            tracing::error!("Proxy request to {} failed: {}", target, err);
            return (StatusCode::BAD_GATEWAY, "engine unreachable").into_response();
        }
    };

    let status = resp.status();
    if base_url.is_some() {
        tracing::info!("Cloud response from {}: {}", target, status);
    }
    let mut resp_headers = HeaderMap::new();

    // Forward response headers from engine to client
    for (k, v) in resp.headers().iter() {
        let k_str = k.as_str();
        if k_str.eq_ignore_ascii_case("transfer-encoding")
            || k_str.eq_ignore_ascii_case("content-length")
        {
            continue;
        }
        resp_headers.insert(k, v.clone());
    }

    if resp_headers.get(header::CACHE_CONTROL).is_none() {
        if let Ok(v) = HeaderValue::from_str("no-cache") {
            resp_headers.insert(header::CACHE_CONTROL, v);
        }
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_default_request_params_precedence() {
        let body = br#"{"model":"llama3","temperature":0.7}"#;

        // Dedicated reasoning_effort sets field when absent
        let res = merge_default_request_params(body, "", "high").unwrap();
        let val: Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(val["reasoning_effort"], "high");

        // Generic default merges non-conflicting fields
        let defaults = r#"{"top_p":0.9,"reasoning_effort":"low"}"#;
        let res2 = merge_default_request_params(body, defaults, "high").unwrap();
        let val2: Value = serde_json::from_slice(&res2).unwrap();
        assert_eq!(val2["top_p"], 0.9);
        assert_eq!(val2["temperature"], 0.7);
        // Dedicated control beats generic default
        assert_eq!(val2["reasoning_effort"], "high");

        // Client explicit reasoning_effort beats both generic default and dedicated control
        let client_re_body = br#"{"model":"llama3","reasoning_effort":"medium"}"#;
        let res3 = merge_default_request_params(client_re_body, defaults, "high").unwrap();
        let val3: Value = serde_json::from_slice(&res3).unwrap();
        assert_eq!(val3["reasoning_effort"], "medium");
    }

    #[test]
    fn test_merge_default_request_params_malformed_json_fallback() {
        let body = br#"{"model":"llama3"}"#;
        let bad_defaults = "{ invalid json ";

        // Malformed default_request_params logs warning but doesn't abort reasoning_effort injection
        let res = merge_default_request_params(body, bad_defaults, "medium").unwrap();
        let val: Value = serde_json::from_slice(&res).unwrap();
        assert_eq!(val["model"], "llama3");
        assert_eq!(val["reasoning_effort"], "medium");
    }
}

