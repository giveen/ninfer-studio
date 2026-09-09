
use axum::{
    extract::{Query, State as AxumState},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::fs;
use tokio::process::Command;
use tokio::time::timeout;
use crate::engine::S;

#[derive(Serialize)]
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

#[derive(Deserialize)]
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
        ws = ws_path.to_string_lossy().into_owned();
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

pub async fn tree(AxumState(state): AxumState<S>, Query(params): Query<std::collections::HashMap<String, String>>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = state.config.read().await.coder_workspace.clone();
    if ws.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "no workspace configured"}))));
    }
    let depth = params.get("depth").and_then(|v| v.parse::<usize>().ok()).unwrap_or(3).clamp(1, 6);
    let root = params.get("root").map(|s| s.as_str()).unwrap_or(".");
    
    // Stub implementation just returning an empty nodes list for now
    // A full implementation requires recursing and checking `CODER_IGNORE`
    Ok(Json(json!({
        "root": root,
        "nodes": []
    })))
}

pub async fn fs_read(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    // Stub
    Ok(Json(json!({"content": "", "size": 0, "truncated": false})))
}

pub async fn fs_write(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    Ok(Json(json!({"success": true})))
}

pub async fn fs_edit(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    Ok(Json(json!({"success": true})))
}

pub async fn exec(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    Ok(Json(json!({"stdout": "", "stderr": "", "exitCode": 0, "timedOut": false})))
}

pub async fn repo_map(AxumState(state): AxumState<S>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = state.config.read().await.coder_workspace.clone();
    if ws.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "no workspace configured"}))));
    }
    
    let result = tokio::task::spawn_blocking(move || {
        let mut map = String::new();
        let walker = ignore::WalkBuilder::new(&ws).hidden(false).build();
        let re = regex::Regex::new(r"^(?:\s*)(?:export\s+|pub\s+|async\s+)*(?:class|interface|type|function|const|let|var|fn|struct|enum|impl|trait)\s+([a-zA-Z0-9_]+)").unwrap();
        
        let mut file_count = 0;
        for result in walker {
            if let Ok(entry) = result {
                if entry.file_type().map_or(true, |ft| ft.is_dir()) {
                    continue;
                }
                let path = entry.path();
                // basic extension filter to avoid minified js or assets
                if let Some(ext) = path.extension() {
                    let ext_str = ext.to_string_lossy();
                    if !["ts", "tsx", "js", "jsx", "rs", "py", "go", "c", "cpp", "h", "java"].contains(&ext_str.as_ref()) {
                        continue;
                    }
                } else {
                    continue;
                }
                
                if let Ok(content) = std::fs::read_to_string(path) {
                    let rel_path = path.strip_prefix(&ws).unwrap_or(path).to_string_lossy().to_string();
                    let mut file_sigs = String::new();
                    for line in content.lines() {
                        if let Some(caps) = re.captures(line) {
                            if file_sigs.len() < 1000 {
                                file_sigs.push_str(&format!("  {}\n", line.trim()));
                            }
                        }
                    }
                    if !file_sigs.is_empty() {
                        map.push_str(&format!("{}\n{}\n", rel_path, file_sigs));
                        file_count += 1;
                        if file_count > 200 { break; } // limit to avoid massive payloads
                    }
                }
            }
        }
        if map.len() > 15000 {
            map.truncate(15000);
            map.push_str("\n... (repo map truncated)");
        }
        json!({"map": map})
    }).await.unwrap_or_else(|_| json!({"error": "task panicked"}));
    
    Ok(Json(result))
}

pub async fn grep(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = state.config.read().await.coder_workspace.clone();
    if ws.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "no workspace configured"}))));
    }
    
    let pattern = req.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
    if pattern.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "pattern required"}))));
    }
    
    let ignore_case = req.get("ignoreCase").and_then(|v| v.as_bool()).unwrap_or(false);
    
    let regex_pattern = if ignore_case {
        format!("(?i){}", pattern)
    } else {
        pattern.to_string()
    };
    
    let re = match regex::RegexBuilder::new(&regex_pattern).build() {
        Ok(r) => r,
        Err(e) => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": format!("invalid regex: {}", e)})))),
    };
    
    let max_matches = req.get("maxMatches").and_then(|v| v.as_u64()).unwrap_or(2000) as usize;
    
    let result = tokio::task::spawn_blocking(move || {
        let mut matches = Vec::new();
        let walker = ignore::WalkBuilder::new(&ws).hidden(false).build();
        
        for result in walker {
            if matches.len() >= max_matches {
                break;
            }
            
            if let Ok(entry) = result {
                if entry.file_type().map_or(true, |ft| ft.is_dir()) {
                    continue;
                }
                
                let path = entry.path();
                if let Ok(content) = std::fs::read_to_string(path) {
                    let rel_path = path.strip_prefix(&ws).unwrap_or(path).to_string_lossy().to_string();
                    
                    for (i, line) in content.lines().enumerate() {
                        if matches.len() >= max_matches {
                            break;
                        }
                        if re.is_match(line) {
                            let mut text = line.to_string();
                            if text.len() > 400 {
                                text.truncate(400);
                            }
                            matches.push(json!({
                                "file": rel_path,
                                "line": i + 1,
                                "text": text
                            }));
                        }
                    }
                }
            }
        }
        
        let truncated = matches.len() >= max_matches;
        let count = matches.len();
        
        json!({
            "matches": matches,
            "truncated": truncated,
            "count": count
        })
    }).await.unwrap_or_else(|_| json!({"error": "task panicked"}));
    
    Ok(Json(result))
}

pub async fn glob(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    Ok(Json(json!({"files": []})))
}

pub async fn web_fetch(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    Ok(Json(json!({"content": "", "url": "", "title": ""})))
}

pub async fn web_search(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    Ok(Json(json!({"results": []})))
}
