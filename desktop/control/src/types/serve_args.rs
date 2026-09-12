//! Engine launch-arg builder + argv equality (mirrors the web UI).
use super::settings::{EngineProfile, NumberOrAuto};

/// Build the `ninfer-serve` argv (after the artifact path) from a profile.
/// The flag is only emitted when its value is present — mirroring the web UI's
/// generated command, so what is reviewed is what runs.
pub fn build_serve_args(p: &EngineProfile, port: u16) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let kv = |a: &mut Vec<String>, flag: &str, v: &str| {
        if !v.is_empty() {
            a.push(flag.to_string());
            a.push(v.to_string());
        }
    };
    let flag = |a: &mut Vec<String>, f: &str, v: bool| {
        if v {
            a.push(f.to_string());
        }
    };
    kv(&mut a, "--host", &p.host.clone().unwrap_or_default());
    kv(&mut a, "--port", &p.port.unwrap_or(port).to_string());
    kv(&mut a, "--api-key", &p.api_key.clone().unwrap_or_default());
    kv(&mut a, "--model-id", &p.model_id.clone().unwrap_or_default());
    kv(&mut a, "--max-context", &p.max_context.map(|v| v.to_string()).unwrap_or_default());
    match &p.kv_capacity {
        None => {}
        Some(NumberOrAuto::Auto) => {
            a.push("--kv-capacity".into());
            a.push("auto".into());
        }
        Some(NumberOrAuto::Number(n)) => {
            a.push("--kv-capacity".into());
            a.push(n.to_string());
        }
    }
    kv(&mut a, "--max-concurrency", &p.max_concurrency.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--max-pending-requests", &p.max_pending_requests.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--pending-timeout-ms", &p.pending_timeout_ms.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--prefill-chunk", &p.prefill_chunk.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--log-stats-interval-ms", &p.log_stats_interval_ms.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--log-level", &p.log_level.clone().unwrap_or_default());
    kv(&mut a, "--device", &p.device.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--context-cost-presets", &p.context_cost_presets.clone().unwrap_or_default());
    kv(&mut a, "--max-request-mib", &p.max_request_mib.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--media-cache-mib", &p.media_cache_mib.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--media-live-mib", &p.media_live_mib.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--media-preprocess-threads", &p.media_preprocess_threads.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--request-log-jsonl", &p.request_log_jsonl.clone().unwrap_or_default());
    kv(&mut a, "--response-store-max-records", &p.response_store_max_records.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--response-store-max-mib", &p.response_store_max_mib.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--kv-dtype", &p.kv_dtype.clone().unwrap_or_default());
    if let Some(spec) = &p.spec {
        if !spec.is_empty() {
            a.push("--spec".into());
            a.push(spec.clone());
            kv(&mut a, "--draft-tokens", &p.draft_tokens.map(|v| v.to_string()).unwrap_or_default());
        }
    }
    flag(&mut a, "--lm-head-draft", p.lm_head_draft == Some(true));
    kv(&mut a, "--default-max-tokens", &p.default_max_tokens.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--default-thinking-budget", &p.default_thinking_budget.map(|v| v.to_string()).unwrap_or_default());
    flag(&mut a, "--vision", p.vision == Some(true));
    flag(&mut a, "--no-cuda-graph", p.no_cuda_graph == Some(true));
    flag(&mut a, "--no-prefix-reuse", p.no_prefix_reuse == Some(true));
    kv(&mut a, "--device-state-slots", &p.device_state_slots.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--host-state-slots", &p.host_state_slots.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--host-kv-mib", &p.host_kv_mib.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--max-private-continuations", &p.max_private_continuations.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--max-shared-prefixes", &p.max_shared_prefixes.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--max-long-anchors-per-continuation", &p.max_long_anchors_per_continuation.map(|v| v.to_string()).unwrap_or_default());
    flag(&mut a, "--no-thinking", p.no_thinking == Some(true));
    flag(&mut a, "--preserve-thinking", p.preserve_thinking == Some(true));
    kv(&mut a, "--temperature", &p.temperature.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--top-p", &p.top_p.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--top-k", &p.top_k.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--min-p", &p.min_p.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--presence-penalty", &p.presence_penalty.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--frequency-penalty", &p.frequency_penalty.map(|v| v.to_string()).unwrap_or_default());
    kv(&mut a, "--seed", &p.seed.map(|v| v.to_string()).unwrap_or_default());
    flag(&mut a, "--greedy", p.greedy == Some(true));
    flag(&mut a, "--cors", p.cors == Some(true));
    a
}

/// Order-insensitive flag/value equality for two argv lists (positional args
/// are ignored — the artifact path is compared separately). Mirrors the web
/// UI's `argsEqual`, so the server-computed restart-dirty check and the UI
/// cannot disagree about whether settings changed.
pub fn args_equal(a: &[String], b: &[String]) -> bool {
    fn norm(xs: &[String]) -> std::collections::HashMap<String, String> {
        let mut m = std::collections::HashMap::new();
        let mut i = 0;
        while i < xs.len() {
            if !xs[i].starts_with('-') {
                i += 1;
                continue;
            }
            if i + 1 < xs.len() && !xs[i + 1].starts_with('-') {
                m.insert(xs[i].clone(), xs[i + 1].clone());
                i += 2;
            } else {
                m.insert(xs[i].clone(), String::new());
                i += 1;
            }
        }
        m
    }
    let (ma, mb) = (norm(a), norm(b));
    ma.len() == mb.len() && ma.iter().all(|(k, v)| mb.get(k) == Some(v))
}

#[cfg(test)]
mod args_equal_tests {
    use super::*;
    use super::super::util::base_name;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn order_insensitive_and_positional_ignored() {
        let a = v(&["--port", "8080", "--model-id", "x", "artifact.ninfer"]);
        let b = v(&["--model-id", "x", "other.ninfer", "--port", "8080"]);
        assert!(args_equal(&a, &b));
        // A value change is dirty.
        assert!(!args_equal(&a, &v(&["--port", "9090", "--model-id", "x"])));
        // A changed flag set is dirty.
        assert!(!args_equal(&a, &v(&["--port", "8080"])));
    }

    #[test]
    fn flag_value_boundary_matches_javascript_semantics() {
        // `--greedy --port`: a value flag eats the next non-flag token only,
        // so `--greedy` maps to "" and `--port` stands alone with value 8080.
        // The JS normalization shares this rule, so both sides agree.
        let a = v(&["--greedy", "--port", "8080"]);
        let b = v(&["--port", "8080", "--greedy"]);
        assert!(args_equal(&a, &b));
        assert!(!args_equal(&a, &v(&["--port", "8080"])));
    }

    #[test]
    fn base_name_handles_plain_names_and_separators() {
        assert_eq!(base_name("/a/b/model.ninfer"), "model.ninfer");
        assert_eq!(base_name("model.ninfer"), "model.ninfer");
        assert_eq!(base_name(""), "");
    }
}

#[cfg(test)]
mod parity {
    use super::*;
    use std::path::Path;

    /// build_serve_args is the single engine launch-arg builder (dev and
    /// packaged launches share it — the former Node sidecar copy is gone).
    /// This test pins its argv against the fixture in tests/parity; change
    /// the builder intentionally by updating expected-args.json alongside it
    /// and reviewing the diff.
    #[test]
    fn serve_args_match_fixture() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/parity");
        let cases: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("canonical-profile.json"))
                .expect("read canonical-profile.json"),
        )
        .expect("parse canonical-profile.json");
        let expected: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("expected-args.json")).expect("read expected-args.json"),
        )
        .expect("parse expected-args.json");

        let cases = cases["cases"].as_array().expect("cases array");
        let expected = expected.as_array().expect("expected array");
        assert_eq!(cases.len(), expected.len(), "parity case count drift");

        for (case, want) in cases.iter().zip(expected.iter()) {
            // Deserializing through the real EngineProfile also exercises the
            // camelCase serde mapping the web UI depends on.
            let profile: EngineProfile = serde_json::from_value(case["profile"].clone())
                .unwrap_or_else(|e| panic!("profile {:?} failed to deserialize: {e}", case["name"]));
            let port = case["port"].as_u64().expect("case port") as u16;
            let got = build_serve_args(&profile, port);
            let want: Vec<String> =
                serde_json::from_value(want["args"].clone()).expect("expected args array");
            assert_eq!(got, want, "argv drift for parity case {:?}", case["name"]);
        }
    }
}

