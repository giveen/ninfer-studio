//! Health + model-info probing of the locally spawned engine (`/health`, `/v1/models`, argv fallback).
use crate::types::State;
use serde_json::Value;
use std::time::Duration;

/// HTTP client timeout (ms) for a single health/model-info probe of the
/// locally spawned engine — short, since a slow local loopback response
/// means the engine isn't ready rather than that the network is slow.
const ENGINE_PROBE_TIMEOUT_MS: u64 = 1500;

pub async fn engine_health(port: u16) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(ENGINE_PROBE_TIMEOUT_MS))
        .build()
    else {
        return false;
    };
    client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Probe the engine's /v1/models for the model id and its context window.
pub async fn engine_model_info(state: &State, port: u16) -> (Option<String>, Option<u64>) {
    let api_key = state.config.read().await.api_key.clone();
    let mut req = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/v1/models"))
        .timeout(Duration::from_millis(ENGINE_PROBE_TIMEOUT_MS));
    if !api_key.is_empty() {
        req = req.bearer_auth(&api_key);
    }
    let Some(r) = req.send().await.ok() else {
        return (None, None);
    };
    let Ok(body) = r.json::<Value>().await else {
        return (None, None);
    };
    let model = body["data"][0]["id"].as_str().map(|s| s.to_string());
    let max_context = body["data"][0]["max_model_len"].as_u64();
    (model, max_context)
}

/// --max-context out of a raw argv (fallback when /v1/models has not been
/// probed yet, and for adopted engines).
pub fn argv_max_context(argv: Option<&Vec<String>>) -> Option<u64> {
    let argv = argv?;
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        if let Some(rest) = a.strip_prefix("--max-context=") {
            return rest.parse().ok();
        }
        if a == "--max-context" {
            return it.next().and_then(|v| v.parse().ok());
        }
    }
    None
}

#[cfg(test)]
mod argv_tests {
    use super::argv_max_context;

    #[test]
    fn parses_both_max_context_forms() {
        let space = vec!["ninfer-serve".to_string(), "--max-context".to_string(), "240000".to_string()];
        assert_eq!(argv_max_context(Some(&space)), Some(240_000));
        let eq = vec!["--max-context=128000".to_string()];
        assert_eq!(argv_max_context(Some(&eq)), Some(128_000));
        assert_eq!(argv_max_context(None), None);
        assert_eq!(argv_max_context(Some(&vec!["--port".to_string(), "8080".to_string()])), None);
    }
}

