//! Shared types for the NInfer Studio control plane.
//! Field names mirror the web app's TypeScript types 1:1 (camelCase JSON).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc::UnboundedSender;

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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub engine_binary: String,
    pub engine_cli: String,
    pub models_dir: String,
    pub engine_port: u16,
    pub api_key: String,
    pub hf_cli: String,
    pub repo_dir: String,
    pub build_command: String,
    /// JSON object merged (as defaults) into every proxied /v1 request body, so
    /// external clients (e.g. other coding harnesses) inherit these params without
    /// configuring each tool. Client-supplied fields win over these defaults.
    pub default_request_params: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            // No hardcoded paths: a distributed build must not ship a developer's
            // machine layout. The user configures these in Settings; an empty value
            // is treated as "not configured" so we can surface a clear error early
            // instead of spawning a binary that does not exist on their machine.
            engine_binary: String::new(),
            engine_cli: String::new(),
            models_dir: String::new(),
            engine_port: 8080,
            api_key: String::new(),
            hf_cli: "hf".into(),
            repo_dir: String::new(),
            build_command: "cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)".into(),
            default_request_params: String::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Engine profile — one optional entry per ninfer-serve option.
// `None` ⇒ flag omitted ⇒ engine executable default.
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
// Runtime state shapes (serialized for the UI)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineStatus {
    pub state: String,
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
    pub state: String, // stopped | starting | running | stopping | failed | external
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub artifact: Option<String>,
    pub model_id: Option<String>,
    pub argv: Option<Vec<String>>,
    pub started_at: Option<u64>,
    pub log_path: Option<String>,
    pub adopted: bool,
    pub fail_reason: Option<String>,
    pub deadline: Option<u64>, // unix ms
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

pub struct State {
    pub config: tokio::sync::RwLock<AppSettings>,
    pub engine: tokio::sync::RwLock<EngineInner>,
    pub last_start: tokio::sync::RwLock<Option<LastStart>>,
    pub child: tokio::sync::Mutex<Option<tokio::process::Child>>,
    pub log_file: tokio::sync::Mutex<Option<tokio::fs::File>>,
    pub downloads: tokio::sync::Mutex<HashMap<String, DownloadRec>>,
    pub update_job: tokio::sync::Mutex<Option<UpdateJob>>,
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
                state: "stopped".into(),
                ..Default::default()
            }),
            last_start: tokio::sync::RwLock::new(None),
            child: tokio::sync::Mutex::new(None),
            log_file: tokio::sync::Mutex::new(None),
            downloads: tokio::sync::Mutex::new(HashMap::new()),
            update_job: tokio::sync::Mutex::new(None),
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
