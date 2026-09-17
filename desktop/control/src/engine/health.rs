//! Health + model-info probing of the locally spawned engine (`/health`, `/v1/models`, argv fallback).
use crate::types::State;
use serde_json::Value;
use std::time::Duration;

/// HTTP client timeout (ms) for a single health/model-info probe of the
/// locally spawned engine — short, since a slow local loopback response
/// means the engine isn't ready rather than that the network is slow.
const ENGINE_PROBE_TIMEOUT_MS: u64 = 1500;

/// Probe the engine's /health endpoint using state configuration.
pub async fn engine_health(state: &State, port: u16) -> bool {
    let api_key = state.config.read().await.api_key.clone();
    let api_key_opt = if api_key.is_empty() {
        None
    } else {
        Some(api_key.as_str())
    };
    engine_health_with_key(port, api_key_opt).await
}

/// Probe the engine's /health endpoint with an optional Bearer API key.
pub async fn engine_health_with_key(port: u16, api_key: Option<&str>) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(ENGINE_PROBE_TIMEOUT_MS))
        .build()
    else {
        tracing::error!("Failed to build reqwest HTTP client for engine health probe");
        return false;
    };
    let mut req = client.get(format!("http://127.0.0.1:{port}/health"));
    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }
    match req.send().await {
        Ok(r) => {
            if r.status().is_success() {
                true
            } else {
                tracing::warn!(
                    port,
                    status = %r.status(),
                    "Engine /health probe returned non-success status code"
                );
                false
            }
        }
        Err(err) => {
            tracing::debug!(port, error = %err, "Engine /health probe request failed");
            false
        }
    }
}

/// Probe the engine's /v1/models for the model id and its context window.
pub async fn engine_model_info(state: &State, port: u16) -> (Option<String>, Option<u64>) {
    let api_key = state.config.read().await.api_key.clone();
    let api_key_opt = if api_key.is_empty() {
        None
    } else {
        Some(api_key.as_str())
    };
    engine_model_info_with_key(port, api_key_opt).await
}

/// Probe the engine's /v1/models with an optional Bearer API key.
pub async fn engine_model_info_with_key(
    port: u16,
    api_key: Option<&str>,
) -> (Option<String>, Option<u64>) {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(ENGINE_PROBE_TIMEOUT_MS))
        .build()
    else {
        tracing::error!("Failed to build reqwest HTTP client for engine model info probe");
        return (None, None);
    };
    let mut req = client.get(format!("http://127.0.0.1:{port}/v1/models"));
    if let Some(key) = api_key {
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }

    let r = match req.send().await {
        Ok(res) => res,
        Err(err) => {
            tracing::debug!(port, error = %err, "Engine /v1/models probe request failed");
            return (None, None);
        }
    };

    let status = r.status();
    if !status.is_success() {
        tracing::warn!(
            port,
            status = %status,
            "Engine /v1/models probe returned non-success status code"
        );
        return (None, None);
    }

    let body = match r.json::<Value>().await {
        Ok(val) => val,
        Err(err) => {
            tracing::warn!(port, error = %err, "Failed to parse /v1/models JSON response body");
            return (None, None);
        }
    };

    let model = body["data"][0]["id"].as_str().map(|s| s.to_string());
    let max_context = body["data"][0]["max_model_len"].as_u64();
    if model.is_none() || max_context.is_none() {
        tracing::warn!(
            port,
            ?model,
            ?max_context,
            "Engine /v1/models response missing expected id or max_model_len fields"
        );
    }

    (model, max_context)
}

/// Parse context size string with unit suffixes (e.g., "240k" -> 245,760, "1m" -> 1,048,576).
fn parse_context_val(val: &str) -> Option<u64> {
    let val_trimmed = val.trim();
    if val_trimmed.is_empty() {
        return None;
    }
    let (num_part, multiplier) = if let Some(stripped) = val_trimmed.strip_suffix(['k', 'K']) {
        (stripped, 1024u64)
    } else if let Some(stripped) = val_trimmed.strip_suffix(['m', 'M']) {
        (stripped, 1024 * 1024u64)
    } else {
        (val_trimmed, 1u64)
    };

    num_part.parse::<u64>().ok().and_then(|n| n.checked_mul(multiplier))
}

/// Extract --max-context / -c from a raw argv (fallback when /v1/models has not been
/// probed yet, and for adopted engines).
pub fn argv_max_context(argv: Option<&Vec<String>>) -> Option<u64> {
    let argv = argv?.as_slice();
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if let Some(rest) = a.strip_prefix("--max-context=").or_else(|| a.strip_prefix("-c=")) {
            if let Some(parsed) = parse_context_val(rest) {
                return Some(parsed);
            }
        } else if a == "--max-context" || a == "-c" {
            if i + 1 < argv.len() {
                if let Some(parsed) = parse_context_val(&argv[i + 1]) {
                    return Some(parsed);
                }
            }
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod health_tests {
    use super::*;
    use axum::{
        Router,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::get,
    };
    use serde_json::json;
    use tokio::net::TcpListener;

    #[test]
    fn parses_both_max_context_forms_and_units() {
        let space = vec![
            "ninfer-serve".to_string(),
            "--max-context".to_string(),
            "240000".to_string(),
        ];
        assert_eq!(argv_max_context(Some(&space)), Some(240_000));

        let eq = vec!["--max-context=128000".to_string()];
        assert_eq!(argv_max_context(Some(&eq)), Some(128_000));

        let short_unit = vec!["-c".to_string(), "240k".to_string()];
        assert_eq!(argv_max_context(Some(&short_unit)), Some(245_760));

        let short_eq_unit = vec!["-c=1m".to_string()];
        assert_eq!(argv_max_context(Some(&short_eq_unit)), Some(1_048_576));

        // Skip malformed initial flag and parse subsequent valid flag
        let malformed_then_valid = vec![
            "--max-context".to_string(),
            "not_a_number".to_string(),
            "-c=128k".to_string(),
        ];
        assert_eq!(argv_max_context(Some(&malformed_then_valid)), Some(131_072));

        assert_eq!(argv_max_context(None), None);
        let dummy = vec!["--port".to_string(), "8080".to_string()];
        assert_eq!(argv_max_context(Some(&dummy)), None);
    }

    #[tokio::test]
    async fn engine_health_and_model_info_probe_authentication() {
        async fn health_handler(headers: HeaderMap) -> impl IntoResponse {
            if let Some(auth) = headers.get("authorization") {
                if auth == "Bearer secret123" {
                    return StatusCode::OK;
                }
            }
            StatusCode::UNAUTHORIZED
        }

        async fn models_handler(headers: HeaderMap) -> impl IntoResponse {
            if let Some(auth) = headers.get("authorization") {
                if auth == "Bearer secret123" {
                    return (
                        StatusCode::OK,
                        axum::Json(json!({
                            "data": [
                                {
                                    "id": "qwen2.5-coder",
                                    "max_model_len": 32768
                                }
                            ]
                        })),
                    );
                }
            }
            (
                StatusCode::UNAUTHORIZED,
                axum::Json(json!({"error": "unauthorized"})),
            )
        }

        let app = Router::new()
            .route("/health", get(health_handler))
            .route("/v1/models", get(models_handler));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        // Probes without key fail (401 Unauthorized)
        assert!(!engine_health_with_key(port, None).await);
        assert_eq!(engine_model_info_with_key(port, None).await, (None, None));

        // Probes with wrong key fail (401 Unauthorized)
        assert!(!engine_health_with_key(port, Some("wrong_key")).await);

        // Probes with correct key succeed
        assert!(engine_health_with_key(port, Some("secret123")).await);
        let (model, max_len) = engine_model_info_with_key(port, Some("secret123")).await;
        assert_eq!(model, Some("qwen2.5-coder".to_string()));
        assert_eq!(max_len, Some(32768));
    }
}
