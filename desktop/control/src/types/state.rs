//! Control-plane runtime state + desktop-shell events.
use super::domain::{EngineState, JobRec};
use super::settings::{AppSettings, EngineProfile};
use parking_lot::Mutex as ParkingMutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
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
    pub spawn_epoch: u64,
}

impl EngineInner {
    /// Common tail of every stop path: no process is running and Studio owns
    /// nothing. Clears state, pid, adopted status, fail_reason, deadline, and argv.
    pub fn reset_stopped(&mut self) {
        self.state = EngineState::Stopped;
        self.adopted = false;
        self.pid = None;
        self.fail_reason = None;
        self.deadline = None;
        self.argv = None;
    }

    /// Record a failure with its reason and clear PID so stale process IDs are not signaled.
    /// Callers that also notify the desktop shell use `engine::fail_and_emit` instead.
    pub fn mark_failed(&mut self, reason: impl Into<String>) {
        self.state = EngineState::Failed;
        self.fail_reason = Some(reason.into());
        self.pid = None;
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
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
    /// Tool permission tiers + denied path prefixes, keyed by an opaque
    /// `scope` string each caller supplies (Coder sends its active
    /// workspace root; Chat's Computer Use sends its own directory) so two
    /// independent callers never clobber each other's tiers through the one
    /// shared control plane. Pushed by the web UI (`/api/coder/perms`)
    /// whenever the user edits a scope's tiers or switches workspaces. Lets
    /// `coder::enforce_perm` reject a `deny`-tiered tool or path server-side,
    /// not only in the client dispatcher that normally decides whether to
    /// call the endpoint.
    pub coder_perms: tokio::sync::RwLock<HashMap<String, crate::coder::CoderPerms>>,
    /// Short-lived, single-use approval tickets for `ask`-tiered tools,
    /// minted by `/api/coder/perms/approve` the moment a human approves the
    /// UI's dialog. `enforce_perm` requires a valid matching one for an
    /// `ask`-tiered call — without this an `ask` tier had no server-side
    /// meaning at all (anything that could reach the endpoint directly was
    /// treated as `allow`, bypassing the approval dialog entirely).
    pub coder_approvals: tokio::sync::Mutex<HashMap<String, crate::coder::ApprovalTicket>>,
    /// Monotonic counter backing approval-token ids, mirrors `bg_job_counter`.
    pub coder_approval_counter: AtomicU64,
    /// Live MCP client connections, keyed by server name (see `mcp.rs`).
    pub mcp: tokio::sync::RwLock<crate::mcp::McpManager>,
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
    /// this lives on `State` instead of a global static. Uses `parking_lot::Mutex`
    /// to avoid mutex poisoning.
    pub memory_locks: ParkingMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Cached repo symbol index for `coder::search` (TTL'd, keyed by the root
    /// it was built from so a workspace switch can't serve another
    /// workspace's stale index). See `bg_jobs` for why this lives on `State`.
    /// Uses `parking_lot::Mutex` to avoid mutex poisoning.
    pub symbol_index: ParkingMutex<
        Option<(
            std::time::Instant,
            std::path::PathBuf,
            std::sync::Arc<Vec<crate::coder::SymHit>>,
        )>,
    >,
    /// Optional bridge to the desktop shell. `None` when running headless.
    pub event_tx: Option<UnboundedSender<AppEvent>>,
    pub data_dir: std::path::PathBuf,
    pub dist_dir: std::path::PathBuf,
    /// Live task for the Remote Access listener (`remote::start`/`stop`).
    /// `None` when off; the persisted `remote_access_enabled`/`_port` in
    /// `config` describe the desired state, this is the actual running one.
    pub remote: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Server-side agent runs (the loop that used to live in the webview).
    /// Runs keep going while no client is attached; a client attaches via
    /// `GET /api/agent/runs/{id}/events` (SSE) and never owns the loop.
    /// See `crate::agent::run` for the registry and `crate::agent` for the
    /// architecture notes.
    pub agent_runs: crate::agent::run::RunRegistry,
}

impl State {
    pub fn new(
        data_dir: std::path::PathBuf,
        dist_dir: std::path::PathBuf,
        event_tx: Option<UnboundedSender<AppEvent>>,
    ) -> Self {
        Self {
            config: tokio::sync::RwLock::new(AppSettings::default()),
            engine: tokio::sync::RwLock::new(EngineInner::default()),
            last_start: tokio::sync::RwLock::new(None),
            child: tokio::sync::Mutex::new(None),
            log_file: tokio::sync::Mutex::new(None),
            downloads: tokio::sync::Mutex::new(HashMap::new()),
            update_job: tokio::sync::Mutex::new(None),
            coder_perms: tokio::sync::RwLock::new(HashMap::new()),
            coder_approvals: tokio::sync::Mutex::new(HashMap::new()),
            coder_approval_counter: AtomicU64::new(0),
            mcp: tokio::sync::RwLock::new(crate::mcp::McpManager::default()),
            shell_sessions: tokio::sync::Mutex::new(HashMap::new()),
            browser: tokio::sync::Mutex::new(crate::coder::BrowserSlot::new()),
            bg_jobs: tokio::sync::Mutex::new(HashMap::new()),
            bg_job_counter: AtomicU64::new(0),
            memory_locks: ParkingMutex::new(HashMap::new()),
            symbol_index: ParkingMutex::new(None),
            event_tx,
            data_dir,
            dist_dir,
            remote: tokio::sync::Mutex::new(None),
            agent_runs: crate::agent::run::RunRegistry::default(),
        }
    }

    /// Fire a desktop-shell event. No-op when no receiver is wired.
    pub fn emit(&self, ev: AppEvent) {
        if let Some(tx) = &self.event_tx {
            let _ = tx.send(ev);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mark_failed_clears_pid_and_sets_reason() {
        let mut eng = EngineInner {
            pid: Some(1234),
            state: EngineState::Running,
            ..EngineInner::default()
        };
        eng.mark_failed("oom error");
        assert_eq!(eng.state, EngineState::Failed);
        assert_eq!(eng.pid, None);
        assert_eq!(eng.fail_reason.as_deref(), Some("oom error"));
    }

    #[test]
    fn reset_stopped_clears_transient_fields() {
        let mut eng = EngineInner {
            state: EngineState::Failed,
            pid: Some(5678),
            adopted: true,
            fail_reason: Some("bad state".into()),
            deadline: Some(999999),
            argv: Some(vec!["ninfer-serve".into()]),
            ..EngineInner::default()
        };
        eng.reset_stopped();
        assert_eq!(eng.state, EngineState::Stopped);
        assert_eq!(eng.pid, None);
        assert!(!eng.adopted);
        assert_eq!(eng.fail_reason, None);
        assert_eq!(eng.deadline, None);
        assert_eq!(eng.argv, None);
    }

    #[test]
    fn saved_profile_deserialization_defaults() {
        let json = r#"{"name": "test"}"#;
        let profile: SavedProfile = serde_json::from_str(json).unwrap();
        assert_eq!(profile.name, "test");
    }
}

