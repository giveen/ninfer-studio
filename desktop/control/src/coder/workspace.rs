// Rust guideline compliant 2026-07-28

//! Workspace management endpoints for the coder harness: the global
//! workspace pointer (persisted to config.json) and the host directory
//! browser the UI's workspace picker uses. Deliberately not confined to the
//! workspace — these endpoints *choose* the workspace.

use super::common::is_safe_base_dir;
use crate::engine::S;
use axum::Json;
use axum::extract::{Query, State as AxumState};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;

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
    Json(WorkspaceResp {
        workspace: ws,
        exists,
    })
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
    let (ws, exists) = if !raw.is_empty() {
        let (ws_path_str, exists) = tokio::task::spawn_blocking(move || {
            let p = Path::new(&raw);
            if let Ok(canonical) = p.canonicalize() {
                let plain = crate::coder::common::canonicalize_ws_path(&raw);
                let is_dir = canonical.is_dir();
                if is_dir { (plain, true) } else { (String::new(), false) }
            } else {
                (String::new(), false)
            }
        })
        .await
        .unwrap_or((String::new(), false));
        (ws_path_str, exists)
    } else {
        (String::new(), false)
    };

    let mut config_guard = state.config.write().await;
    config_guard.coder_workspace = ws.clone();

    // Guard writes to State::data_dir (process config location)
    if is_safe_base_dir(&state.data_dir)
        && let Ok(json) = serde_json::to_string_pretty(&*config_guard)
    {
        let path = state.data_dir.join("config.json");
        let _ = crate::atomic_write_secret(&path, json).await;
    }

    Json(WorkspaceResp {
        workspace: ws,
        exists,
    })
}

/// List subdirectories of a host path so the UI can browse for a workspace
/// root. Deliberately NOT confined to the workspace (it picks the workspace).
/// Unreadable roots return exists:false rather than an error, like the sidecar.
pub async fn dirs(Query(params): Query<std::collections::HashMap<String, String>>) -> Json<Value> {
    let raw = params
        .get("root")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("~");
    // Empty or ~-prefixed roots resolve to the home directory (the picker's
    // natural start point); `root` in the response is always the RESOLVED
    // absolute path so the UI can navigate from it directly.
    let root = expand_home(raw);
    match tokio::fs::metadata(&root).await {
        Ok(m) if m.is_dir() => match tokio::fs::read_dir(&root).await {
            Ok(mut rd) => {
                let mut dirs = Vec::new();
                while let Ok(Some(e)) = rd.next_entry().await {
                    if dirs.len() >= 1000 {
                        break;
                    }
                    if let Ok(meta) = tokio::fs::metadata(e.path()).await
                        && meta.is_dir()
                    {
                        dirs.push(e.file_name().to_string_lossy().into_owned());
                    }
                }
                dirs.sort();
                Json(json!({"root": root, "exists": true, "isDir": true, "dirs": dirs}))
            }
            Err(e) => Json(
                json!({"root": root, "exists": false, "isDir": false, "dirs": [], "error": e.to_string()}),
            ),
        },
        Ok(_) => Json(json!({"root": root, "exists": true, "isDir": false, "dirs": []})),
        Err(e) => Json(
            json!({"root": root, "exists": false, "isDir": false, "dirs": [], "error": e.to_string()}),
        ),
    }
}

/// Expand an empty or ~-prefixed path to the user's home directory.
fn expand_home(p: &str) -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".to_string());
    let home = home.trim_end_matches('/').trim_end_matches('\\');
    if p.is_empty() || p == "~" {
        return home.to_string();
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        format!("{home}/{rest}")
    } else {
        p.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_home_normalization() {
        unsafe {
            std::env::set_var("HOME", "/Users/testuser");
        }
        assert_eq!(expand_home("~"), "/Users/testuser");
        assert_eq!(expand_home("~/code"), "/Users/testuser/code");
        assert_eq!(expand_home("~\\code"), "/Users/testuser/code");
        assert_eq!(expand_home("/var/tmp"), "/var/tmp");
    }

    #[tokio::test]
    async fn workspace_set_existing_and_nonexistent_paths() {
        use axum::extract::State as AxumState;

        let tmp = std::env::temp_dir().join(format!("ninfier-ws-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("valid_ws")).unwrap();

        let state: S =
            std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        let ws = || AxumState(state.clone());

        // Valid existing path adopts cleanly
        let res1 = workspace_set(
            ws(),
            Json(WorkspaceReq {
                path: Some(tmp.join("valid_ws").to_string_lossy().into()),
            }),
        )
        .await
        .0;
        assert!(res1.exists);
        assert!(!res1.workspace.is_empty());

        // Non-existent path is rejected without creating host directories
        let non_existent = tmp.join("does_not_exist/sub");
        let res2 = workspace_set(
            ws(),
            Json(WorkspaceReq {
                path: Some(non_existent.to_string_lossy().into()),
            }),
        )
        .await
        .0;
        assert!(!res2.exists);
        assert_eq!(res2.workspace, "");
        assert!(!non_existent.exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn dirs_symlink_traversal() {
        let tmp = std::env::temp_dir().join(format!("ninfier-symlink-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("real_dir")).unwrap();

        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(tmp.join("real_dir"), tmp.join("sym_dir"));

        let query = std::collections::HashMap::from([(
            "root".to_string(),
            tmp.to_string_lossy().to_string(),
        )]);
        let res = dirs(Query(query)).await.0;
        let dir_list = res["dirs"].as_array().unwrap();

        assert!(dir_list.iter().any(|d| d == "real_dir"));
        #[cfg(unix)]
        assert!(
            dir_list.iter().any(|d| d == "sym_dir"),
            "symlinked directory should appear in picker: {res:?}"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
