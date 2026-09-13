//! Control-plane runtime state + desktop-shell events.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;
use super::domain::{EngineState, JobRec};
use super::settings::{AppSettings, EngineProfile};

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
    pub downloads: tokio::sync::Mutex<HashMap<String, JobRec>>,
    pub update_job: tokio::sync::Mutex<Option<JobRec>>,
    /// Coder "safe mode" (mirrors the sidecar's `coderSafeMode`): when true,
    /// clearly destructive shell commands are refused before they run.
    pub coder_safe_mode: AtomicBool,
    /// Active workspace's tool permission tiers + denied path prefixes,
    /// pushed by the web UI (`/api/coder/perms`) whenever the user edits
    /// them or switches workspaces. Lets `coder::enforce_perm` reject a
    /// `deny`-tiered tool or path server-side, not only in the client
    /// dispatcher that normally decides whether to call the endpoint.
    pub coder_perms: tokio::sync::RwLock<crate::coder::CoderPerms>,
    /// Short-lived, single-use approval tickets for `ask`-tiered tools,
    /// minted by `/api/coder/perms/approve` the moment a human approves the
    /// UI's dialog. `enforce_perm` requires a valid matching one for an
    /// `ask`-tiered call — without this an `ask` tier had no server-side
    /// meaning at all (anything that could reach the endpoint directly was
    /// treated as `allow`, bypassing the approval dialog entirely).
    pub coder_approvals: tokio::sync::Mutex<HashMap<String, crate::coder::ApprovalTicket>>,
    /// Monotonic counter backing approval-token ids, mirrors `bg_job_counter`.
    pub coder_approval_counter: AtomicU64,
    /// Per-session working directories so the agent's shell behaves like a
    /// stateful terminal (cd persists across calls within a session id).
    pub shell_sessions: tokio::sync::Mutex<HashMap<String, String>>,
    /// Lazily-created headless browser session for the `browser` tool
    /// (Obscura engine). See `coder::browser` for lifecycle (idle reap).
    pub browser: tokio::sync::Mutex<crate::coder::BrowserSlot>,
    /// Registry of detached background shell jobs (`coder::exec`'s
    /// `background: true` runs) keyed by job id, so `job_get`/`job_kill` can
    /// find them. Lives on `State` rather than a module-global static so
    /// distinct `State` instances (as used throughout the test suite) never
    /// share job bookkeeping.
    pub bg_jobs: tokio::sync::Mutex<HashMap<String, Arc<crate::coder::BgJob>>>,
    /// Monotonic counter backing background-job ids (`job_<ms>_<n>`).
    pub bg_job_counter: AtomicU64,
    /// Per-memory-store mutation locks (`coder::memory`), keyed by store
    /// directory so unrelated workspaces never contend. See `bg_jobs` for why
    /// this lives on `State` instead of a global static.
    pub memory_locks: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Cached repo symbol index for `coder::search` (TTL'd, keyed by the root
    /// it was built from so a workspace switch can't serve another
    /// workspace's stale index). See `bg_jobs` for why this lives on `State`.
    pub symbol_index: std::sync::Mutex<Option<(std::time::Instant, std::path::PathBuf, Vec<crate::coder::SymHit>)>>,
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
            coder_approvals: tokio::sync::Mutex::new(HashMap::new()),
            coder_approval_counter: AtomicU64::new(0),
            shell_sessions: tokio::sync::Mutex::new(HashMap::new()),
            browser: tokio::sync::Mutex::new(crate::coder::BrowserSlot::new()),
            bg_jobs: tokio::sync::Mutex::new(HashMap::new()),
            bg_job_counter: AtomicU64::new(0),
            memory_locks: std::sync::Mutex::new(HashMap::new()),
            symbol_index: std::sync::Mutex::new(None),
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

