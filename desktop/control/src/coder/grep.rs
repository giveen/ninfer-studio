// Rust guideline compliant 2026-07-28

//! Workspace text lookup tools for the coder harness: regex `grep` over the
//! repo and `glob` path matching (ripgrep's `globset` matcher), both
//! gitignore-aware via the `ignore` crate and gated by `common::enforce_perm`.

use super::common::{coder_root, enforce_perm, rel_of, within_ws, CODER_IGNORE};
use crate::engine::S;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use std::path::Path;

pub async fn grep(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = state.config.read().await.coder_workspace.clone();
    if ws.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "no workspace configured"}))));
    }

    let pattern = req.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
    if pattern.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "pattern required"}))));
    }
    enforce_perm(&state, "grep", None).await?;

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
                if entry.file_type().is_none_or(|ft| ft.is_dir()) {
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
    let pattern = match req.get("pattern").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "pattern required"})))),
    };
    enforce_perm(&state, "glob", req.get("path").and_then(|v| v.as_str()).filter(|p| !p.is_empty())).await?;
    let ws = state.config.read().await.coder_workspace.clone();
    let ws_root = coder_root(&ws)?;
    let rel_root = req.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let base = if rel_root.is_empty() { ws_root.clone() } else { within_ws(&ws_root, rel_root)? };
    let base_rel = rel_of(&ws_root, &base);
    // `globset` (ripgrep's matcher) with `literal_separator`, so `*` never
    // crosses `/` — the same semantics as the sidecar's translator — plus
    // real `[...]` classes and `{a,b}` alternates.
    let matcher = glob_matcher(&pattern)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"error": format!("invalid glob: {e}")}))))?;
    let files = tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        walk_files(&ws_root, &base_rel, &mut out, 4000);
        out.into_iter().filter(|f| matcher.is_match(f)).collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    let mut files = files;
    files.sort();
    files.truncate(4000);
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
    let dir = if rel == "." { root.to_path_buf() } else { root.join(rel) };
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
        let child = if rel == "." { name.clone() } else { format!("{rel}/{name}") };
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
