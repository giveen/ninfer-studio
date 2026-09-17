// Rust guideline compliant 2026-07-28

//! Shared coder plumbing: workspace-root + workspace-relative path
//! resolution and the per-tool permission tier enforced at every endpoint.

use crate::engine::S;
use axum::Json;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Directories never descended into by tree/walk (mirrors the sidecar).
pub(crate) const CODER_IGNORE: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    ".tox",
    "Pods",
    "out",
    ".gradle",
    ".idea",
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
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "no workspace configured"})),
        ));
    }
    let p = PathBuf::from(ws);
    Ok(p.canonicalize().unwrap_or(p))
}

/// Resolve this request's workspace root. An explicit `workspace` (request
/// body/query field) takes precedence over the single global `coderWorkspace`
/// pointer on `AppSettings`.
pub(crate) async fn resolve_ws(
    state: &S,
    override_path: Option<&str>,
) -> Result<PathBuf, (StatusCode, Json<Value>)> {
    let ws = match override_path.map(str::trim).filter(|w| !w.is_empty()) {
        Some(w) => w.to_string(),
        None => state.config.read().await.coder_workspace.clone(),
    };
    coder_root(&ws)
}

/// Normalize a relative path string into canonical lexical relative form
/// (strips `./`, resolves `..` components lexically, trims trailing slashes).
pub(crate) fn normalize_rel_path(rel: &str) -> String {
    use std::path::Component;
    let clean = rel.trim();
    if clean.is_empty() || clean == "." {
        return String::new();
    }
    let p = Path::new(clean);
    let mut comps = Vec::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                comps.pop();
            }
            Component::Normal(s) => {
                comps.push(s.to_string_lossy());
            }
            Component::RootDir | Component::Prefix(_) => {}
        }
    }
    comps.join("/")
}

/// Resolve a workspace-relative path, rejecting traversal outside the root
/// and enforcing symlink containment.
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
                    return Err((
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error": "path escapes workspace"})),
                    ));
                }
            }
            c => norm.push(c.as_os_str()),
        }
    }
    if !norm.starts_with(root) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "path escapes workspace"})),
        ));
    }
    if let Ok(canon) = norm.canonicalize() {
        let canon_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        if !canon.starts_with(&canon_root) {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "path escapes workspace via symlink"})),
            ));
        }
        Ok(canon)
    } else {
        Ok(norm)
    }
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CoderPerms {
    pub tools: std::collections::HashMap<String, PermTier>,
    pub deny_paths: Vec<String>,
}

/// How long an approval token stays valid after `perms_approve` mints it.
const APPROVAL_TTL: Duration = Duration::from_secs(60);

/// A human's one-time sign-off on a specific `ask`-tiered tool call.
#[derive(Debug)]
pub struct ApprovalTicket {
    scope: String,
    tool: String,
    rel: Option<String>,
    expires_at: Instant,
}

/// The perms bucket key a caller supplies via an optional `scope` or `workspace`
/// request field (falls back to "default").
pub(crate) fn perm_scope(req: &Value) -> String {
    req.get("scope")
        .and_then(|v| v.as_str())
        .or_else(|| req.get("workspace").and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_string()
}

/// The effective tier for `name` under `perms`. Default is `allow`.
pub(crate) fn tier_for(perms: &CoderPerms, name: &str) -> PermTier {
    if let Some(t) = perms.tools.get(name) {
        return *t;
    }
    if let Some((server, _)) = crate::mcp::split_mcp_name(name)
        && let Some(t) = perms
            .tools
            .get(&format!("{}{server}", crate::mcp::MCP_PREFIX))
    {
        return *t;
    }
    PermTier::Allow
}

/// `POST /api/coder/perms/approve` — body `{tool, path?, scope?}`.
pub async fn perms_approve(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let tool = match req.get("tool").and_then(|v| v.as_str()) {
        Some(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "tool required"})),
            ));
        }
    };
    let scope = perm_scope(&req);
    let rel = req
        .get("path")
        .and_then(|v| v.as_str())
        .map(normalize_rel_path)
        .filter(|s| !s.is_empty());
    let token = format!(
        "apr_{:x}_{}",
        crate::types::now_ms(),
        state
            .coder_approval_counter
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    );
    let now = Instant::now();
    let mut approvals = state.coder_approvals.lock().await;
    approvals.retain(|_, t| t.expires_at > now);
    approvals.insert(
        token.clone(),
        ApprovalTicket {
            scope,
            tool,
            rel,
            expires_at: now + APPROVAL_TTL,
        },
    );
    Ok(Json(json!({"token": token})))
}

/// Reject when `tool` is tiered `deny`, when it's tiered `ask` without a
/// valid matching approval token, or when `rel` sits under a denied prefix.
pub(crate) async fn enforce_perm(
    state: &S,
    scope: &str,
    tool: &str,
    rel: Option<&str>,
    approval_token: Option<&str>,
) -> Result<(), (StatusCode, Json<Value>)> {
    let all_perms = state.coder_perms.read().await;
    let perms = all_perms
        .get(scope)
        .or_else(|| all_perms.get("default"))
        .cloned()
        .unwrap_or_default();
    drop(all_perms);
    let tier = tier_for(&perms, tool);
    if tier == PermTier::Deny {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({"error": format!("'{tool}' is set to deny by workspace permissions")})),
        ));
    }
    if tier == PermTier::Ask {
        let now = Instant::now();
        let mut approvals = state.coder_approvals.lock().await;
        let norm_rel = rel.map(normalize_rel_path);
        let matches = approval_token
            .and_then(|t| approvals.get(t))
            .is_some_and(|tk| {
                tk.expires_at > now
                    && tk.scope == scope
                    && tk.tool == tool
                    && match (&tk.rel, norm_rel.as_deref()) {
                        (None, _) => true,
                        (Some(tr), Some(r)) => r == tr || r.starts_with(&format!("{tr}/")),
                        (Some(_), None) => false,
                    }
            });
        if matches {
            if let Some(t) = approval_token {
                approvals.remove(t);
            }
        } else {
            return Err((
                StatusCode::FORBIDDEN,
                Json(
                    json!({"error": format!("'{tool}' requires interactive approval (no valid approval token)")}),
                ),
            ));
        }
    }
    if let Some(rel) = rel {
        let norm_rel = normalize_rel_path(rel);
        if !norm_rel.is_empty() {
            let hit = perms.deny_paths.iter().find(|d| {
                let clean = normalize_rel_path(d);
                !clean.is_empty()
                    && (norm_rel == clean || norm_rel.starts_with(&format!("{clean}/")))
            });
            if let Some(hit) = hit {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(json!({"error": format!("path is under denied prefix \"{}\"", hit.trim())})),
                ));
            }
        }
    }
    Ok(())
}

pub async fn perms_get(
    AxumState(state): AxumState<S>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<Value> {
    let scope = q
        .get("scope")
        .or_else(|| q.get("workspace"))
        .map(String::as_str)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("default");
    let all_perms = state.coder_perms.read().await;
    Json(
        serde_json::to_value(all_perms.get(scope).cloned().unwrap_or_default())
            .unwrap_or_else(|_| json!({"tools": {}, "denyPaths": []})),
    )
}

pub async fn perms_set(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Json<Value> {
    let scope = perm_scope(&req);
    let mut all_perms = state.coder_perms.write().await;
    let mut entry = all_perms.get(&scope).cloned().unwrap_or_default();
    if let Some(tools_val) = req.get("tools")
        && let Ok(tools) =
            serde_json::from_value::<std::collections::HashMap<String, PermTier>>(tools_val.clone())
    {
        entry.tools.extend(tools);
    }
    if let Some(paths_val) = req.get("denyPaths").or_else(|| req.get("deny_paths"))
        && let Ok(paths) = serde_json::from_value::<Vec<String>>(paths_val.clone())
    {
        entry.deny_paths = paths;
    }
    all_perms.insert(scope.clone(), entry.clone());
    Json(
        serde_json::to_value(entry)
            .unwrap_or_else(|_| json!({"tools": {}, "denyPaths": []})),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_rel_path() {
        assert_eq!(normalize_rel_path("secret/x"), "secret/x");
        assert_eq!(normalize_rel_path("./secret/x"), "secret/x");
        assert_eq!(normalize_rel_path("a/../secret/x"), "secret/x");
        assert_eq!(normalize_rel_path("secret/"), "secret");
        assert_eq!(normalize_rel_path("."), "");
    }

    #[test]
    fn test_within_ws_lexical_containment() {
        let root = Path::new("/tmp/workspace");
        assert!(within_ws(root, "src/main.rs").is_ok());
        assert!(within_ws(root, "./src/main.rs").is_ok());
        assert!(within_ws(root, "a/../src/main.rs").is_ok());
        assert!(within_ws(root, "../secret").is_err());
    }
}
