// Rust guideline compliant 2026-07-28

//! Workspace text lookup tools for the coder harness: regex `grep` over the
//! repo and `glob` path matching (ripgrep's `globset` matcher), both
//! gitignore-aware via the `ignore` crate and gated by `common::enforce_perm`.

use super::common::{CODER_IGNORE, enforce_perm, perm_scope, rel_of, resolve_ws, within_ws};
use crate::engine::S;
use axum::Json;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::path::Path;

pub async fn grep(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = resolve_ws(&state, req.get("workspace").and_then(|v| v.as_str())).await?;

    let pattern = req.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
    if pattern.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "pattern required"})),
        ));
    }
    let rel_root = req.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let search_root = if rel_root.is_empty() {
        ws.clone()
    } else {
        within_ws(&ws, rel_root)?
    };

    enforce_perm(
        &state,
        &perm_scope(&req),
        "grep",
        req.get("path").and_then(|v| v.as_str()).filter(|p| !p.is_empty()),
        req.get("approvalToken").and_then(|v| v.as_str()),
    )
    .await?;

    let ignore_case = req
        .get("ignoreCase")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let regex_pattern = if ignore_case {
        format!("(?i){}", pattern)
    } else {
        pattern.to_string()
    };

    let re = match regex::RegexBuilder::new(&regex_pattern).build() {
        Ok(r) => r,
        Err(e) => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("invalid regex: {}", e)})),
            ));
        }
    };

    let include_pattern = req.get("include").and_then(|v| v.as_str());
    let include_matcher = if let Some(p) = include_pattern {
        if !p.trim().is_empty() {
            glob_matcher(p.trim()).ok()
        } else {
            None
        }
    } else {
        None
    };

    let offset = req.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let limit = req
        .get("limit")
        .or_else(|| req.get("maxMatches"))
        .and_then(|v| v.as_u64())
        .unwrap_or(200)
        .clamp(1, 2000) as usize;

    let result = tokio::task::spawn_blocking(move || {
        let mut all_matches = Vec::new();
        let walker = ignore::WalkBuilder::new(&search_root)
            .hidden(false)
            .max_filesize(Some(10 * 1024 * 1024))
            .filter_entry(|e| {
                if let Some(name) = e.file_name().to_str()
                    && CODER_IGNORE.contains(&name) {
                        return false;
                    }
                true
            })
            .build();

        for entry in walker.flatten() {
            if entry.file_type().is_none_or(|ft| ft.is_dir()) {
                continue;
            }

            let path = entry.path();
            let rel_path = path
                .strip_prefix(&ws)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();

            if let Some(ref matcher) = include_matcher
                && !matcher.is_match(&rel_path) {
                    continue;
                }

            if let Ok(content) = std::fs::read_to_string(path) {
                for (i, line) in content.lines().enumerate() {
                    if re.is_match(line) {
                        let mut text = line.to_string();
                        if text.len() > 400 {
                            let mut cut = 400;
                            while !text.is_char_boundary(cut) {
                                cut -= 1;
                            }
                            text.truncate(cut);
                        }
                        all_matches.push(json!({
                            "file": rel_path,
                            "line": i + 1,
                            "text": text
                        }));
                    }
                }
            }
        }

        let total = all_matches.len();
        let sliced: Vec<Value> = all_matches
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect();
        let count = sliced.len();
        let has_more = offset + count < total;

        json!({
            "matches": sliced,
            "total": total,
            "count": count,
            "offset": offset,
            "limit": limit,
            "truncated": has_more,
            "more": has_more
        })
    })
    .await
    .unwrap_or_else(|_| json!({"error": "task panicked"}));

    Ok(Json(result))
}

pub async fn glob(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let pattern = match req.get("pattern").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "pattern required"})),
            ));
        }
    };
    enforce_perm(
        &state,
        &perm_scope(&req),
        "glob",
        req.get("path")
            .and_then(|v| v.as_str())
            .filter(|p| !p.is_empty()),
        req.get("approvalToken").and_then(|v| v.as_str()),
    )
    .await?;
    let ws_root = resolve_ws(&state, req.get("workspace").and_then(|v| v.as_str())).await?;
    let rel_root = req.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let base = if rel_root.is_empty() {
        ws_root.clone()
    } else {
        within_ws(&ws_root, rel_root)?
    };
    let base_rel = rel_of(&ws_root, &base);
    let matcher = glob_matcher(&pattern).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("invalid glob: {e}")})),
        )
    })?;
    let files = tokio::task::spawn_blocking(move || {
        let mut all_files = Vec::new();
        walk_files(&ws_root, &base_rel, &mut all_files, usize::MAX);
        all_files.sort();
        all_files
            .into_iter()
            .filter(|f| matcher.is_match(f))
            .take(4000)
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();

    Ok(Json(json!({"files": files})))
}

/// Compile a glob with ripgrep's matcher. `literal_separator` keeps sidecar
/// semantics (`*`/`?` never cross `/`); `**` still crosses directories.
fn glob_matcher(pattern: &str) -> Result<globset::GlobMatcher, globset::Error> {
    Ok(globset::GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()?
        .compile_matcher())
}

/// Collect root-relative file paths under `rel` (blocking). Skips ignored dirs.
fn walk_files(root: &Path, rel: &str, out: &mut Vec<String>, cap: usize) {
    if out.len() >= cap {
        return;
    }
    let dir = if rel == "." {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if out.len() >= cap {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let child = if rel == "." {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if ft.is_dir() {
            if CODER_IGNORE.contains(&name.as_str()) {
                continue;
            }
            walk_files(root, &child, out, cap);
        } else if ft.is_file() {
            out.push(child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_translation_matches_sidecar_semantics() {
        let m = glob_matcher("*.ts").unwrap();
        assert!(m.is_match("a.ts"));
        assert!(!m.is_match("a/b.ts"));
        assert!(!m.is_match("a.tsx"));
        let m = glob_matcher("src/**/*.rs").unwrap();
        assert!(m.is_match("src/main.rs"));
        assert!(m.is_match("src/a/b/lib.rs"));
        assert!(!m.is_match("other/main.rs"));
        let m = glob_matcher("file?.txt").unwrap();
        assert!(m.is_match("file1.txt"));
        assert!(!m.is_match("file12.txt"));
        // Literal dots must not act as wildcards.
        let m = glob_matcher("a.b").unwrap();
        assert!(m.is_match("a.b"));
        assert!(!m.is_match("axb"));
        // Native extras the hand-rolled translator lacked: classes + alternates.
        let m = glob_matcher("file[123].txt").unwrap();
        assert!(m.is_match("file2.txt"));
        assert!(!m.is_match("file9.txt"));
        let m = glob_matcher("src/*.{ts,rs}").unwrap();
        assert!(m.is_match("src/a.ts"));
        assert!(m.is_match("src/a.rs"));
        assert!(!m.is_match("src/a/b.ts"));
        assert!(glob_matcher("[").is_err());
    }
}
