// Rust guideline compliant 2026-07-28

//! Shared coder plumbing: workspace-root + workspace-relative path
//! resolution and the per-tool permission tier enforced at every endpoint.

use crate::engine::S;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Directories never descended into by tree/walk (mirrors the sidecar).
pub(crate) const CODER_IGNORE: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", ".next", ".turbo", ".cache", "vendor",
    "__pycache__", ".venv", "venv",
];

/// Whether `base` is safe to use as a config-write directory: absolute and
/// free of `..` components. Guards writes to `State::data_dir`, which is
/// process config (env var or default), not per-request input, but CodeQL
/// flags it as tainted since it can be set outside the app.
pub(crate) fn is_safe_base_dir(base: &Path) -> bool {
    use std::path::Component;
    base.is_absolute() && !base.components().any(|c| matches!(c, Component::ParentDir))
}

/// Canonical workspace root, or a 400 when none is configured.
pub(crate) fn coder_root(ws: &str) -> Result<PathBuf, (StatusCode, Json<Value>)> {
    if ws.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "no workspace configured"}))));
    }
    let p = PathBuf::from(ws);
    Ok(p.canonicalize().unwrap_or(p))
}

/// Resolve this request's workspace root. An explicit `workspace` (request
/// body/query field) takes precedence over the single global `coderWorkspace`
/// pointer on `AppSettings` — every coder tool call that reads/writes files or
/// runs a shell was previously confined to whatever repo the backend happened
/// to be pointed at, with no way for a specific conversation to address its
/// own workspace independent of what another tab/conversation last set. A
/// caller that already knows its target (the UI always does — each open
/// conversation tracks its own workspace dir) should pass it explicitly;
/// omitting it preserves the old fallback-to-global behavior for any caller
/// not yet updated. Mirrors `memory.rs`'s `resolve_mem_dir`, which already
/// used this pattern for the self-improving memory store.
pub(crate) async fn resolve_ws(state: &S, override_path: Option<&str>) -> Result<PathBuf, (StatusCode, Json<Value>)> {
    let ws = match override_path.map(str::trim).filter(|w| !w.is_empty()) {
        Some(w) => w.to_string(),
        None => state.config.read().await.coder_workspace.clone(),
    };
    coder_root(&ws)
}

/// Resolve a workspace-relative path, rejecting traversal outside the root.
/// Purely lexical (mirrors the sidecar's `path.resolve` + `path.relative`
/// check): works for not-yet-created paths, and an absolute `rel` replaces
/// the root before the containment check rejects it.
pub(crate) fn within_ws(root: &Path, rel: &str) -> Result<PathBuf, (StatusCode, Json<Value>)> {
    use std::path::Component;
    let rel = rel.trim();
    let joined = if rel.is_empty() || rel == "." {
        root.to_path_buf()
    } else {
        let p = Path::new(rel);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            root.join(p)
        }
    };
    let mut norm = PathBuf::new();
    for comp in joined.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if !norm.pop() {
                    return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "path escapes workspace"}))));
                }
            }
            c => norm.push(c.as_os_str()),
        }
    }
    if !norm.starts_with(root) {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "path escapes workspace"}))));
    }
    Ok(joined)
}

/// Display path of `p` relative to the workspace root (`.` for the root).
pub(crate) fn rel_of(root: &Path, p: &Path) -> String {
    match p.strip_prefix(root) {
        Ok(r) if r.as_os_str().is_empty() => ".".to_string(),
        Ok(r) => r.to_string_lossy().into_owned(),
        Err(_) => p.to_string_lossy().into_owned(),
    }
}

/// Per-tool permission tier — mirrors the web UI's `PermTier`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermTier {
    Allow,
    Ask,
    Deny,
}

/// The active workspace's tool permissions, pushed here by the web UI
/// (`perms_set`) whenever the user edits them or switches workspaces.
///
/// The UI is normally what decides whether to call a coder endpoint at all
/// — but that's a client-side dispatcher the agent can route around (e.g.
/// its allowed `bash` tool can `curl` straight at an endpoint whose own
/// tool tier is `deny`). `enforce_perm` re-checks `deny` and `denyPaths`
/// at the endpoint itself so that bypass doesn't work. `ask` means "pause
/// and prompt a human", which only the client's own dialog can actually do
/// — but the endpoint itself still requires proof that dialog ran and was
/// approved: a short-lived, single-use token minted by `perms_approve` the
/// moment the human clicks Approve (see `ApprovalTicket`). Without this, a
/// caller that skipped the dialog entirely (a direct request to the
/// endpoint) was treated exactly like `allow`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CoderPerms {
    pub tools: std::collections::HashMap<String, PermTier>,
    pub deny_paths: Vec<String>,
}

/// How long an approval token stays valid after `perms_approve` mints it —
/// long enough to cover the round-trip to the actual tool call, short enough
/// that a stale token from an old, already-resolved dialog can't be reused.
const APPROVAL_TTL: Duration = Duration::from_secs(60);

/// A human's one-time sign-off on a specific `ask`-tiered tool call, scoped to
/// the tool and (when the tool takes one) the path prefix approved. Minted by
/// `perms_approve`, consumed by `enforce_perm`.
#[derive(Debug)]
pub struct ApprovalTicket {
    tool: String,
    rel: Option<String>,
    expires_at: Instant,
}

/// `POST /api/coder/perms/approve` — body `{tool, path?}`. Called by the web
/// UI's approval dialog at the moment a human clicks Approve on an
/// `ask`-tiered tool call, in addition to (not instead of) resolving that
/// dialog's own in-memory promise. Returns `{token}`, which the client then
/// attaches to the actual tool-call request as `approvalToken`.
pub async fn perms_approve(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let tool = match req.get("tool").and_then(|v| v.as_str()) {
        Some(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "tool required"})))),
    };
    let rel = req
        .get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty());
    let token = format!("apr_{:x}_{}", crate::types::now_ms(), state.coder_approval_counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
    let now = Instant::now();
    let mut approvals = state.coder_approvals.lock().await;
    approvals.retain(|_, t| t.expires_at > now); // opportunistic cleanup
    approvals.insert(token.clone(), ApprovalTicket { tool, rel, expires_at: now + APPROVAL_TTL });
    Ok(Json(json!({"token": token})))
}

/// Reject when `tool` is tiered `deny`, when it's tiered `ask` without a
/// valid matching approval token, or when `rel` (a workspace-relative path,
/// for tools that take one) sits under a denied prefix. Mirrors the
/// frontend's `checkPerm`: exact match or `rel` starting with `"<prefix>/"`.
pub(crate) async fn enforce_perm(state: &S, tool: &str, rel: Option<&str>, approval_token: Option<&str>) -> Result<(), (StatusCode, Json<Value>)> {
    let perms = state.coder_perms.read().await;
    if perms.tools.get(tool) == Some(&PermTier::Deny) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({"error": format!("'{tool}' is set to deny by workspace permissions")})),
        ));
    }
    if perms.tools.get(tool) == Some(&PermTier::Ask) {
        let now = Instant::now();
        let mut approvals = state.coder_approvals.lock().await;
        let matches = approval_token.and_then(|t| approvals.get(t)).is_some_and(|tk| {
            tk.expires_at > now
                && tk.tool == tool
                && match (&tk.rel, rel) {
                    (None, _) => true,
                    (Some(tr), Some(r)) => r == tr || r.starts_with(&format!("{tr}/")),
                    (Some(_), None) => false,
                }
        });
        if matches {
            // Single-use: an approval covers exactly the one call it was granted for.
            if let Some(t) = approval_token {
                approvals.remove(t);
            }
        } else {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({"error": format!("'{tool}' requires interactive approval (no valid approval token)")})),
            ));
        }
    }
    if let Some(rel) = rel {
        let hit = perms.deny_paths.iter().find(|d| {
            let clean = d.trim().trim_end_matches('/');
            !clean.is_empty() && (rel == clean || rel.starts_with(&format!("{clean}/")))
        });
        if let Some(hit) = hit {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({"error": format!("path is under denied prefix \"{}\"", hit.trim())})),
            ));
        }
    }
    Ok(())
}

pub async fn perms_get(AxumState(state): AxumState<S>) -> Json<Value> {
    Json(serde_json::to_value(&*state.coder_perms.read().await).unwrap_or_else(|_| json!({"tools": {}, "denyPaths": []})))
}

pub async fn perms_set(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Json<Value> {
    if let Ok(parsed) = serde_json::from_value::<CoderPerms>(req) {
        *state.coder_perms.write().await = parsed;
    }
    Json(serde_json::to_value(&*state.coder_perms.read().await).unwrap_or_else(|_| json!({"tools": {}, "denyPaths": []})))
}
