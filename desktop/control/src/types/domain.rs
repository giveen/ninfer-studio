//! Shared domain types (wire format mirrors the web TypeScript types 1:1).
use serde::{Deserialize, Serialize};

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

/// A background job the UI polls for progress: either an HF model download
/// (`models.rs`) or a `git pull` / build of the ninfer-serve source
/// (`repo.rs`). One shape serves both. `downloads_public` / `update_public`
/// serialize this struct directly (`#[serde(rename_all)]` drives the
/// camelCase wire keys) instead of hand-building a `json!{}` with its own
/// key spellings — a manually duplicated key list is exactly the drift
/// that produced the `memMib`/`memMIB` mismatch bug: a Rust-side rename
/// silently stops reaching the wire because the hand-built object never
/// gets touched. Fields specific to one site are `None` at the other and
/// serialize as `null`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRec {
    pub id: String,
    /// Update job only: "pull" | "build".
    pub action: Option<String>,
    /// Update job only: the shell command run.
    pub cmd: Option<String>,
    /// Download job only: the Hugging Face repo id.
    pub repo: Option<String>,
    /// Download job only: the file within the repo.
    pub file: Option<String>,
    /// Download job only: destination directory.
    pub local_dir: Option<String>,
    pub pid: Option<u32>,
    pub out: String,
    pub exit_code: Option<i32>,
    pub done: bool,
    pub failed: bool,
    /// Download job only: total bytes to download (from
    /// `hf download --dry-run --json`), if known.
    pub total_bytes: Option<u64>,
    /// Download job only: bytes downloaded so far, sampled from the
    /// staging blob on disk.
    pub downloaded_bytes: Option<u64>,
    /// Download job only: current throughput in bytes/sec.
    pub speed_bps: Option<f64>,
    pub started_at: u64,
}

