// Rust guideline compliant 2026-07-28

//! Workspace file tools for the coder harness: directory tree, file
//! read/write/edit/patch, and base64 attachment reads — all confined to the
//! workspace root by `common::within_ws` and gated by `common::enforce_perm`.

use super::common::{coder_root, enforce_perm, rel_of, within_ws, CODER_IGNORE};
use crate::engine::S;
use axum::extract::{Query, State as AxumState};
use axum::http::StatusCode;
use axum::Json;
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::Path;

const MAX_READ_BYTES: usize = 256 * 1024;

pub async fn tree(AxumState(state): AxumState<S>, Query(params): Query<std::collections::HashMap<String, String>>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = state.config.read().await.coder_workspace.clone();
    let ws_root = coder_root(&ws)?;
    let depth = params.get("depth").and_then(|v| v.parse::<usize>().ok()).unwrap_or(3).clamp(1, 6);
    let rel = params.get("root").map(|s| s.as_str()).unwrap_or(".");
    let base = within_ws(&ws_root, rel)?;
    let root_rel = rel_of(&ws_root, &base);
    let ws_owned = ws_root.clone();
    let nodes = tokio::task::spawn_blocking(move || tree_nodes(&ws_owned, &root_rel, 1, depth))
        .await
        .unwrap_or_default();
    Ok(Json(json!({ "root": rel_of(&ws_root, &base), "nodes": nodes })))
}

/// Recursive directory listing (blocking): dirs first, then files, both by
/// name. `rel` uses forward slashes (`.` for the workspace root).
fn tree_nodes(root: &Path, rel: &str, depth: usize, max_depth: usize) -> Vec<Value> {
    if depth > max_depth {
        return Vec::new();
    }
    let dir = if rel == "." { root.to_path_buf() } else { root.join(rel) };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut items: Vec<(String, bool, Option<u64>)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if CODER_IGNORE.contains(&name.as_str()) {
                continue;
            }
            items.push((name, true, None));
        } else if ft.is_file() {
            let size = entry.metadata().map(|m| m.len()).ok();
            items.push((name, false, size));
        }
    }
    items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    items
        .into_iter()
        .map(|(name, is_dir, size)| {
            let child_rel = if rel == "." { name.clone() } else { format!("{rel}/{name}") };
            if is_dir {
                let children = if depth == max_depth {
                    None
                } else {
                    Some(tree_nodes(root, &child_rel, depth + 1, max_depth))
                };
                match children {
                    Some(c) => json!({"name": name, "path": child_rel, "kind": "dir", "children": c}),
                    None => json!({"name": name, "path": child_rel, "kind": "dir"}),
                }
            } else {
                match size {
                    Some(s) => json!({"name": name, "path": child_rel, "kind": "file", "size": s}),
                    None => json!({"name": name, "path": child_rel, "kind": "file"}),
                }
            }
        })
        .collect()
}

pub async fn fs_read(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = state.config.read().await.coder_workspace.clone();
    let ws_root = coder_root(&ws)?;
    let rel = match req.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p,
        _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "path required"})))),
    };
    enforce_perm(&state, "read", Some(rel)).await?;
    let full = within_ws(&ws_root, rel)?;
    let buf = tokio::fs::read(&full)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, Json(json!({"error": format!("file not found: {rel}")}))))?;
    if buf.iter().take(8000).any(|&b| b == 0) {
        return Ok(Json(json!({"path": rel, "binary": true, "note": "binary file — not shown"})));
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let total_lines = text.split('\n').count();
    let mut content = text;
    if req.get("offset").and_then(|v| v.as_u64()).is_some() || req.get("limit").and_then(|v| v.as_u64()).is_some() {
        let lines: Vec<&str> = content.split('\n').collect();
        let off = req.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let lim = req.get("limit").and_then(|v| v.as_u64()).unwrap_or(lines.len() as u64) as usize;
        let off = off.min(lines.len());
        let end = off.saturating_add(lim).min(lines.len());
        content = lines[off..end].join("\n");
    }
    let mut truncated = false;
    if content.len() > MAX_READ_BYTES {
        let mut cut = MAX_READ_BYTES;
        while !content.is_char_boundary(cut) {
            cut -= 1;
        }
        content.truncate(cut);
        truncated = true;
    }
    let line_count = content.split('\n').count();
    Ok(Json(json!({"path": rel, "content": content, "totalLines": total_lines, "truncated": truncated, "lineCount": line_count})))
}

pub async fn fs_write(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = state.config.read().await.coder_workspace.clone();
    let ws_root = coder_root(&ws)?;
    let rel = match req.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p,
        _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "path required"})))),
    };
    enforce_perm(&state, "write", Some(rel)).await?;
    let full = within_ws(&ws_root, rel)?;
    let content = match req.get("content").and_then(|v| v.as_str()) {
        Some(c) => c.to_string(),
        None => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "content must be a string"})))),
    };
    if let Some(parent) = full.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("mkdir failed: {e}")}))))?;
    }
    let existed = tokio::fs::metadata(&full).await.map(|m| m.is_file()).unwrap_or(false);
    tokio::fs::write(&full, &content)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("write failed: {e}")}))))?;
    Ok(Json(json!({"path": rel, "bytes": content.len(), "created": !existed})))
}

pub async fn fs_edit(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = state.config.read().await.coder_workspace.clone();
    let ws_root = coder_root(&ws)?;
    let rel = match req.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p,
        _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "path required"})))),
    };
    enforce_perm(&state, "edit", Some(rel)).await?;
    let full = within_ws(&ws_root, rel)?;
    let (old, new) = match (req.get("old").and_then(|v| v.as_str()), req.get("new").and_then(|v| v.as_str())) {
        (Some(o), Some(n)) => (o.to_string(), n.to_string()),
        _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "old and new strings required"})))),
    };
    let replace_all = req.get("replaceAll").and_then(|v| v.as_bool()).unwrap_or(false);
    let file_text = tokio::fs::read_to_string(&full)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, Json(json!({"error": format!("file not found: {rel}")}))))?;

    // Exact path first, with the same uniqueness guard as the sidecar.
    let occurrences = file_text.match_indices(&old).count();
    let (replaced, count) = if occurrences > 0 {
        if !replace_all && occurrences > 1 {
            return Ok(Json(json!({"path": rel, "replacements": 0, "error": "old_string is not unique — pass replaceAll:true to replace all"})));
        }
        let count = if replace_all { occurrences } else { 1 };
        let replaced = if replace_all {
            file_text.replace(&old, &new)
        } else {
            file_text.replacen(&old, &new, 1)
        };
        (replaced, count)
    } else {
        // Whitespace-agnostic fallback: slide a trimmed-line window over the file.
        let old_lines: Vec<&str> = {
            let mut v: Vec<&str> = old.split('\n').collect();
            while v.first().is_some_and(|l| l.trim().is_empty()) {
                v.remove(0);
            }
            while v.last().is_some_and(|l| l.trim().is_empty()) {
                v.pop();
            }
            v
        };
        if old_lines.is_empty() {
            return Ok(Json(json!({"path": rel, "replacements": 0, "error": "old_string is empty or only whitespace"})));
        }
        let file_lines: Vec<&str> = file_text.split('\n').collect();
        let is_match_at = |i: usize| {
            file_lines.len() - i >= old_lines.len()
                && old_lines.iter().enumerate().all(|(j, o)| file_lines[i + j].trim() == o.trim())
        };
        let hits: Vec<usize> = (0..=file_lines.len().saturating_sub(old_lines.len()))
            .filter(|&i| is_match_at(i))
            .collect();
        if hits.is_empty() {
            return Ok(Json(json!({"path": rel, "replacements": 0, "error": "old_string not found (even with fuzzy whitespace matching)"})));
        }
        if hits.len() > 1 && !replace_all {
            return Ok(Json(json!({"path": rel, "replacements": 0, "error": "old_string matched multiple locations fuzzily — make it more specific or pass replaceAll:true"})));
        }
        let mut out: Vec<String> = file_lines.iter().map(|s| s.to_string()).collect();
        // Splice back-to-front so earlier indices stay valid.
        let targets: Vec<usize> = if replace_all { hits.clone() } else { vec![hits[0]] };
        for &i in targets.iter().rev() {
            out.splice(i..i + old_lines.len(), [new.clone()]);
        }
        (out.join("\n"), targets.len())
    };

    tokio::fs::write(&full, &replaced)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("write failed: {e}")}))))?;
    Ok(Json(json!({"path": rel, "replacements": count})))
}
/// Apply one old→new replacement: exact match first (with the uniqueness
/// guard), then a whitespace-agnostic line-window fallback. Pure helper for
/// atomic multi-hunk patches — every hunk must match or nothing is written.
fn apply_edit_hunk(file_text: &str, old: &str, new: &str, replace_all: bool) -> Result<(String, usize), String> {
    let occurrences = file_text.match_indices(old).count();
    if occurrences > 0 {
        if !replace_all && occurrences > 1 {
            return Err("old_string is not unique — pass replaceAll:true to replace all".into());
        }
        let count = if replace_all { occurrences } else { 1 };
        let replaced = if replace_all {
            file_text.replace(old, new)
        } else {
            file_text.replacen(old, new, 1)
        };
        return Ok((replaced, count));
    }
    let mut old_lines: Vec<&str> = old.split('\n').collect();
    while old_lines.first().is_some_and(|l| l.trim().is_empty()) {
        old_lines.remove(0);
    }
    while old_lines.last().is_some_and(|l| l.trim().is_empty()) {
        old_lines.pop();
    }
    if old_lines.is_empty() {
        return Err("old_string is empty or only whitespace".into());
    }
    let file_lines: Vec<&str> = file_text.split('\n').collect();
    let is_match_at = |i: usize| {
        file_lines.len() - i >= old_lines.len()
            && old_lines.iter().enumerate().all(|(j, o)| file_lines[i + j].trim() == o.trim())
    };
    let hits: Vec<usize> = (0..=file_lines.len().saturating_sub(old_lines.len()))
        .filter(|&i| is_match_at(i))
        .collect();
    if hits.is_empty() {
        return Err("old_string not found (even with fuzzy whitespace matching)".into());
    }
    if hits.len() > 1 && !replace_all {
        return Err("old_string matched multiple locations fuzzily — make it more specific or pass replaceAll:true".into());
    }
    let mut out: Vec<String> = file_lines.iter().map(|s| s.to_string()).collect();
    let targets: Vec<usize> = if replace_all { hits } else { vec![hits[0]] };
    let count = targets.len();
    for &i in targets.iter().rev() {
        out.splice(i..i + old_lines.len(), [new.to_string()]);
    }
    Ok((out.join("\n"), count))
}

pub async fn fs_patch(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = state.config.read().await.coder_workspace.clone();
    let ws_root = coder_root(&ws)?;
    let rel = match req.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p,
        _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "path required"})))),
    };
    enforce_perm(&state, "apply_patch", Some(rel)).await?;
    let full = within_ws(&ws_root, rel)?;
    let hunks = match req.get("edits").and_then(|v| v.as_array()) {
        Some(h) if !h.is_empty() => h.clone(),
        _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "edits must be a non-empty array of {old, new}"})))),
    };
    let mut validated: Vec<(String, String, bool)> = Vec::with_capacity(hunks.len());
    for (i, h) in hunks.iter().enumerate() {
        match (h.get("old").and_then(|v| v.as_str()), h.get("new").and_then(|v| v.as_str())) {
            (Some(o), Some(n)) => validated.push((
                o.to_string(),
                n.to_string(),
                h.get("replaceAll").and_then(|v| v.as_bool()).unwrap_or(false),
            )),
            _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": format!("edits[{i}].old and edits[{i}].new strings required")})))),
        }
    }
    let file_text = tokio::fs::read_to_string(&full)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, Json(json!({"error": format!("file not found: {rel}")}))))?;
    // All-or-nothing: every hunk applies against the evolving text first.
    let mut working = file_text;
    let mut total = 0usize;
    for (i, (old, new, replace_all)) in validated.iter().enumerate() {
        match apply_edit_hunk(&working, old, new, *replace_all) {
            Ok((t, c)) => {
                working = t;
                total += c;
            }
            Err(e) => return Ok(Json(json!({"path": rel, "replacements": 0, "error": format!("hunk {i}: {e}")}))),
        }
    }
    tokio::fs::write(&full, &working)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("write failed: {e}")}))))?;
    Ok(Json(json!({"path": rel, "replacements": total})))
}

/// Base64 file read for image/file attachments (mirrors `/api/coder/fs/b64`).
pub async fn fs_b64(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    const MAX_ATTACH_BYTES: usize = 50 * 1024 * 1024;
    let ws = state.config.read().await.coder_workspace.clone();
    let ws_root = coder_root(&ws)?;
    let rel = match req.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p,
        _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "path required"})))),
    };
    let full = within_ws(&ws_root, rel)?;
    let buf = tokio::fs::read(&full)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, Json(json!({"error": format!("file not found: {rel}")}))))?;
    if buf.len() > MAX_ATTACH_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, Json(json!({"error": format!("file is {} bytes; attachment limit is 50 MB", buf.len())}))));
    }
    let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    // `base64` 0.22 engine: STANDARD alphabet with padding, like Node's toString('base64').
    let data_url = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&buf));
    Ok(Json(json!({"path": rel, "mime": mime, "dataUrl": data_url, "size": buf.len()})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_hunks_apply_in_sequence() {
        let (t, c) = apply_edit_hunk("a=1\nb=2\n", "a=1", "a=10", false).unwrap();
        assert_eq!(c, 1);
        let (t, c) = apply_edit_hunk(&t, "b=2", "b=20", false).unwrap();
        assert_eq!(t, "a=10\nb=20\n");
        assert_eq!(c, 1);
    }

    #[test]
    fn patch_hunk_failure_reports_index() {
        // The handler validates every hunk before writing: a late miss aborts
        // the whole patch with the failing hunk's index.
        let hunks = [("x=1", "x=2", false), ("missing", "y", false)];
        let mut working = "x=1\n".to_string();
        let mut err = None;
        for (i, (o, n, ra)) in hunks.iter().enumerate() {
            match apply_edit_hunk(&working, o, n, *ra) {
                Ok((t, _)) => working = t,
                Err(e) => {
                    err = Some(format!("hunk {i}: {e}"));
                    break;
                }
            }
        }
        assert!(err.unwrap().starts_with("hunk 1:"));
    }

    #[test]
    fn patch_fuzzy_and_replace_all() {
        // Exact substring match wins over fuzzy (surrounding whitespace kept).
        let (t, c) = apply_edit_hunk("  indented  \n", "indented", "flat", false).unwrap();
        assert_eq!(t, "  flat  \n");
        assert_eq!(c, 1);
        let (t, c) = apply_edit_hunk("a a a", "a", "b", true).unwrap();
        assert_eq!(t, "b b b");
        assert_eq!(c, 3);
    }
}
