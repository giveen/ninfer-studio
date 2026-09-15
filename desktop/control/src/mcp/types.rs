//! MCP shared types: connection metadata, actor protocol, manager handle.
//!
//! Leaf module — no sibling deps. Everything the actor, transport, naming,
//! and routes share lives here so the dependency direction stays one-way:
//! `types <- naming <- transport <- actor <- routes`.

use crate::types::McpServerSpec;
use rmcp::model::ClientInfo;
use rmcp::service::RunningService;
use rmcp::RoleClient;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use parking_lot::Mutex;
use tokio::sync::mpsc::UnboundedSender;

/// A live MCP session (rmcp's running client service). `!Send` — it lives
/// on the actor thread only (see `actor_entry`/`dispatcher`).
pub(crate) type McpService = RunningService<RoleClient, ClientInfo>;

/// `mcp__<server>__<tool>` — the prefix every MCP-exposed tool name carries.
pub(crate) const MCP_PREFIX: &str = "mcp__";

/// Connecting + initializing + first `tools/list` must finish in this long,
/// or the server is treated as unreachable (covers hung `npx` installs).
pub(crate) const INIT_TIMEOUT: Duration = Duration::from_secs(60);

/// A single `tools/call` is bounded — some MCP tools legitimately run for
/// minutes (long web scrapes, migrations), but an unbounded hang must not
/// wedge the agent loop forever.
pub(crate) const CALL_TIMEOUT: Duration = Duration::from_secs(600);

/// How long a cached `tools/list` stays fresh before the next catalog/
/// refresh re-asks the server.
pub(crate) const TOOLS_TTL: Duration = Duration::from_secs(120);

/// Cap on the rendered tool output handed back to the agent loop (mirrors
/// the observation-packing discipline the other tools already follow).
pub(crate) const MAX_TOOL_OUTPUT: usize = 64 * 1024;

/// `tools/list` is 30s inside the actor; the handler-side reply ceiling
/// adds slack so a slow-but-live server gets marked dead (and is retried
/// through a fresh connection) instead of wedging the catalog forever.
pub(crate) const LIST_TOOLS_LIMIT: Duration = Duration::from_secs(35);

/// One MCP server tool in its LLM-facing namespaced form.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    /// `mcp__<server>__<tool>` — what the model calls.
    pub mangled: String,
    /// The server's own tool name — what we send it.
    pub original: String,
    pub description: String,
    /// The tool's JSON-schema `inputSchema`.
    pub parameters: Value,
}

/// Plain (Send) connection metadata — everything the UI and the agent loop
/// need that does NOT require a round trip to the actor thread.
#[derive(Debug, Clone, Default)]
pub(crate) struct ConnMeta {
    /// Peer's `serverInfo` (name/version), for the UI.
    pub peer: Option<Value>,
    /// Child-process pid for stdio servers (for the UI).
    pub pid: Option<u32>,
    /// Last connection error; `None` while alive.
    pub error: Option<String>,
    /// Last known tool catalog (namespaced).
    pub tools: Vec<ToolDef>,
    /// When `tools` was last refreshed.
    pub tools_at: Option<Instant>,
    /// When `error` was last recorded — gates the implicit-reconnect
    /// backoff (`failed_recently`) so a broken server doesn't stall every
    /// catalog fetch or tool call with the full init timeout.
    pub error_at: Option<Instant>,
    /// Whether the session is believed live (set by connect; cleared when a
    /// round trip reveals the transport died).
    pub alive: bool,
}

/// Commands for the MCP actor. Everything is `Send` — these cross from the
/// axum worker threads into the actor's dedicated driver thread.
#[derive(Debug)]
pub(crate) enum McpCmd {
    /// (Re)connect: drop any existing session for `server`, open the new
    /// one, and return its `tools/list`.
    Connect { server: String, spec: McpServerSpec },
    /// Re-ask a live session for `tools/list` (catalog refresh).
    ListTools { server: String },
    /// Invoke one tool on a live session.
    CallTool {
        server: String,
        /// The server's own tool name (not the mangled one).
        tool: String,
        arguments: serde_json::Map<String, Value>,
    },
    /// Drop the session (server deleted).
    Close { server: String },
}

/// Replies for the MCP actor — one per command, all `Send`.
#[derive(Debug)]
pub(crate) enum McpReply {
    Connect {
        error: Option<String>,
        peer: Option<Value>,
        pid: Option<u32>,
        tools: Vec<ToolDef>,
    },
    ListTools {
        error: Option<String>,
        tools: Vec<ToolDef>,
    },
    /// `transport_dead` tells the caller the session is gone: drop the
    /// metadata and retry once through a fresh connection.
    Call {
        ok: bool,
        output: String,
        transport_dead: bool,
    },
    Close,
}

pub(crate) type ActorTx = UnboundedSender<(McpCmd, UnboundedSender<McpReply>)>;

/// `Send+Sync` handle for the MCP actor. Lives on `State` (behind the
/// tokio `RwLock` like the other manager fields); the `!Send` sessions
/// themselves never leave the actor thread.
///
/// The driver thread is spawned lazily on the first route hit (mirrors
/// `BrowserSlot::spawn_driver`) so `State::new` — and the unit tests — stay
/// cheap.
#[derive(Default)]
pub struct McpManager {
    tx: Mutex<Option<ActorTx>>,
    started: AtomicBool,
    meta: Mutex<HashMap<String, ConnMeta>>,
}

impl fmt::Debug for McpManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let keys: Vec<String> = self.meta.lock().keys().cloned().collect();
        f.debug_struct("McpManager")
            .field("running", &self.started.load(Ordering::Relaxed))
            .field("servers", &keys)
            .finish()
    }
}

impl McpManager {
    /// The actor command channel, spawning the driver thread on first use.
    /// The `tx` mutex is held across the spawn, so a racing second caller
    /// always sees the finished state.
    pub(crate) fn channel(&self) -> Option<ActorTx> {
        let mut guard = self.tx.lock();
        if guard.is_none() {
            if self.started.swap(true, Ordering::SeqCst) {
                return guard.clone();
            }
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            if std::thread::Builder::new()
                .name("mcp-actor".into())
                .spawn(move || super::actor_entry(rx))
                .is_ok()
            {
                *guard = Some(tx);
            } else {
                self.started.store(false, Ordering::SeqCst);
                return None;
            }
        }
        guard.clone()
    }

    /// The actor is gone (its command channel closed) — forget the dead
    /// sender so the next `channel()` call respawns a fresh actor.
    pub(crate) fn reset(&self) {
        self.started.store(false, Ordering::SeqCst);
        *self.tx.lock() = None;
    }

    pub(crate) fn meta_get(&self, name: &str) -> Option<ConnMeta> {
        self.meta.lock().get(name).cloned()
    }

    pub(crate) fn meta_set(&self, name: &str, meta: ConnMeta) {
        self.meta.lock().insert(name.to_string(), meta);
    }

    pub(crate) fn meta_remove(&self, name: &str) {
        self.meta.lock().remove(name);
    }
}
