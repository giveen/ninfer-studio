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

/// Directories never descended into by tree/walk (mirrors the sidecar).
pub(crate) const CODER_IGNORE: &[&str] = &[
    "node_modules", ".git", "target", "dist", "build", ".next", ".turbo", ".cache", "vendor",
    "__pycache__", ".venv", "venv",
];

/// Canonical workspace root, or a 400 when none is configured.
pub(crate) fn coder_root(ws: &str) -> Result<PathBuf, (StatusCode, Json<Value>)> {
    if ws.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "no workspace configured"}))));
    }
    let p = PathBuf::from(ws);
    Ok(p.canonicalize().unwrap_or(p))
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
/// at the endpoint itself so that bypass doesn't work. `ask` has no
/// server-side meaning — it means "pause and prompt a human", which only
/// the client can do — so it stays a client-only tier here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CoderPerms {
    pub tools: std::collections::HashMap<String, PermTier>,
    pub deny_paths: Vec<String>,
}

/// Reject when `tool` is tiered `deny`, or when `rel` (a workspace-relative
/// path, for tools that take one) sits under a denied prefix. Mirrors the
/// frontend's `checkPerm`: exact match or `rel` starting with `"<prefix>/"`.
pub(crate) async fn enforce_perm(state: &S, tool: &str, rel: Option<&str>) -> Result<(), (StatusCode, Json<Value>)> {
    let perms = state.coder_perms.read().await;
    if perms.tools.get(tool) == Some(&PermTier::Deny) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({"error": format!("'{tool}' is set to deny by workspace permissions")})),
        ));
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
