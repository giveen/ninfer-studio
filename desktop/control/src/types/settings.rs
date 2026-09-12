//! Studio settings + engine profiles (persisted config surface).
use serde::{Deserialize, Serialize};
use std::fmt;

/// impls to redact secrets while still showing whether one is set, without
/// leaking the value itself into a log line or panic message.
pub(crate) fn redacted(s: &str) -> &'static str {
    if s.is_empty() { "" } else { "***" }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    /// Root of the NInfer checkout/build. The ninfer-serve binary
    /// (`build/apps/ninfer-serve`), the ninfer CLI, and the git source for
    /// pull/build are all derived from this single path.
    pub ninfer_path: String,
    pub models_dir: String,
    pub engine_port: u16,
    pub api_key: String,
    pub hf_cli: String,
    /// Optional HuggingFace token, passed to `hf download` as HF_TOKEN to
    /// unlock faster (non-rate-limited) downloads. Redacted in API responses —
    /// the UI only ever sees the mask or "".
    pub hf_token: String,
    pub build_command: String,
    /// Command run in the Coder workspace after agent edits (lint/typecheck).
    /// Empty = unset. Falls back to `build_command` when empty.
    pub lint_command: String,
    /// Command run in the Coder workspace after the lint check passes (tests).
    /// Empty = unset (no test step).
    pub test_command: String,
    /// JSON object merged (as defaults) into every proxied /v1 request body, so
    /// external clients (e.g. other coding harnesses) inherit these params without
    /// configuring each tool. Client-supplied fields win over these defaults.
    pub default_request_params: String,
    /// Global default reasoning effort injected into the top-level
    /// `reasoning_effort` field for every proxied request (client fields
    /// win). The dedicated UI control overrides the generic default for
    /// this single key. Empty = unset.
    pub reasoning_effort: String,
    /// Coding harness: the directory the "Code" mode is allowed to read/write/execute
    /// within. Every coder filesystem tool is confined to this root (path traversal
    /// rejected). Empty => no workspace configured. Serializes as `coderWorkspace`.
    pub coder_workspace: String,
    /// Coding harness: wrap the agent's shell in bubblewrap (bwrap) so it can
    /// write only inside the workspace (rest of the host read-only). Mirrors the
    /// sidecar's `coderSandbox`. Ignored when bwrap is not installed (exec then
    /// runs unsandboxed, like the sidecar). Serializes as `coderSandbox`.
    pub coder_sandbox: bool,
    /// Extra read-write bind mounts passed to bwrap alongside the workspace
    /// (e.g. shared model dirs a build step needs to write to). Serializes as
    /// `sandboxBinds`.
    pub sandbox_binds: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            // No hardcoded paths: a distributed build must not ship a developer's
            // machine layout. The user configures these in Settings; an empty value
            // is treated as "not configured" so we can surface a clear error early
            // instead of spawning a binary that does not exist on their machine.
            ninfer_path: String::new(),
            models_dir: String::new(),
            engine_port: 8080,
            api_key: String::new(),
            hf_cli: "hf".into(),
            hf_token: String::new(),
            build_command: "cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)".into(),
            lint_command: String::new(),
            test_command: String::new(),
            default_request_params: String::new(),
            reasoning_effort: String::new(),
            coder_sandbox: false,
            sandbox_binds: Vec::new(),
            coder_workspace: String::new(),
        }
    }
}

impl fmt::Debug for AppSettings {
    /// Redacts `api_key`/`hf_token` — the API layer already masks both before
    /// they ever reach a client (see `redact_config` in lib.rs); this impl
    /// keeps that guarantee even if the struct is ever printed directly (a
    /// stray log line, a panic message, ...).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AppSettings")
            .field("ninfer_path", &self.ninfer_path)
            .field("models_dir", &self.models_dir)
            .field("engine_port", &self.engine_port)
            .field("api_key", &redacted(&self.api_key))
            .field("hf_cli", &self.hf_cli)
            .field("hf_token", &redacted(&self.hf_token))
            .field("build_command", &self.build_command)
            .field("lint_command", &self.lint_command)
            .field("test_command", &self.test_command)
            .field("default_request_params", &self.default_request_params)
            .field("reasoning_effort", &self.reasoning_effort)
            .field("coder_workspace", &self.coder_workspace)
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Engine profile — one optional entry per ninfer-serve option.
// `None` ⇒ flag omitted ⇒ engine executable default.
// ---------------------------------------------------------------------------
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EngineProfile {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub api_key: Option<String>,
    pub model_id: Option<String>,

    // context & memory
    pub max_context: Option<u64>,
    /// number or "auto"
    #[serde(with = "opt_number_or_auto")]
    pub kv_capacity: Option<NumberOrAuto>,
    pub prefill_chunk: Option<u64>,
    pub default_max_tokens: Option<u64>,
    pub default_thinking_budget: Option<u64>,
    pub device: Option<u32>,

    // scheduling
    pub max_concurrency: Option<u8>,
    pub max_pending_requests: Option<u64>,
    pub pending_timeout_ms: Option<u64>,
    pub log_stats_interval_ms: Option<u64>,

    // kv cache
    pub kv_dtype: Option<String>,
    pub no_prefix_reuse: Option<bool>,
    pub device_state_slots: Option<u64>,
    pub host_state_slots: Option<u64>,
    pub host_kv_mib: Option<u64>,
    pub max_private_continuations: Option<u64>,
    pub max_shared_prefixes: Option<u64>,
    pub max_long_anchors_per_continuation: Option<u64>,

    // speculative decoding
    pub spec: Option<String>,
    pub draft_tokens: Option<u8>,
    pub lm_head_draft: Option<bool>,

    // vision & media
    pub vision: Option<bool>,
    pub media_cache_mib: Option<u64>,
    pub media_live_mib: Option<u64>,
    pub media_preprocess_threads: Option<u32>,
    pub max_request_mib: Option<u64>,

    // sampling defaults
    pub no_thinking: Option<bool>,
    pub preserve_thinking: Option<bool>,
    pub greedy: Option<bool>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<u32>,
    pub min_p: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub seed: Option<u64>,

    // logging & misc
    pub log_level: Option<String>,
    pub request_log_jsonl: Option<String>,
    pub response_store_max_records: Option<u64>,
    pub response_store_max_mib: Option<u64>,
    pub context_cost_presets: Option<String>,
    pub cors: Option<bool>,
    pub no_cuda_graph: Option<bool>,
}

impl fmt::Debug for EngineProfile {
    /// Redacts `api_key` for the same reason as [`AppSettings`]'s manual impl.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EngineProfile")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("api_key", &self.api_key.as_deref().map(redacted))
            .field("model_id", &self.model_id)
            .field("max_context", &self.max_context)
            .field("kv_capacity", &self.kv_capacity)
            .field("prefill_chunk", &self.prefill_chunk)
            .field("default_max_tokens", &self.default_max_tokens)
            .field("default_thinking_budget", &self.default_thinking_budget)
            .field("device", &self.device)
            .field("max_concurrency", &self.max_concurrency)
            .field("max_pending_requests", &self.max_pending_requests)
            .field("pending_timeout_ms", &self.pending_timeout_ms)
            .field("log_stats_interval_ms", &self.log_stats_interval_ms)
            .field("kv_dtype", &self.kv_dtype)
            .field("no_prefix_reuse", &self.no_prefix_reuse)
            .field("device_state_slots", &self.device_state_slots)
            .field("host_state_slots", &self.host_state_slots)
            .field("host_kv_mib", &self.host_kv_mib)
            .field("max_private_continuations", &self.max_private_continuations)
            .field("max_shared_prefixes", &self.max_shared_prefixes)
            .field("max_long_anchors_per_continuation", &self.max_long_anchors_per_continuation)
            .field("spec", &self.spec)
            .field("draft_tokens", &self.draft_tokens)
            .field("lm_head_draft", &self.lm_head_draft)
            .field("vision", &self.vision)
            .field("media_cache_mib", &self.media_cache_mib)
            .field("media_live_mib", &self.media_live_mib)
            .field("media_preprocess_threads", &self.media_preprocess_threads)
            .field("max_request_mib", &self.max_request_mib)
            .field("no_thinking", &self.no_thinking)
            .field("preserve_thinking", &self.preserve_thinking)
            .field("greedy", &self.greedy)
            .field("temperature", &self.temperature)
            .field("top_p", &self.top_p)
            .field("top_k", &self.top_k)
            .field("min_p", &self.min_p)
            .field("presence_penalty", &self.presence_penalty)
            .field("frequency_penalty", &self.frequency_penalty)
            .field("seed", &self.seed)
            .field("log_level", &self.log_level)
            .field("request_log_jsonl", &self.request_log_jsonl)
            .field("response_store_max_records", &self.response_store_max_records)
            .field("response_store_max_mib", &self.response_store_max_mib)
            .field("context_cost_presets", &self.context_cost_presets)
            .field("cors", &self.cors)
            .field("no_cuda_graph", &self.no_cuda_graph)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NumberOrAuto {
    Number(u64),
    Auto,
}

mod opt_number_or_auto {
    use super::*;
    pub fn deserialize<'de, D>(d: D) -> Result<Option<NumberOrAuto>, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let v: Option<serde_json::Value> = Option::deserialize(d)?;
        match v {
            None => Ok(None),
            // An empty string is the web UI's "unset" sentinel for kv-capacity
            // (the Segmented shows "follow" while keeping ''); treat it as None.
            Some(serde_json::Value::String(s)) if s.is_empty() => Ok(None),
            Some(serde_json::Value::String(s)) if s == "auto" => Ok(Some(NumberOrAuto::Auto)),
            Some(serde_json::Value::String(s)) => s
                .parse::<u64>()
                .map(NumberOrAuto::Number)
                .map(Some)
                .map_err(|_| serde::de::Error::custom("kv-capacity: expected number or 'auto'")),
            Some(serde_json::Value::Number(n)) => Ok(n.as_u64().map(NumberOrAuto::Number)),
            Some(_) => Err(serde::de::Error::custom("kv-capacity: expected number or 'auto'")),
        }
    }
    pub fn serialize<S>(v: &Option<NumberOrAuto>, s: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match v {
            None => s.serialize_none(),
            Some(NumberOrAuto::Auto) => s.serialize_str("auto"),
            Some(NumberOrAuto::Number(n)) => s.serialize_u64(*n),
        }
    }
}

#[cfg(test)]
mod debug_redaction {
    use super::*;

    const SECRET: &str = "sk-super-secret-value-do-not-leak";

    #[test]
    fn app_settings_debug_omits_api_key_and_hf_token() {
        let settings = AppSettings {
            api_key: SECRET.to_string(),
            hf_token: SECRET.to_string(),
            ..AppSettings::default()
        };
        let rendered = format!("{settings:?}");
        assert!(!rendered.contains(SECRET), "AppSettings Debug leaked the secret: {rendered}");
        // The field should still be visible as present, just masked.
        assert!(rendered.contains("api_key: \"***\""), "expected a masked api_key field: {rendered}");
        assert!(rendered.contains("hf_token: \"***\""), "expected a masked hf_token field: {rendered}");
    }

    #[test]
    fn app_settings_debug_shows_empty_when_unset() {
        let settings = AppSettings::default();
        let rendered = format!("{settings:?}");
        assert!(rendered.contains("api_key: \"\""), "expected an empty api_key field: {rendered}");
    }

    #[test]
    fn engine_profile_debug_omits_api_key() {
        let profile = EngineProfile { api_key: Some(SECRET.to_string()), ..EngineProfile::default() };
        let rendered = format!("{profile:?}");
        assert!(!rendered.contains(SECRET), "EngineProfile Debug leaked the secret: {rendered}");
        assert!(rendered.contains("api_key: Some(\"***\")"), "expected a masked api_key field: {rendered}");
    }

    #[test]
    fn engine_profile_debug_shows_none_when_unset() {
        let profile = EngineProfile::default();
        let rendered = format!("{profile:?}");
        assert!(rendered.contains("api_key: None"), "expected api_key: None: {rendered}");
    }
}

