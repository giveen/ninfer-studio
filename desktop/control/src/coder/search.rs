// Rust guideline compliant 2026-07-28

//! Read-only repo-introspection endpoints for the coder harness: ranked
//! repo search over a cached symbol index, the repo map (declaration
//! signatures per file), and the git working-tree diff.

use super::common::{CODER_IGNORE, denied_path_prefixes, enforce_perm, path_is_denied, perm_scope, resolve_ws};
use crate::engine::S;
use axum::Json;
use axum::extract::{Query, State as AxumState};
use axum::http::StatusCode;
use parking_lot::Mutex as ParkingMutex;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

// ---------------------------------------------------------------------------
// Retrieval: ranked repo search (symbol index cached, 15s TTL) — mirrors the
// sidecar's `repoSearch`: symbol-name matches (high score) merged with
// content matches (lower score), deduped by file:line, sorted by score.
// ---------------------------------------------------------------------------
const SEARCH_SYMBOL_EXTS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "go", "c", "cpp", "h", "hpp", "hh", "java",
    "rb", "php", "swift", "kt", "kts", "scala", "sc", "cs", "sh", "bash", "zsh", "lua", "r", "ex",
    "exs", "erl", "elm", "hs", "dart", "sql",
];
/// Symbol-declaration line, same pattern the sidecar feeds to `rg`.
static SEARCH_SYMBOL_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"^(?:\s*)(?:export\s+|pub\s+|async\s+)*(?:class|interface|type|function|const|let|var|fn|struct|enum|impl|trait|def|func)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )
    .unwrap()
});
const SYMBOL_TTL: Duration = Duration::from_secs(15);
const MAX_SYMBOL_HITS: usize = 20_000;
const MAX_SYMBOL_FILES_SCANNED: usize = 5_000;
const MAX_CONTENT_MATCHES: usize = 20_000;

#[derive(Debug, Clone)]
pub struct SymHit {
    pub file: String,
    pub line: u64,
    pub name: String,
}

/// Cache slot type for the in-memory symbol index: build time, the root it
/// was built from, and the hits wrapped in an `Arc` to avoid deep-cloning
/// the symbol hit vector on every cache lookup.
type SymbolIndexCache = ParkingMutex<Option<(std::time::Instant, PathBuf, Arc<Vec<SymHit>>)>>;

fn build_symbol_index_blocking(root: &Path) -> Vec<SymHit> {
    let mut out = Vec::new();
    let mut files_scanned = 0usize;
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .parents(false)
        .filter_entry(|e| {
            if let Some(name) = e.file_name().to_str() {
                if CODER_IGNORE.contains(&name) {
                    return false;
                }
            }
            true
        })
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let p = entry.path();
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !SEARCH_SYMBOL_EXTS.contains(&ext.as_str()) {
            continue;
        }
        files_scanned += 1;
        if files_scanned > MAX_SYMBOL_FILES_SCANNED {
            break;
        }
        let Ok(rel) = p.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let Ok(content) = std::fs::read_to_string(p) else {
            continue;
        };
        for (i, line) in content.lines().enumerate() {
            if let Some(caps) = SEARCH_SYMBOL_RE.captures(line) {
                out.push(SymHit {
                    file: rel.clone(),
                    line: (i + 1) as u64,
                    name: caps[1].to_string(),
                });
            }
            if out.len() >= MAX_SYMBOL_HITS {
                break;
            }
        }
    }
    out
}

fn search_symbol_index(cache: &SymbolIndexCache, root: &Path) -> Arc<Vec<SymHit>> {
    let hits = Arc::new(build_symbol_index_blocking(root));
    let mut guard = cache.lock();
    *guard = Some((std::time::Instant::now(), root.to_path_buf(), Arc::clone(&hits)));
    hits
}

fn search_cached_symbols(cache: &SymbolIndexCache, root: &Path) -> Arc<Vec<SymHit>> {
    {
        let guard = cache.lock();
        if let Some((at, cached_root, idx)) = guard.as_ref() {
            if at.elapsed() < SYMBOL_TTL && cached_root == root {
                return Arc::clone(idx);
            }
        }
    }
    search_symbol_index(cache, root)
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    #[serde(default)]
    pub limit: Option<u64>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub approval_token: Option<String>,
    #[serde(default)]
    pub ignore_case: Option<bool>,
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
    let scope = perm_scope(&json!({ "scope": params.scope, "workspace": params.workspace }));

    if enforce_perm(
        &state,
        &scope,
        "repo_search",
        None,
        params.approval_token.as_deref(),
    )
    .await
    .is_err()
    {
        return Json(json!({
            "error": "permission denied",
            "results": [],
            "truncated": false
        }));
    }

    let Ok(root) = resolve_ws(&state, params.workspace.as_deref()).await else {
        return Json(json!({
            "error": "workspace not found",
            "results": [],
            "truncated": false
        }));
    };

    let deny_prefixes = denied_path_prefixes(&state, &scope).await;

    let ignore_case = params.ignore_case.unwrap_or(true);
    let terms: Vec<String> = if ignore_case {
        q.to_lowercase()
    } else {
        q.clone()
    }
    .split_whitespace()
    .filter(|t| !t.is_empty())
    .take(8)
    .map(String::from)
    .collect();

    let root_cloned = root.clone();
    let state_cloned = state.clone();

    let result = tokio::task::spawn_blocking(move || {
        #[derive(Debug)]
        struct RawHit {
            file: String,
            line: u64,
            snippet: String,
            score: u64,
            kind: String,
        }

        let mut results: std::collections::HashMap<String, RawHit> = std::collections::HashMap::new();

        // Symbol-name matches (cached index, high scores).
        let idx = search_cached_symbols(&state_cloned.symbol_index, &root_cloned);
        for s in idx.iter() {
            if path_is_denied(&deny_prefixes, &s.file) {
                continue;
            }
            let file_cmp = if ignore_case { s.file.to_lowercase() } else { s.file.clone() };
            let name_cmp = if ignore_case { s.name.to_lowercase() } else { s.name.clone() };
            let mut score = 0u64;
            for t in &terms {
                if name_cmp == *t {
                    score += 100;
                } else if name_cmp.starts_with(t.as_str()) {
                    score += 60;
                } else if name_cmp.contains(t.as_str()) {
                    score += 30;
                } else if file_cmp.contains(t.as_str()) {
                    score += 5;
                }
            }
            if score > 0 {
                let key = format!("{}:{}", s.file, s.line);
                results
                    .entry(key)
                    .and_modify(|e| e.score += score)
                    .or_insert_with(|| RawHit {
                        file: s.file.clone(),
                        line: s.line,
                        snippet: String::new(),
                        score,
                        kind: "symbol".to_string(),
                    });
            }
        }

        // Content matches: fixed-string, gitignore-respecting
        let q_cmp = if ignore_case { q.to_lowercase() } else { q.clone() };
        let walker = ignore::WalkBuilder::new(&root_cloned)
            .hidden(true)
            .parents(false)
            .filter_entry(|e| {
                if let Some(name) = e.file_name().to_str() {
                    if CODER_IGNORE.contains(&name) {
                        return false;
                    }
                }
                true
            })
            .build();

        let mut content_count = 0usize;
        for result in walker {
            if content_count >= MAX_CONTENT_MATCHES {
                break;
            }
            let Ok(entry) = result else { continue };
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(&root_cloned) else {
                continue;
            };
            let rel_str = rel.to_string_lossy().to_string();

            if path_is_denied(&deny_prefixes, &rel_str) {
                continue;
            }

            if let Ok(meta) = entry.metadata() {
                if meta.len() > 10 * 1024 * 1024 {
                    continue;
                }
            }

            let Ok(content_text) = std::fs::read_to_string(entry.path()) else {
                continue;
            };

            for (i, line) in content_text.lines().enumerate() {
                if content_count >= MAX_CONTENT_MATCHES {
                    break;
                }
                let line_cmp = if ignore_case { line.to_lowercase() } else { line.to_string() };
                if line_cmp.contains(&q_cmp) {
                    content_count += 1;
                    let key = format!("{rel_str}:{}", i + 1);
                    let snippet: String = line.chars().take(300).collect();
                    results
                        .entry(key)
                        .and_modify(|e| {
                            e.score += 8;
                            if e.snippet.is_empty() {
                                e.snippet = snippet.clone();
                            }
                        })
                        .or_insert_with(|| RawHit {
                            file: rel_str.clone(),
                            line: (i + 1) as u64,
                            snippet,
                            score: 8,
                            kind: "content".to_string(),
                        });
                }
            }
        }

        let mut hits: Vec<RawHit> = results.into_values().collect();
        hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.file.cmp(&b.file)).then_with(|| a.line.cmp(&b.line)));
        let truncated = hits.len() > limit;
        hits.truncate(limit);

        let arr: Vec<Value> = hits
            .into_iter()
            .map(|h| json!({
                "file": h.file,
                "line": h.line,
                "snippet": h.snippet,
                "score": h.score,
                "kind": h.kind,
            }))
            .collect();

        json!({"results": arr, "truncated": truncated})
    })
    .await
    .unwrap_or_else(|_| json!({"results": [], "truncated": false}));

    Json(result)
}

/// Shared `?workspace=<path>` override for the no-body GET endpoints below.
#[derive(Debug, Deserialize)]
pub struct WsQuery {
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub approval_token: Option<String>,
}

pub async fn repo_map(
    AxumState(state): AxumState<S>,
    Query(params): Query<WsQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let ws = resolve_ws(&state, params.workspace.as_deref()).await?;
    let scope = perm_scope(&json!({ "scope": params.scope, "workspace": params.workspace }));

    enforce_perm(
        &state,
        &scope,
        "repo_map",
        None,
        params.approval_token.as_deref(),
    )
    .await?;

    let deny_prefixes = denied_path_prefixes(&state, &scope).await;

    let result = tokio::task::spawn_blocking(move || {
        use std::collections::{HashMap, HashSet};
        use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

        let mut parser = Parser::new();
        let walker = ignore::WalkBuilder::new(&ws)
            .hidden(true)
            .parents(false)
            .filter_entry(|e| {
                if let Some(name) = e.file_name().to_str() {
                    if CODER_IGNORE.contains(&name) {
                        return false;
                    }
                }
                true
            })
            .build();

        let mut ref_counts: HashMap<String, HashSet<String>> = HashMap::new();
        let mut file_defs: HashMap<String, Vec<(String, String)>> = HashMap::new();
        let mut files_processed = 0usize;

        for entry in walker.flatten() {
            if files_processed >= 1_000 {
                break;
            }
            if entry.file_type().is_none_or(|ft| ft.is_dir()) {
                continue;
            }
            let path = entry.path();
            if let Ok(rel) = path.strip_prefix(&ws) {
                if path_is_denied(&deny_prefixes, &rel.to_string_lossy()) {
                    continue;
                }
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

            let lang = match ext {
                "rs" => tree_sitter_rust::LANGUAGE.into(),
                "ts" | "tsx" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
                "js" | "jsx" => tree_sitter_javascript::LANGUAGE.into(),
                _ => continue,
            };

            let query_str = match ext {
                "rs" => {
                    r#"
                    (function_item name: (identifier) @def)
                    (struct_item name: (type_identifier) @def)
                    (enum_item name: (type_identifier) @def)
                    (trait_item name: (type_identifier) @def)
                    (impl_item type: (type_identifier) @def)
                    (identifier) @ref
                    (type_identifier) @ref
                "#
                }
                "ts" | "tsx" | "js" | "jsx" => {
                    r#"
                    (function_declaration name: (identifier) @def)
                    (class_declaration name: (identifier) @def)
                    (interface_declaration name: (type_identifier) @def)
                    (type_alias_declaration name: (type_identifier) @def)
                    (variable_declarator name: (identifier) @def)
                    (identifier) @ref
                    (type_identifier) @ref
                    (property_identifier) @ref
                "#
                }
                _ => continue,
            };

            let Ok(content) = std::fs::read_to_string(path) else {
                continue;
            };

            if parser.set_language(&lang).is_err() {
                continue;
            }

            let Some(tree) = parser.parse(&content, None) else {
                continue;
            };

            let Ok(query) = Query::new(&lang, query_str) else {
                continue;
            };

            let mut cursor = QueryCursor::new();
            let mut matches = cursor.matches(&query, tree.root_node(), content.as_bytes());

            let rel_path = path
                .strip_prefix(&ws)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();
            let mut local_defs = Vec::new();
            files_processed += 1;

            while let Some(m) = matches.next() {
                for capture in m.captures() {
                    let node = capture.node;
                    let tag_name = query.capture_names()[capture.index as usize];
                    if let Ok(text) = node.utf8_text(content.as_bytes()) {
                        if tag_name == "def" {
                            if let Some(parent) = node.parent()
                                && let Ok(parent_text) = parent.utf8_text(content.as_bytes())
                            {
                                let sig = parent_text
                                    .lines()
                                    .map(|l| l.trim())
                                    .find(|l| {
                                        !l.is_empty()
                                            && !l.starts_with("#[")
                                            && !l.starts_with("//")
                                            && !l.starts_with("/*")
                                            && !l.starts_with("*")
                                    })
                                    .unwrap_or("")
                                    .to_string();
                                if !sig.is_empty() {
                                    local_defs.push((text.to_string(), sig));
                                }
                            }
                        } else if tag_name == "ref" {
                            ref_counts
                                .entry(text.to_string())
                                .or_default()
                                .insert(rel_path.clone());
                        }
                    }
                }
            }
            if !local_defs.is_empty() {
                file_defs.insert(rel_path, local_defs);
            }
        }

        let mut file_scores: Vec<(String, usize)> = file_defs
            .keys()
            .map(|file| {
                let score = file_defs[file]
                    .iter()
                    .map(|(sym, _)| ref_counts.get(sym).map(|set| set.len()).unwrap_or(0))
                    .sum();
                (file.clone(), score)
            })
            .collect();

        // Deterministic sorting: descending score, ascending file path as tie breaker
        file_scores.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

        let mut map_out = String::new();
        let mut chars_used = 0;
        let char_limit = 20000;

        for (file, _score) in file_scores {
            let defs = &file_defs[&file];
            let mut file_block = format!("{}:\n", file);
            let mut seen = HashSet::new();
            for (_, sig) in defs {
                if seen.insert(sig.clone()) {
                    file_block.push_str(&format!("  {}\n", sig));
                }
            }
            if chars_used + file_block.len() > char_limit {
                map_out.push_str("... (remaining files omitted due to budget)\n");
                break;
            }
            map_out.push_str(&file_block);
            chars_used += file_block.len();
        }
        json!({"map": map_out})
    })
    .await
    .unwrap_or_else(|_| json!({"error": "task panicked"}));

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Working-tree diff (git) — mirrors the sidecar's `/api/coder/diff`.
// ---------------------------------------------------------------------------
async fn git_run(root: &Path, extra_args: &[&str], secs: u64) -> Option<String> {
    let out = timeout(
        Duration::from_secs(secs),
        Command::new("git")
            .arg("--no-pager")
            .args(&[
                "-c",
                "core.fsmonitor=false",
                "-c",
                "diff.external=",
                "-c",
                "core.pager=",
                "--no-optional-locks",
            ])
            .arg("diff")
            .arg("HEAD")
            .arg("--no-ext-diff")
            .arg("--no-textconv")
            .args(extra_args)
            .env_remove("GIT_EXTERNAL_DIFF")
            .env_remove("GIT_PAGER")
            .current_dir(root)
            .output(),
    )
    .await
    .ok()
    .and_then(|o| o.ok())?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Drop `diff --git a/<path> b/<path>` sections whose path sits under a
/// denied prefix, so `denyPaths` actually keeps fenced-off content out of a
/// working-tree diff instead of only gating the endpoint as a whole.
fn filter_diff_text(diff_text: &str, deny_prefixes: &[String]) -> String {
    if deny_prefixes.is_empty() || diff_text.is_empty() {
        return diff_text.to_string();
    }
    let mut out = String::new();
    let mut current: Option<(bool, String)> = None;
    for line in diff_text.split_inclusive('\n') {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if let Some((denied, buf)) = current.take() {
                if !denied {
                    out.push_str(&buf);
                }
            }
            let path_a = rest
                .split(" b/")
                .next()
                .unwrap_or("")
                .trim()
                .trim_start_matches("a/");
            current = Some((path_is_denied(deny_prefixes, path_a), line.to_string()));
        } else if let Some((_, buf)) = current.as_mut() {
            buf.push_str(line);
        } else {
            out.push_str(line);
        }
    }
    if let Some((denied, buf)) = current {
        if !denied {
            out.push_str(&buf);
        }
    }
    out
}

pub async fn diff(
    AxumState(state): AxumState<S>,
    Query(params): Query<WsQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let root = resolve_ws(&state, params.workspace.as_deref()).await?;
    let scope = perm_scope(&json!({ "scope": params.scope, "workspace": params.workspace }));

    enforce_perm(
        &state,
        &scope,
        "git_diff",
        None,
        params.approval_token.as_deref(),
    )
    .await?;

    let deny_prefixes = denied_path_prefixes(&state, &scope).await;

    let stat = git_run(&root, &["--stat"], 15).await;
    let full = git_run(&root, &[], 60).await;
    let (stat_text, diff_text) = match (stat, full) {
        (Some(s), Some(d)) => (s, d),
        _ => {
            return Ok(Json(
                json!({"files": [], "diff": "", "error": "diff failed — see server log"}),
            ));
        }
    };
    let diff_text = filter_diff_text(&diff_text, &deny_prefixes);
    let stat_re = regex::Regex::new(r"^\s*(.+?)\s*\|\s*(?:\d+\s*([+-]*)|Bin\b.*)$").unwrap();
    let mut files = Vec::new();
    for l in stat_text.lines() {
        let Some(caps) = stat_re.captures(l) else {
            continue;
        };
        let file_path = caps[1].trim();
        if path_is_denied(&deny_prefixes, file_path) {
            continue;
        }
        let bar = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        files.push(json!({"path": file_path, "bar": bar}));
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
        let state: S =
            std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        state.config.write().await.coder_workspace = ws.to_string_lossy().into_owned();

        // Empty query short-circuits (no walk at all).
        let e = search(
            AxumState(state.clone()),
            Query(SearchQuery {
                q: Some("   ".into()),
                limit: None,
                workspace: None,
                scope: None,
                approval_token: None,
                ignore_case: None,
            }),
        )
        .await;
        assert!(e["results"].as_array().unwrap().is_empty());

        // Symbol name hits outrank plain content hits of the same term.
        let r = search(
            AxumState(state.clone()),
            Query(SearchQuery {
                q: Some("SymbolIndex".into()),
                limit: Some(50),
                workspace: None,
                scope: None,
                approval_token: None,
                ignore_case: None,
            }),
        )
        .await;
        let res = r["results"].as_array().unwrap();
        let symbol = res
            .iter()
            .find(|x| x["kind"] == "symbol")
            .expect("symbol hit for SymbolIndex");
        assert_eq!(symbol["file"], "src/handler.rs");
        let content = res
            .iter()
            .find(|x| x["kind"] == "content")
            .unwrap_or(&Value::Null);
        if !content.is_null() {
            assert!(symbol["score"].as_u64().unwrap() > content["score"].as_u64().unwrap());
        }

        // Content-only term: fixed-string match with a 300-char snippet.
        let c = search(
            AxumState(state.clone()),
            Query(SearchQuery {
                q: Some("mentions_ranking".into()),
                limit: Some(50),
                workspace: None,
                scope: None,
                approval_token: None,
                ignore_case: None,
            }),
        )
        .await;
        let c_res = c["results"].as_array().unwrap();
        assert!(
            c_res.iter().any(|x| x["file"] == "src/handler.rs"
                && x["snippet"].as_str().unwrap().contains("mentions_ranking")),
            "c_res was: {c:?}"
        );

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
            assert!(
                o.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&o.stderr)
            );
            Ok(o)
        };
        let have_git = git(&["init", "-q"]).is_ok();

        let state: S =
            std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        state.config.write().await.coder_workspace = ws.to_string_lossy().into_owned();

        if have_git {
            std::fs::write(ws.join("a.txt"), "one\n").unwrap();
            git(&["add", "."]).unwrap();
            git(&["commit", "-q", "-m", "base"]).unwrap();
            std::fs::write(ws.join("a.txt"), "one\ntwo\n").unwrap();
            let r = diff(
                AxumState(state.clone()),
                Query(WsQuery {
                    workspace: None,
                    scope: None,
                    approval_token: None,
                }),
            )
            .await
            .unwrap()
            .0;
            let files = r["files"].as_array().unwrap();
            assert!(
                files.iter().any(|f| f["path"] == "a.txt"),
                "changed file missing: {files:?}"
            );
            assert!(r["diff"].as_str().unwrap().contains("two"));

            // Clean tree → empty diff, no files.
            git(&["add", "."]).unwrap();
            git(&["commit", "-q", "-m", "b"]).unwrap();
            let r = diff(
                AxumState(state.clone()),
                Query(WsQuery {
                    workspace: None,
                    scope: None,
                    approval_token: None,
                }),
            )
            .await
            .unwrap()
            .0;
            assert!(r["files"].as_array().unwrap().is_empty());
        } else {
            let r = diff(
                AxumState(state.clone()),
                Query(WsQuery {
                    workspace: None,
                    scope: None,
                    approval_token: None,
                }),
            )
            .await
            .unwrap()
            .0;
            assert!(
                r.get("error").is_some(),
                "no git, no repo → soft error: {r:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn repo_map_produces_deterministic_signatures_and_skips_attributes() {
        let tmp = std::env::temp_dir().join(format!("ninfier-repomapws-{}", std::process::id()));
        let ws = tmp.join("ws");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(ws.join("src")).unwrap();
        std::fs::write(
            ws.join("src/lib.rs"),
            "#[derive(Debug)]\npub fn calculate_map() -> usize { 42 }\n",
        )
        .unwrap();

        let state: S =
            std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        state.config.write().await.coder_workspace = ws.to_string_lossy().into_owned();

        let res1 = repo_map(
            AxumState(state.clone()),
            Query(WsQuery {
                workspace: None,
                scope: None,
                approval_token: None,
            }),
        )
        .await
        .unwrap()
        .0;

        let map_str1 = res1["map"].as_str().unwrap();
        assert!(
            map_str1.contains("pub fn calculate_map() -> usize"),
            "signature should skip #[derive] attribute line: {map_str1}"
        );

        let res2 = repo_map(
            AxumState(state.clone()),
            Query(WsQuery {
                workspace: None,
                scope: None,
                approval_token: None,
            }),
        )
        .await
        .unwrap()
        .0;

        assert_eq!(res1, res2, "repo_map output must be deterministic");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn search_endpoints_enforce_permissions() {
        use crate::coder::common::perms_set;

        let tmp = std::env::temp_dir().join(format!("ninfier-searchperm-{}", std::process::id()));
        let ws = tmp.join("ws");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&ws).unwrap();
        let state: S =
            std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        state.config.write().await.coder_workspace = ws.to_string_lossy().into_owned();
        let ws_state = || AxumState(state.clone());

        // Set repo_search to deny
        let _ = perms_set(
            ws_state(),
            Json(json!({"tools": {"repo_search": "deny"}, "denyPaths": []})),
        )
        .await;

        let r = search(
            ws_state(),
            Query(SearchQuery {
                q: Some("test".into()),
                limit: None,
                workspace: None,
                scope: None,
                approval_token: None,
                ignore_case: None,
            }),
        )
        .await;

        assert_eq!(r["error"].as_str(), Some("permission denied"));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
