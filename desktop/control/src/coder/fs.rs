// Rust guideline compliant 2026-07-28

//! Workspace file tools for the coder harness: directory tree, file
//! read/write/edit/patch, and base64 attachment reads — all confined to the
//! workspace root by `common::within_ws` and gated by `common::enforce_perm`.

use super::common::{CODER_IGNORE, enforce_perm, perm_scope, rel_of, resolve_ws, within_ws};
use crate::engine::S;
use axum::Json;
use axum::extract::{Query, State as AxumState};
use axum::http::StatusCode;
use base64::Engine as _;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

const MAX_READ_BYTES: usize = 256 * 1024;

static FILE_LOCKS: LazyLock<Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn file_lock(path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let key = path.to_string_lossy().to_string();
    let mut map = FILE_LOCKS.lock().unwrap_or_else(|p| p.into_inner());
    map.entry(key)
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

pub async fn tree(
    AxumState(state): AxumState<S>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws_root = resolve_ws(&state, params.get("workspace").map(String::as_str)).await?;
    let depth = params
        .get("depth")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(3)
        .clamp(1, 6);
    let rel = params.get("root").map(|s| s.as_str()).unwrap_or(".");
    let scope = perm_scope(&json!({
        "scope": params.get("scope"),
        "workspace": params.get("workspace"),
    }));
    enforce_perm(
        &state,
        &scope,
        "read",
        Some(rel),
        params.get("approvalToken").map(String::as_str),
    )
    .await?;
    let base = within_ws(&ws_root, rel)?;
    let root_rel = rel_of(&ws_root, &base);
    let ws_owned = ws_root.clone();
    let nodes = tokio::task::spawn_blocking(move || tree_nodes(&ws_owned, &root_rel, 1, depth))
        .await
        .unwrap_or_default();
    Ok(Json(
        json!({ "root": rel_of(&ws_root, &base), "nodes": nodes }),
    ))
}

/// Recursive directory listing (blocking): dirs first, then files, both by
/// name. `rel` uses forward slashes (`.` for the workspace root). Capped at
/// 5,000 nodes total to avoid megabyte payload explosions.
fn tree_nodes(root: &Path, rel: &str, depth: usize, max_depth: usize) -> Vec<Value> {
    fn collect(
        root: &Path,
        rel: &str,
        depth: usize,
        max_depth: usize,
        count: &mut usize,
    ) -> Vec<Value> {
        if depth > max_depth || *count >= 5000 {
            return Vec::new();
        }
        let dir = if rel == "." {
            root.to_path_buf()
        } else {
            root.join(rel)
        };
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
        let mut res = Vec::new();
        for (name, is_dir, size) in items {
            if *count >= 5000 {
                break;
            }
            *count += 1;
            let child_rel = if rel == "." {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if is_dir {
                let children = if depth == max_depth || *count >= 5000 {
                    None
                } else {
                    Some(collect(root, &child_rel, depth + 1, max_depth, count))
                };
                match children {
                    Some(c) => res.push(json!({"name": name, "path": child_rel, "kind": "dir", "children": c})),
                    None => res.push(json!({"name": name, "path": child_rel, "kind": "dir"})),
                }
            } else {
                match size {
                    Some(s) => res.push(json!({"name": name, "path": child_rel, "kind": "file", "size": s})),
                    None => res.push(json!({"name": name, "path": child_rel, "kind": "file"})),
                }
            }
        }
        res
    }
    let mut count = 0;
    collect(root, rel, depth, max_depth, &mut count)
}

pub async fn fs_read(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws_root = resolve_ws(&state, req.get("workspace").and_then(|v| v.as_str())).await?;
    let rel = match req.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "path required"})),
            ));
        }
    };
    enforce_perm(
        &state,
        &perm_scope(&req),
        "read",
        Some(rel),
        req.get("approvalToken").and_then(|v| v.as_str()),
    )
    .await?;
    let full = within_ws(&ws_root, rel)?;
    let meta = tokio::fs::metadata(&full).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("file not found: {rel}")})),
        )
    })?;
    if meta.len() > 50 * 1024 * 1024 {
        return Ok(Json(
            json!({"path": rel, "binary": true, "note": "file too large — not shown"}),
        ));
    }
    use tokio::io::AsyncReadExt as _;
    let file = tokio::fs::File::open(&full).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("file not found: {rel}")})),
        )
    })?;
    let mut buf = Vec::new();
    let read_limit = (MAX_READ_BYTES + 1) as u64;
    let _ = file.take(read_limit).read_to_end(&mut buf).await;

    if buf.iter().take(8000).any(|&b| b == 0) {
        return Ok(Json(
            json!({"path": rel, "binary": true, "note": "binary file — not shown"}),
        ));
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let total_lines = text.split('\n').count();
    let mut content = text;
    if req.get("offset").and_then(|v| v.as_u64()).is_some()
        || req.get("limit").and_then(|v| v.as_u64()).is_some()
    {
        let lines: Vec<&str> = content.split('\n').collect();
        let off = req.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let lim = req
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(lines.len() as u64) as usize;
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
    Ok(Json(
        json!({"path": rel, "content": content, "totalLines": total_lines, "truncated": truncated, "lineCount": line_count}),
    ))
}

pub async fn fs_write(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws_root = resolve_ws(&state, req.get("workspace").and_then(|v| v.as_str())).await?;
    let rel = match req.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "path required"})),
            ));
        }
    };
    if rel.split(['/', '\\']).any(|p| p == ".git" || CODER_IGNORE.contains(&p)) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "writing to .git or ignored metadata paths is not allowed"})),
        ));
    }
    enforce_perm(
        &state,
        &perm_scope(&req),
        "write",
        Some(rel),
        req.get("approvalToken").and_then(|v| v.as_str()),
    )
    .await?;
    let full = within_ws(&ws_root, rel)?;
    let content = match req.get("content").and_then(|v| v.as_str()) {
        Some(c) => c.to_string(),
        None => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "content must be a string"})),
            ));
        }
    };
    let lock = file_lock(&full);
    let _guard = lock.lock().await;

    if let Some(parent) = full.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("mkdir failed: {e}")})),
            )
        })?;
    }
    let existed = tokio::fs::metadata(&full)
        .await
        .map(|m| m.is_file())
        .unwrap_or(false);
    crate::atomic_write_secret(&full, &content).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("write failed: {e}")})),
        )
    })?;
    Ok(Json(
        json!({"path": rel, "bytes": content.len(), "created": !existed}),
    ))
}

pub async fn fs_edit(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws_root = resolve_ws(&state, req.get("workspace").and_then(|v| v.as_str())).await?;
    let rel = match req.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "path required"})),
            ));
        }
    };
    if rel.split(['/', '\\']).any(|p| p == ".git" || CODER_IGNORE.contains(&p)) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "editing .git or ignored metadata paths is not allowed"})),
        ));
    }
    enforce_perm(
        &state,
        &perm_scope(&req),
        "edit",
        Some(rel),
        req.get("approvalToken").and_then(|v| v.as_str()),
    )
    .await?;
    let full = within_ws(&ws_root, rel)?;
    let (old, new) = match (
        req.get("old").and_then(|v| v.as_str()),
        req.get("new").and_then(|v| v.as_str()),
    ) {
        (Some(o), Some(n)) => (o.to_string(), n.to_string()),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "old and new strings required"})),
            ));
        }
    };
    let replace_all = req
        .get("replaceAll")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let lock = file_lock(&full);
    let _guard = lock.lock().await;

    let file_text = tokio::fs::read_to_string(&full).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("file not found: {rel}")})),
        )
    })?;

    let (replaced, count) = match apply_edit_hunk(&file_text, &old, &new, replace_all) {
        Ok(res) => res,
        Err(err) => {
            return Ok(Json(json!({
                "path": rel,
                "replacements": 0,
                "error": err,
            })));
        }
    };

    crate::atomic_write_secret(&full, &replaced).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("write failed: {e}")})),
        )
    })?;
    Ok(Json(json!({"path": rel, "replacements": count})))
}

/// Apply one old→new replacement: exact match first (with the uniqueness
/// guard), then a whitespace-agnostic line-window fallback. Pure helper for
/// atomic multi-hunk patches — every hunk must match or nothing is written.
fn apply_edit_hunk(
    file_text: &str,
    old: &str,
    new: &str,
    replace_all: bool,
) -> Result<(String, usize), String> {
    if old.trim().is_empty() {
        return Err("old_string is empty or only whitespace".into());
    }
    let is_crlf = file_text.contains("\r\n");
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
            && old_lines
                .iter()
                .enumerate()
                .all(|(j, o)| file_lines[i + j].trim() == o.trim())
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
    let line_sep = if is_crlf { "\r\n" } else { "\n" };
    for &i in targets.iter().rev() {
        out.splice(i..i + old_lines.len(), [new.to_string()]);
    }
    Ok((out.join(line_sep), count))
}

pub async fn fs_patch(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws_root = resolve_ws(&state, req.get("workspace").and_then(|v| v.as_str())).await?;
    let rel = match req.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "path required"})),
            ));
        }
    };
    if rel.split(['/', '\\']).any(|p| p == ".git" || CODER_IGNORE.contains(&p)) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "patching .git or ignored metadata paths is not allowed"})),
        ));
    }
    enforce_perm(
        &state,
        &perm_scope(&req),
        "apply_patch",
        Some(rel),
        req.get("approvalToken").and_then(|v| v.as_str()),
    )
    .await?;
    let full = within_ws(&ws_root, rel)?;
    let hunks = match req.get("edits").and_then(|v| v.as_array()) {
        Some(h) if !h.is_empty() => h.clone(),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "edits must be a non-empty array of {old, new}"})),
            ));
        }
    };
    let mut validated: Vec<(String, String, bool)> = Vec::with_capacity(hunks.len());
    for (i, h) in hunks.iter().enumerate() {
        match (
            h.get("old").and_then(|v| v.as_str()),
            h.get("new").and_then(|v| v.as_str()),
        ) {
            (Some(o), Some(n)) => validated.push((
                o.to_string(),
                n.to_string(),
                h.get("replaceAll")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            )),
            _ => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(
                        json!({"error": format!("edits[{i}].old and edits[{i}].new strings required")}),
                    ),
                ));
            }
        }
    }

    let lock = file_lock(&full);
    let _guard = lock.lock().await;

    let file_text = tokio::fs::read_to_string(&full).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("file not found: {rel}")})),
        )
    })?;
    // All-or-nothing: every hunk applies against the evolving text first.
    let mut working = file_text;
    let mut total = 0usize;
    for (i, (old, new, replace_all)) in validated.iter().enumerate() {
        match apply_edit_hunk(&working, old, new, *replace_all) {
            Ok((t, c)) => {
                working = t;
                total += c;
            }
            Err(e) => {
                return Ok(Json(
                    json!({"path": rel, "replacements": 0, "error": format!("hunk {i}: {e}")}),
                ));
            }
        }
    }
    crate::atomic_write_secret(&full, &working).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("write failed: {e}")})),
        )
    })?;
    Ok(Json(json!({"path": rel, "replacements": total})))
}

pub async fn fs_udiff(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws_root = resolve_ws(&state, req.get("workspace").and_then(|v| v.as_str())).await?;
    let rel = match req.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "path required"})),
            ));
        }
    };
    if rel.split(['/', '\\']).any(|p| p == ".git" || CODER_IGNORE.contains(&p)) {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "editing .git or ignored metadata paths is not allowed"})),
        ));
    }
    enforce_perm(
        &state,
        &perm_scope(&req),
        "udiff_edit",
        Some(rel),
        req.get("approvalToken").and_then(|v| v.as_str()),
    )
    .await?;
    let full = within_ws(&ws_root, rel)?;

    let diff = match req.get("diff").and_then(|v| v.as_str()) {
        Some(d) if !d.trim().is_empty() => d,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "diff string required"})),
            ));
        }
    };

    let lock = file_lock(&full);
    let _guard = lock.lock().await;

    let file_text = tokio::fs::read_to_string(&full).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("file not found: {rel}")})),
        )
    })?;

    let patch = diffy::Patch::from_str(diff).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("invalid unified diff format: {e}")})),
        )
    })?;

    let applied = diffy::apply(&file_text, &patch).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("failed to apply patch: {e}")})),
        )
    })?;

    crate::atomic_write_secret(&full, &applied).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("write failed: {e}")})),
        )
    })?;

    Ok(Json(json!({"path": rel, "replacements": 1})))
}

/// Base64 file read for image/file attachments (mirrors `/api/coder/fs/b64`).
pub async fn fs_b64(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    const MAX_ATTACH_BYTES: u64 = 50 * 1024 * 1024;
    let ws_root = resolve_ws(&state, req.get("workspace").and_then(|v| v.as_str())).await?;
    let rel = match req.get("path").and_then(|v| v.as_str()) {
        Some(p) if !p.trim().is_empty() => p,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "path required"})),
            ));
        }
    };
    enforce_perm(
        &state,
        &perm_scope(&req),
        "read",
        Some(rel),
        req.get("approvalToken").and_then(|v| v.as_str()),
    )
    .await?;
    let full = within_ws(&ws_root, rel)?;
    let meta = tokio::fs::metadata(&full).await.map_err(|_| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": format!("file not found: {rel}")})),
        )
    })?;
    if meta.len() > MAX_ATTACH_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(
                json!({"error": format!("file is {} bytes; attachment limit is 50 MB", meta.len())}),
            ),
        ));
    }
    let buf = tokio::fs::read(&full).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("read failed: {e}")})),
        )
    })?;
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
    let data_url = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&buf)
    );
    Ok(Json(
        json!({"path": rel, "mime": mime, "dataUrl": data_url, "size": buf.len()}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An explicit `workspace` field on the request wins over the global
    /// `coderWorkspace` pointer — the correctness fix that lets a specific
    /// conversation's tool calls stay addressed at its own repo regardless of
    /// what another tab/conversation last pointed the backend at.
    #[tokio::test]
    async fn explicit_workspace_overrides_global_pointer() {
        let base = std::env::temp_dir().join(format!("ninfier-fsws-{}", std::process::id()));
        let global_ws = base.join("global");
        let other_ws = base.join("other");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&global_ws).unwrap();
        std::fs::create_dir_all(&other_ws).unwrap();

        let state: S =
            std::sync::Arc::new(crate::types::State::new(base.clone(), base.clone(), None));
        state.config.write().await.coder_workspace = global_ws.to_string_lossy().into_owned();

        // No override: lands in the global pointer's workspace.
        let _ = fs_write(
            AxumState(state.clone()),
            Json(json!({"path": "a.txt", "content": "global"})),
        )
        .await
        .unwrap();
        assert!(global_ws.join("a.txt").exists());
        assert!(!other_ws.join("a.txt").exists());

        // Explicit override: lands in the OTHER workspace, untouched by the
        // still-unchanged global pointer.
        let _ = fs_write(
            AxumState(state.clone()),
            Json(json!({"path": "b.txt", "content": "other", "workspace": other_ws.to_string_lossy()})),
        )
        .await
        .unwrap();
        assert!(other_ws.join("b.txt").exists());
        assert!(!global_ws.join("b.txt").exists());
        assert_eq!(
            state.config.read().await.coder_workspace,
            global_ws.to_string_lossy()
        );

        let r = fs_read(
            AxumState(state.clone()),
            Json(json!({"path": "b.txt", "workspace": other_ws.to_string_lossy()})),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(r.get("content").and_then(|v| v.as_str()), Some("other"));

        let _ = std::fs::remove_dir_all(&base);
    }

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
