//! Shared types for the NInfer Studio control plane.
//! Field names mirror the web app's TypeScript types 1:1 (camelCase JSON).

// Rust guideline compliant 2026-07-28

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::AtomicBool;
use tokio::sync::mpsc::UnboundedSender;

/// Renders as `""` when empty, `"***"` otherwise — used by manual `Debug`
/// impls to redact secrets while still showing whether one is set, without
/// leaking the value itself into a log line or panic message.
pub(crate) fn redacted(s: &str) -> &'static str {
    if s.is_empty() { "" } else { "***" }
}

/// Event emitted by the control plane for desktop-shell concerns (tray state,
/// OS notifications). The control crate stays framework-agnostic: the Tauri app
/// wires a receiver to the notification plugin + tray. `None` in `State` ⇒ the
/// event is dropped (e.g. the standalone control-plane binary).
#[derive(Debug, Clone)]
pub enum AppEvent {
    /// Engine transitioned to healthy/running.
    EngineReady { model: Option<String>, port: u16 },
    /// Engine was stopped (by the user or externally).
    EngineStopped,
    /// Spawn or health check failed.
    EngineFailed { reason: Option<String> },
    /// A model download finished (`ok = false` on failure/cancel).
    DownloadFinished { file: String, ok: bool },
    /// A repo pull/build job finished.
    BuildFinished { action: String, ok: bool },
}

// ---------------------------------------------------------------------------
// App settings (persisted to <data>/config.json)
// ---------------------------------------------------------------------------

/// Strip the Windows extended-length prefix (`\\?\` or `//?/`) that
/// `std::fs::canonicalize` adds to most absolute paths on Windows, so the
/// stored workspace string matches the plain form the UI's directory picker
/// produces (`C:\tmp`, not `\\?\C:\tmp`) — otherwise the web store (keyed
/// by the plain path) can't find the persisted workspace on the next start
/// and spawns a duplicate entry with a fresh conversation.
///
/// UNC paths need care: canonicalize yields `\\?\UNC\server\share`, and a
/// bare `UNC\server\share` would be a *relative* path — so the leading UNC
/// separators are restored and the tail is normalized to backslashes,
/// giving `\\server\share` (the picker's form).
pub fn strip_extended_prefix(p: &str) -> String {
    for pre in ["\\\\?\\", "\\\\?/", "//?/"] {
        if let Some(rest) = p.strip_prefix(pre) {
            for unc in ["UNC\\", "UNC/"] {
                if let Some(tail) = rest.strip_prefix(unc) {
                    return format!("\\\\{}", tail.replace('/', "\\"));
                }
            }
            return rest.to_string();
        }
    }
    p.to_string()
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

/// Basename of a filesystem-ish path (`/a/b/c` -> `c`); whole string when there
/// is no separator. Mirrors the UI's `baseName` for artifact comparison.
pub fn base_name(p: &str) -> &str {
    match p.rsplit_once('/') {
        Some((_, rest)) => rest,
        None => p,
    }
}

// ---------------------------------------------------------------------------
// Registered artifact catalog (mirrors the NInfer README model table)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub file: &'static str,
    pub model_id: &'static str,
    pub model: &'static str,
    pub weights: &'static str,
    pub repo: &'static str,
    pub card: &'static str,
    pub spec: &'static str,
    pub vision: bool,
}

pub const ARTIFACTS: &[CatalogEntry] = &[
    CatalogEntry {
        file: "qwen3_6_27b.ninfer",
        model_id: "qwen3.6-27b",
        model: "Qwen3.6-27B",
        weights: "groupwise-int",
        repo: "neroued/Qwen3.6-27B-NInfer",
        card: "Qwen3.6-27B-NInfer",
        spec: "mtp (1..5) or off",
        vision: true,
    },
    CatalogEntry {
        file: "qwen3_6_27b_nvfp4.ninfer",
        model_id: "qwen3.6-27b",
        model: "Qwen3.6-27B",
        weights: "nvfp4",
        repo: "neroued/Qwen3.6-27B-nvfp4-NInfer",
        card: "Qwen3.6-27B-nvfp4-NInfer",
        spec: "mtp (1..5) or off",
        vision: true,
    },
    CatalogEntry {
        file: "qwen3_8_27b.ninfer",
        model_id: "qwen3.8-27b",
        model: "Qwen3.8-27B",
        weights: "groupwise-int",
        repo: "neroued/Qwen3.8-27B-NInfer",
        card: "Qwen3.8-27B-NInfer",
        spec: "mtp (1..5) or dflash2 (1..15) or off",
        vision: true,
    },
    CatalogEntry {
        file: "qwen3_8_27b_nvfp4.ninfer",
        model_id: "qwen3.8-27b",
        model: "Qwen3.8-27B",
        weights: "nvfp4",
        repo: "neroued/Qwen3.8-27B-nvfp4-NInfer",
        card: "Qwen3.8-27B-nvfp4-NInfer",
        spec: "mtp (1..5) or dflash2 (1..15) or off",
        vision: true,
    },
    CatalogEntry {
        file: "qwen3_6_35b_a3b.ninfer",
        model_id: "qwen3.6-35b-a3b",
        model: "Qwen3.6-35B-A3B",
        weights: "groupwise-int",
        repo: "neroued/Qwen3.6-35B-A3B-NInfer",
        card: "Qwen3.6-35B-A3B-NInfer",
        spec: "mtp (1..5) or dflash (1..15) or off",
        vision: true,
    },
];

// ---------------------------------------------------------------------------
// Engine lifecycle state — an enum (not String) so a mistyped state is a
// compile error rather than a silent no-match. Wire format keeps the same
// lowercase strings the web UI already matches on (`EngineState` in
// apps/web/src/lib/types.ts), via serde.
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineState {
    #[default]
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
    External,
}

// ---------------------------------------------------------------------------
// Runtime state shapes (serialized for the UI)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStatus {
    pub state: EngineState,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub artifact: Option<String>,
    pub model_id: Option<String>,
    pub argv: Option<Vec<String>>,
    pub started_at: Option<u64>,
    pub log_path: Option<String>,
    pub adopted: bool,
    pub fail_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuApp {
    pub pid: u32,
    pub name: String,
    /// Explicit rename: serde's `camelCase` yields `memMib`, but the sidecar
    /// and the web type (types.ts `GpuApp`) both spell it `memMiB` — the API
    /// must match them, so this field is renamed explicitly.
    #[serde(rename = "memMiB")]
    pub mem_mib: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuStats {
    pub available: bool,
    pub name: Option<String>,
    pub mem_used_mib: Option<u64>,
    pub mem_total_mib: Option<u64>,
    pub util_pct: Option<u64>,
    pub apps: Vec<GpuApp>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArtifact {
    pub file: String,
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    pub known: Option<CatalogEntry>,
    pub model_id: Option<String>,
    pub model: Option<String>,
    pub weights: Option<String>,
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateJob {
    pub id: String,
    pub action: String, // "pull" | "build"
    pub cmd: String,
    pub pid: Option<u32>,
    pub out: String,
    pub exit_code: Option<i32>,
    pub done: bool,
    pub failed: bool,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadRec {
    pub id: String,
    pub repo: String,
    pub file: String,
    pub local_dir: String,
    pub pid: Option<u32>,
    pub out: String,
    pub exit_code: Option<i32>,
    pub done: bool,
    pub failed: bool,
    /// total bytes to download (from `hf download --dry-run --json`), if known
    pub total_bytes: Option<u64>,
    /// bytes downloaded so far, sampled from the staging blob on disk
    pub downloaded_bytes: u64,
    /// current throughput in bytes/sec (0 if unknown)
    pub speed_bps: f64,
    pub started_at: u64,
}

// ---------------------------------------------------------------------------
// In-memory engine state
// ---------------------------------------------------------------------------
#[derive(Debug, Default)]
pub struct EngineInner {
    pub state: EngineState,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub artifact: Option<String>,
    pub model_id: Option<String>,
    /// Context window of the loaded model: from the engine's /v1/models
    /// (max_model_len) with a --max-context argv fallback, so the chat UI can
    /// track usage without the user setting anything.
    pub max_context: Option<u64>,
    pub argv: Option<Vec<String>>,
    pub started_at: Option<u64>,
    pub log_path: Option<String>,
    pub adopted: bool,
    pub fail_reason: Option<String>,
    pub deadline: Option<u64>, // unix ms
}

impl EngineInner {
    /// Common tail of every stop path: no process is running and Studio owns
    /// nothing. (The external-watch branch additionally clears `argv`, which
    /// described a foreign process that is now gone.)
    pub fn reset_stopped(&mut self) {
        self.state = EngineState::Stopped;
        self.adopted = false;
        self.pid = None;
    }

    /// Record a failure with its reason. Callers that also notify the desktop
    /// shell use `engine::fail_and_emit` instead.
    pub fn mark_failed(&mut self, reason: impl Into<String>) {
        self.state = EngineState::Failed;
        self.fail_reason = Some(reason.into());
    }

    /// The reaper's transition: the spawned child exited on its own.
    pub fn mark_exited(&mut self) {
        self.mark_failed("engine process exited");
        self.pid = None;
        self.adopted = false;
    }

    /// Record probed model identity (id + context window) together.
    pub fn assign_model_info(&mut self, model_id: Option<String>, max_context: Option<u64>) {
        self.model_id = model_id;
        self.max_context = max_context;
    }

    /// Begin stopping (a signal is in flight; the stopped reset lands after).
    pub fn begin_stopping(&mut self) {
        self.state = EngineState::Stopping;
    }
}

/// The (profile, artifact) pair used for the most recent engine start.
/// Persisted to `<data>/last-start.json` so the UI can tell whether the
/// running engine matches the current form ("dirty" indicator).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LastStart {
    pub port: u16,
    pub profile: EngineProfile,
    pub artifact: Option<String>,
    pub at: u64,
}

// ---------------------------------------------------------------------------
// Per-user profile state — the live engine profile, the chosen artifact, and the
// named saved profiles. Persisted to <data>/profile.json (mirrors the web app's
// former browser-localStorage blob) so the settings survive a restart.
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProfile {
    pub name: String,
    pub profile: EngineProfile,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfileState {
    /// `None` ⇒ no profile persisted yet; the UI falls back to its built-in preset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<EngineProfile>,
    pub artifact: String,
    pub saved: Vec<SavedProfile>,
}

#[derive(Debug)]
pub struct State {
    pub config: tokio::sync::RwLock<AppSettings>,
    pub engine: tokio::sync::RwLock<EngineInner>,
    pub last_start: tokio::sync::RwLock<Option<LastStart>>,
    pub child: tokio::sync::Mutex<Option<tokio::process::Child>>,
    pub log_file: tokio::sync::Mutex<Option<tokio::fs::File>>,
    pub downloads: tokio::sync::Mutex<HashMap<String, DownloadRec>>,
    pub update_job: tokio::sync::Mutex<Option<UpdateJob>>,
    /// Coder "safe mode" (mirrors the sidecar's `coderSafeMode`): when true,
    /// clearly destructive shell commands are refused before they run.
    pub coder_safe_mode: AtomicBool,
    /// Active workspace's tool permission tiers + denied path prefixes,
    /// pushed by the web UI (`/api/coder/perms`) whenever the user edits
    /// them or switches workspaces. Lets `coder::enforce_perm` reject a
    /// `deny`-tiered tool or path server-side, not only in the client
    /// dispatcher that normally decides whether to call the endpoint.
    pub coder_perms: tokio::sync::RwLock<crate::coder::CoderPerms>,
    /// Per-session working directories so the agent's shell behaves like a
    /// stateful terminal (cd persists across calls within a session id).
    pub shell_sessions: tokio::sync::Mutex<HashMap<String, String>>,
    /// Optional bridge to the desktop shell. `None` when running headless.
    pub event_tx: Option<UnboundedSender<AppEvent>>,
    pub data_dir: std::path::PathBuf,
    pub dist_dir: std::path::PathBuf,
}

impl State {
    pub fn new(
        data_dir: std::path::PathBuf,
        dist_dir: std::path::PathBuf,
        event_tx: Option<UnboundedSender<AppEvent>>,
    ) -> Self {
        Self {
            config: tokio::sync::RwLock::new(AppSettings::default()),
            engine: tokio::sync::RwLock::new(EngineInner {
                state: EngineState::Stopped,
                ..Default::default()
            }),
            last_start: tokio::sync::RwLock::new(None),
            child: tokio::sync::Mutex::new(None),
            log_file: tokio::sync::Mutex::new(None),
            downloads: tokio::sync::Mutex::new(HashMap::new()),
            update_job: tokio::sync::Mutex::new(None),
            coder_safe_mode: AtomicBool::new(true),
            coder_perms: tokio::sync::RwLock::new(crate::coder::CoderPerms::default()),
            shell_sessions: tokio::sync::Mutex::new(HashMap::new()),
            event_tx,
            data_dir,
            dist_dir,
        }
    }

    /// Fire a desktop-shell event. No-op when no receiver is wired.
    pub fn emit(&self, ev: AppEvent) {
        if let Some(tx) = &self.event_tx {
            let _ = tx.send(ev);
        }
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod args_equal_tests {
    use super::*;

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
