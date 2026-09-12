// Rust guideline compliant 2026-07-28

//! Read-only repo-introspection endpoints for the coder harness: ranked
//! repo search over a cached symbol index, the repo map (declaration
//! signatures per file), and the git working-tree diff.

use super::common::coder_root;
use crate::engine::S;
use axum::extract::{Query, State as AxumState};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

// ---------------------------------------------------------------------------
// Retrieval: ranked repo search (symbol index cached, 15s TTL) — mirrors the
// sidecar's `repoSearch`: symbol-name matches (high score) merged with
// content matches (lower score), deduped by file:line, sorted by score.
// ---------------------------------------------------------------------------
const SEARCH_SYMBOL_EXTS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "c", "cpp", "h", "hpp", "hh", "java", "rb", "php", "swift",
    "kt", "kts", "scala", "sc", "cs", "sh", "bash", "zsh", "lua", "r", "ex", "exs", "erl", "elm", "hs", "dart", "sql",
];
/// Symbol-declaration line, same pattern the sidecar feeds to `rg`.
static SEARCH_SYMBOL_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"^(?:\s*)(?:export\s+|pub\s+|async\s+)*(?:class|interface|type|function|const|let|var|fn|struct|enum|impl|trait|def|func)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )
    .unwrap()
});
const SYMBOL_TTL: Duration = Duration::from_secs(15);
const MAX_SYMBOL_FILES: usize = 20_000;
const MAX_CONTENT_MATCHES: usize = 20_000;

#[derive(Clone)]
struct SymHit {
    file: String,
    line: u64,
    name: String,
}

/// In-memory symbol index for the active workspace, refreshed at most every
/// 15s so repeated searches in a short window are cheap (the sidecar's
/// "persistent" repo index, rebuilt on the same TTL).
static SYMBOL_INDEX: LazyLock<Mutex<Option<(std::time::Instant, Vec<SymHit>)>>> =
    LazyLock::new(|| Mutex::new(None));

fn build_symbol_index_blocking(root: &Path) -> Vec<SymHit> {
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(root).hidden(false).build();
    for result in walker {
        if out.len() >= MAX_SYMBOL_FILES {
            break;
        }
        let Ok(entry) = result else { continue };
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !SEARCH_SYMBOL_EXTS.contains(&ext) {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().to_string();
        for (i, line) in content.lines().enumerate() {
            if let Some(caps) = SEARCH_SYMBOL_RE.captures(line) {
                out.push(SymHit {
                    file: rel.clone(),
                    line: (i + 1) as u64,
                    name: caps[1].to_string(),
                });
            }
            if out.len() >= MAX_SYMBOL_FILES {
                break;
            }
        }
    }
    out
}

fn search_symbol_index(root: &Path) -> Vec<SymHit> {
    let idx = build_symbol_index_blocking(root);
    *SYMBOL_INDEX.lock().unwrap() = Some((std::time::Instant::now(), idx));
    SYMBOL_INDEX.lock().unwrap().as_ref().unwrap().1.clone()
}

fn search_cached_symbols(root: &Path) -> Vec<SymHit> {
    // Drop the guard before rebuilding: the rebuild locks the same mutex, so
    // holding it across the call would self-deadlock on a cache miss.
    {
        let guard = SYMBOL_INDEX.lock().unwrap();
        if let Some((at, idx)) = guard.as_ref() {
            if at.elapsed() < SYMBOL_TTL {
                return idx.clone();
            }
        }
    }
    search_symbol_index(root)
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
    #[serde(default)]
    limit: Option<u64>,
}

pub async fn search(
    AxumState(state): AxumState<S>,
    Query(params): Query<SearchQuery>,
) -> Json<Value> {
    let q = params.q.unwrap_or_default().trim().to_string();
    if q.is_empty() {
        return Json(json!({"results": [], "truncated": false}));
    }
    let limit = params.limit.unwrap_or(15).clamp(1, 50) as usize;
    let ws = state.config.read().await.coder_workspace.clone();
    let Ok(root) = coder_root(&ws) else {
        return Json(json!({"results": [], "truncated": false}));
    };
    let terms: Vec<String> = q
        .to_lowercase()
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .take(8)
        .map(String::from)
        .collect();
    let root_cloned = root.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut results: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
        // Symbol-name matches (cached index, high scores).
        let idx = search_cached_symbols(&root_cloned);
        for s in &idx {
            let file_low = s.file.to_lowercase();
            let name_low = s.name.to_lowercase();
            let mut score = 0;
            for t in &terms {
                if name_low == *t {
                    score += 100;
                } else if name_low.starts_with(t.as_str()) {
                    score += 60;
                } else if name_low.contains(t.as_str()) {
                    score += 30;
                } else if file_low.contains(t.as_str()) {
                    score += 10;
                }
            }
            if score > 0 {
                let key = format!("{}:{}", s.file, s.line);
                let e = results
                    .entry(key)
                    .or_insert_with(|| json!({"file": s.file, "line": s.line, "snippet": "", "score": 0, "kind": "symbol"}));
                *e = json!({"file": s.file, "line": s.line, "snippet": e["snippet"], "score": e["score"].as_u64().unwrap_or(0) + score as u64, "kind": e["kind"]});
            }
        }
        // Content matches: case-sensitive fixed-string, gitignore-respecting
        // (the `ignore` crate mirrors the sidecar's `rg` exclude list).
        let q_bytes = q.as_bytes();
        let walker = ignore::WalkBuilder::new(&root_cloned).hidden(false).build();
        let mut content = 0usize;
        for result in walker {
            if content >= MAX_CONTENT_MATCHES {
                break;
            }
            let Ok(entry) = result else { continue };
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(&root_cloned) else {
                continue;
            };
            let rel = rel.to_string_lossy().to_string();
            let Ok(content_text) = std::fs::read_to_string(entry.path()) else {
                continue; // binary file — rg would skip it too
            };
            for (i, line) in content_text.lines().enumerate() {
                if content >= MAX_CONTENT_MATCHES {
                    break;
                }
                if line.as_bytes().windows(q_bytes.len()).any(|w| w == q_bytes) {
                    content += 1;
                    let key = format!("{rel}:{}", i + 1);
                    let e = results.entry(key).or_insert_with(|| {
                        json!({"file": rel, "line": i + 1, "snippet": "", "score": 0, "kind": "content"})
                    });
                    let snippet: String = line.chars().take(300).collect();
                    *e = json!({"file": e["file"], "line": e["line"], "snippet": snippet, "score": e["score"].as_u64().unwrap_or(0) + 8, "kind": e["kind"]});
                }
            }
        }
        let mut arr: Vec<Value> = results.into_iter().map(|(_, v)| v).collect();
        arr.sort_by(|a, b| {
            b["score"].as_u64().unwrap_or(0).cmp(&a["score"].as_u64().unwrap_or(0))
        });
        let truncated = arr.len() > limit;
        arr.truncate(limit);
        json!({"results": arr, "truncated": truncated})
    })
    .await
    .unwrap_or_else(|_| json!({"results": [], "truncated": false}));
    Json(result)
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
        for entry in walker.flatten() {
            if entry.file_type().is_none_or(|ft| ft.is_dir()) {
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
                    if let Some(_caps) = re.captures(line) {
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
        if map.len() > 15000 {
            map.truncate(15000);
            map.push_str("\n... (repo map truncated)");
        }
        json!({"map": map})
    }).await.unwrap_or_else(|_| json!({"error": "task panicked"}));

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Working-tree diff (git) — mirrors the sidecar's `/api/coder/diff`.
// ---------------------------------------------------------------------------
async fn git_run(root: &Path, args: &[&str], secs: u64) -> Option<String> {
    let out = timeout(
        Duration::from_secs(secs),
        Command::new("git").arg("--no-pager").args(args).current_dir(root).output(),
    )
    .await
    .ok()
    .and_then(|o| o.ok())?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

pub async fn diff(AxumState(state): AxumState<S>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = state.config.read().await.coder_workspace.clone();
    let root = coder_root(&ws)?;
    let stat = git_run(&root, &["diff", "HEAD", "--stat"], 15).await;
    let full = git_run(&root, &["diff", "HEAD"], 60).await;
    let (stat_text, diff_text) = match (stat, full) {
        (Some(s), Some(d)) => (s, d),
        // Either git call failing (no repo, timeout, git missing) means the
        // diff is unavailable — report it like the sidecar, don't error out.
        _ => {
            return Ok(Json(json!({"files": [], "diff": "", "error": "diff failed — see server log"})));
        }
    };
    let stat_re = regex::Regex::new(r"^(.+?)\s*\|\s*\d+\s*([+-]*)$").unwrap();
    let mut files = Vec::new();
    for l in stat_text.lines() {
        let Some(caps) = stat_re.captures(l) else {
            continue;
        };
        // The "N files changed" summary line has no `|`; file lines start with
        // a space — keep only genuine per-file rows.
        if l.starts_with(' ') {
            let bar = caps[2].to_string();
            files.push(json!({"path": caps[1].trim(), "bar": bar}));
        }
    }
    let truncated = diff_text.len() > 60_000;
    Ok(Json(json!({
        "files": files,
        "diff": diff_text.chars().take(60_000).collect::<String>(),
        "truncated": truncated,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn search_ranks_symbols_above_content() {
        let tmp = std::env::temp_dir().join(format!("ninfier-searchws-{}", std::process::id()));
        let ws = tmp.join("ws");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(ws.join("src")).unwrap();
        std::fs::write(
            ws.join("src/handler.rs"),
            "pub async fn rank_symbols() {}\npub struct SymbolIndex {}\nlet mentions_ranking = 1;\n",
        )
        .unwrap();
        let state: S = std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        state.config.write().await.coder_workspace = ws.to_string_lossy().into_owned();

        // Empty query short-circuits (no walk at all).
        let e = search(AxumState(state.clone()), Query(SearchQuery { q: Some("   ".into()), limit: None })).await;
        assert!(e["results"].as_array().unwrap().is_empty());

        // Symbol name hits outrank plain content hits of the same term.
        let r = search(AxumState(state.clone()), Query(SearchQuery { q: Some("SymbolIndex".into()), limit: Some(50) })).await;
        let res = r["results"].as_array().unwrap();
        let symbol = res.iter().find(|x| x["kind"] == "symbol").expect("symbol hit for SymbolIndex");
        assert_eq!(symbol["file"], "src/handler.rs");
        let content = res.iter().find(|x| x["kind"] == "content").unwrap_or(&Value::Null);
        if !content.is_null() {
            assert!(symbol["score"].as_u64().unwrap() > content["score"].as_u64().unwrap());
        }

        // Content-only term: fixed-string match with a 300-char snippet.
        let c = search(AxumState(state.clone()), Query(SearchQuery { q: Some("mentions_ranking".into()), limit: Some(50) })).await;
        let c_res = c["results"].as_array().unwrap();
        assert!(c_res.iter().any(|x| x["file"] == "src/handler.rs" && x["snippet"].as_str().unwrap().contains("mentions_ranking")));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn diff_reports_working_tree_changes() {
        let tmp = std::env::temp_dir().join(format!("ninfier-diffws-{}", std::process::id()));
        let ws = tmp.join("ws");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&ws).unwrap();
        let git = |args: &[&str]| -> std::io::Result<std::process::Output> {
            let o = std::process::Command::new("git")
                .args(args)
                .current_dir(&ws)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()?;
            assert!(o.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&o.stderr));
            Ok(o)
        };
        // No git (exotic runners) → skip the assertions; the no-repo path is
        // still exercised below and must return a soft error, not a 500.
        let have_git = git(&["init", "-q"]).is_ok();

        let state: S = std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        state.config.write().await.coder_workspace = ws.to_string_lossy().into_owned();

        if have_git {
            std::fs::write(ws.join("a.txt"), "one\n").unwrap();
            git(&["add", "."]).unwrap();
            git(&["commit", "-q", "-m", "base"]).unwrap();
            std::fs::write(ws.join("a.txt"), "one\ntwo\n").unwrap();
            let r = diff(AxumState(state.clone())).await.unwrap().0;
            let files = r["files"].as_array().unwrap();
            assert!(files.iter().any(|f| f["path"] == "a.txt"), "changed file missing: {files:?}");
            assert!(r["diff"].as_str().unwrap().contains("two"));
            // Clean tree → empty diff, no files.
            git(&["add", "."]).unwrap();
            git(&["commit", "-q", "-m", "b"]).unwrap();
            let r = diff(AxumState(state.clone())).await.unwrap().0;
            assert!(r["files"].as_array().unwrap().is_empty());
        } else {
            let r = diff(AxumState(state.clone())).await.unwrap().0;
            assert!(r.get("error").is_some(), "no git, no repo → soft error: {r:?}");
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
