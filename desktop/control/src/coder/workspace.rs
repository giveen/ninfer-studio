// Rust guideline compliant 2026-07-28

//! Workspace management endpoints for the coder harness: the global
//! workspace pointer (persisted to config.json) and the host directory
//! browser the UI's workspace picker uses. Deliberately not confined to the
//! workspace — these endpoints *choose* the workspace.

use crate::engine::S;
use crate::types::strip_extended_prefix;
use axum::extract::{Query, State as AxumState};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct WorkspaceResp {
    pub workspace: String,
    pub exists: bool,
}

pub async fn workspace_get(AxumState(state): AxumState<S>) -> Json<WorkspaceResp> {
    let ws = state.config.read().await.coder_workspace.clone();
    let exists = if ws.is_empty() {
        false
    } else {
        Path::new(&ws).is_dir()
    };
    Json(WorkspaceResp { workspace: ws, exists })
}

#[derive(Debug, Deserialize)]
pub struct WorkspaceReq {
    pub path: Option<String>,
}

pub async fn workspace_set(
    AxumState(state): AxumState<S>,
    Json(req): Json<WorkspaceReq>,
) -> Json<WorkspaceResp> {
    let raw = req.path.unwrap_or_default().trim().to_string();
    let ws;
    let exists;
    if !raw.is_empty() {
        let ws_path = match std::fs::canonicalize(Path::new(&raw)) {
            Ok(p) => p,
            Err(_) => {
                if std::fs::create_dir_all(&raw).is_ok() {
                    std::fs::canonicalize(Path::new(&raw)).unwrap_or(PathBuf::from(&raw))
                } else {
                    PathBuf::from(&raw)
                }
            }
        };
        // canonicalize() on Windows returns the extended-length form
        // (`\\?\C:\...`); the UI keys workspaces by the plain picker path,
        // so strip the prefix or the store duplicates the workspace on the
        // next start.
        let plain = strip_extended_prefix(&ws_path.to_string_lossy()).to_string();
        ws = plain;
        exists = ws_path.is_dir();
    } else {
        ws = String::new();
        exists = false;
    }

    state.config.write().await.coder_workspace = ws.clone();

    let path = state.data_dir.join("config.json");
    let cfg = state.config.read().await.clone();
    if let Ok(json) = serde_json::to_string_pretty(&cfg) {
        let _ = tokio::fs::write(&path, json).await;
    }

    Json(WorkspaceResp { workspace: ws, exists })
}

/// List subdirectories of a host path so the UI can browse for a workspace
/// root. Deliberately NOT confined to the workspace (it picks the workspace).
/// Unreadable roots return exists:false rather than an error, like the sidecar.
pub async fn dirs(Query(params): Query<std::collections::HashMap<String, String>>) -> Json<Value> {
    let raw = params.get("root").map(|s| s.trim()).filter(|s| !s.is_empty()).unwrap_or("~");
    // Empty or ~-prefixed roots resolve to the home directory (the picker's
    // natural start point); `root` in the response is always the RESOLVED
    // absolute path so the UI can navigate from it directly.
    let root = expand_home(raw);
    match tokio::fs::metadata(&root).await {
        Ok(m) if m.is_dir() => match tokio::fs::read_dir(&root).await {
            Ok(mut rd) => {
                let mut dirs = Vec::new();
                while let Ok(Some(e)) = rd.next_entry().await {
                    if let Ok(ft) = e.file_type().await {
                        if ft.is_dir() {
                            dirs.push(e.file_name().to_string_lossy().into_owned());
                        }
                    }
                }
                dirs.sort();
                Json(json!({"root": root, "exists": true, "isDir": true, "dirs": dirs}))
            },
            Err(e) => Json(json!({"root": root, "exists": false, "isDir": false, "dirs": [], "error": e.to_string()})),
        },
        Ok(_) => Json(json!({"root": root, "exists": true, "isDir": false, "dirs": []})),
        Err(e) => Json(json!({"root": root, "exists": false, "isDir": false, "dirs": [], "error": e.to_string()})),
    }
}

/// Expand an empty or ~-prefixed path to the user's home directory.
fn expand_home(p: &str) -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".to_string());
    let home = home.trim_end_matches('/');
    if p.is_empty() || p == "~" {
        return home.to_string();
    }
    match p.strip_prefix("~/") {
        Some(rest) => format!("{home}/{rest}"),
        None => p.to_string(),
    }
}
