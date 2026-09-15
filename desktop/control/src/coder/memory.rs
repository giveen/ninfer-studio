// Rust guideline compliant 2026-07-28

//! Coder self-improving memory (per-workspace, stored OUTSIDE the user's repo
//! so it never gets committed). Byte-compatible twin of the sidecar's
//! `memDirFor` / `readMemFile` / `writeMemFile` / `readLearnings` — both
//! processes share <DATA_DIR>/coder-memory/<slug>/:
//!   bank.md           curated markdown bank, injected into the system prompt
//!   learnings.jsonl   append-only structured learning entries

use crate::engine::S;
use crate::memstore::{apply_memory_update, read_bank_and_learnings};
use axum::Json;
use axum::extract::{Query, State as AxumState};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// `<DATA_DIR>/coder-memory/<slug>`, where `slug` is the workspace path with
/// every non-`[\w.-]` char mapped to `_`, kept to its last 160 chars — the
/// exact transform the sidecar's `memDirFor` applies
/// (`String(ws).replace(/[^\w.-]/g, '_').slice(-160)`), so sidecar- and app-written memory stay
/// interchangeable. JS regexes match **UTF-16 code units**, so a non-BMP char
/// (e.g. an emoji) contributes two `_` — process `encode_utf16()` to keep the
/// two implementations in agreement (and slice the last 160 of those units).
fn mem_dir(data_dir: &Path, ws: &str) -> PathBuf {
    let units: Vec<char> = ws
        .encode_utf16()
        .map(|u| {
            let c = char::from_u32(u as u32).unwrap_or('_');
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let start = units.len().saturating_sub(160);
    data_dir
        .join("coder-memory")
        .join(units[start..].iter().copied().collect::<String>())
}

/// Strip the Windows extended-length prefix (`\\?\` / `\\?/` / `//?/`) that
/// `std::fs::canonicalize` adds, so the slug matches the plain form the
/// sidecar's `path.resolve` produces. (PR #7 carries the public twin in
/// `types.rs` for the workspace-identity fix; kept private here so the two
/// PRs stay independently mergeable.)
fn strip_ext_prefix(p: &str) -> &str {
    for pre in ["\\\\?\\", "\\\\?/", "//?/"] {
        if let Some(rest) = p.strip_prefix(pre) {
            return rest;
        }
    }
    p
}

/// The workspace string to slug — the same absolute-path policy as the
/// sidecar's `path.resolve(ws)`: canonicalize when the path exists (real
/// absolute path, `..` collapsed); otherwise best-effort (absolute as-is,
/// relative joined against the control plane's cwd). Without this, a
/// persisted *relative* workspace would slug here as relative while the
/// sidecar slugs the cwd-resolved absolute path — silently splitting the
/// store. The `\\?\` prefix is stripped so the slug is stable across the
/// workspace-identity fix.
fn memory_ws(ws: &str) -> String {
    // Strip the prefix from the INPUT, not only the outputs: on a non-Windows
    // host a `\\?\`-prefixed string is not `Path::is_absolute()`, so without
    // this it would be cwd-joined before any strip could run (and the test
    // above would only pass on Windows).
    let ws = strip_ext_prefix(ws.trim());
    if let Ok(c) = std::fs::canonicalize(Path::new(ws)) {
        return strip_ext_prefix(&c.to_string_lossy()).to_string();
    }
    let joined = if Path::new(ws).is_absolute() {
        PathBuf::from(ws)
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(ws)
    };
    strip_ext_prefix(&joined.to_string_lossy()).to_string()
}

/// Resolve this workspace's memory dir, migrating one-time from the slug a
/// pre-fix Windows build would have written (back then the stored workspace
/// carried the `\\?\` extended prefix from canonicalize, so memory lived
/// under a slug with four extra leading underscores). Renames the old dir
/// into place once; after that the clean dir exists and this is a no-op.
fn memory_dir(data_dir: &Path, ws: &str) -> PathBuf {
    let dir = mem_dir(data_dir, ws);
    let prefixed = mem_dir(data_dir, &format!("\\\\?\\{ws}"));
    if !dir.exists() && prefixed.exists() {
        if let Some(parent) = dir.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::rename(&prefixed, &dir);
    }
    dir
}

/// Optional `?workspace=<path>` override for the memory GET (see
/// `resolve_mem_dir` — explicit target takes precedence over the global
/// `coderWorkspace` pointer).
#[derive(Debug, Deserialize)]
pub struct MemQuery {
    // pub(crate): the in-process agent dispatch (src/agent/tools.rs) builds
    // these extractors directly instead of round-tripping through HTTP.
    pub workspace: Option<String>,
}

/// Resolve this request's memory dir. An explicit `workspace` (GET query
/// param / POST body field) takes precedence over the global
/// `coderWorkspace` pointer: a caller that knows its target workspace (e.g.
/// a UI panel mid-switch, while the pointer is being re-pointed
/// asynchronously) can address the intended store directly. Without an
/// override the global pointer is used (400 when it is unset).
async fn resolve_mem_dir(
    state: &S,
    explicit: Option<&str>,
) -> Result<PathBuf, (StatusCode, Json<Value>)> {
    let ws = match explicit.map(str::trim).filter(|w| !w.is_empty()) {
        Some(w) => w.to_string(),
        None => {
            let ws = state.config.read().await.coder_workspace.clone();
            if ws.trim().is_empty() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": "no workspace configured"})),
                ));
            }
            ws
        }
    };
    Ok(memory_dir(&state.data_dir, &memory_ws(&ws)))
}

/// GET /api/coder/memory — current bank + learnings for the configured
/// workspace, or for the workspace named in `?workspace=` when given.
pub async fn memory_get(
    AxumState(state): AxumState<S>,
    Query(params): Query<MemQuery>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let dir = match resolve_mem_dir(&state, params.workspace.as_deref()).await {
        Ok(dir) => dir,
        Err(e) => return Err(e),
    };
    Ok(Json(read_bank_and_learnings(&dir).await))
}

/// POST /api/coder/memory — apply at most one of the three body shapes and
/// return the refreshed `{bank, learnings}` (sidecar-compatible):
///   `{ bank }`            replace the markdown bank wholesale
///   `{ learning: {...} }` append one structured learning
///   `{ dropLearningId }`  drop a single learning (file rewritten, rest kept)
/// An optional `{ workspace }` field addresses a store other than the
/// configured one (see `resolve_mem_dir`).
pub async fn memory_set(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let explicit = req.get("workspace").and_then(|v| v.as_str());
    let dir = match resolve_mem_dir(&state, explicit).await {
        Ok(dir) => dir,
        Err(e) => return Err(e),
    };
    Ok(Json(apply_memory_update(&state, &dir, &req).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memstore::read_learnings;

    #[test]
    fn strip_extended_prefix_matches_windows_canonicalize_form() {
        use crate::types::strip_extended_prefix;
        assert_eq!(strip_extended_prefix("\\\\?\\C:\\tmp"), "C:\\tmp");
        assert_eq!(strip_extended_prefix("\\\\?/C:/tmp"), "C:/tmp");
        assert_eq!(strip_extended_prefix("//?/C:/tmp"), "C:/tmp");
        // UNC: canonicalize yields `\\?\UNC\server\share` — a bare
        // `UNC\server\share` would be relative, so the leading UNC
        // separators must be restored to the picker's `\\server\share`.
        assert_eq!(
            strip_extended_prefix("\\\\?\\UNC\\server\\share"),
            "\\\\server\\share"
        );
        assert_eq!(
            strip_extended_prefix("\\\\?/UNC/server/share"),
            "\\\\server\\share"
        );
        // Plain paths pass through untouched.
        assert_eq!(strip_extended_prefix("C:\\tmp"), "C:\\tmp");
        assert_eq!(strip_extended_prefix("/home/dev/x"), "/home/dev/x");
        assert_eq!(strip_extended_prefix(""), "");
    }

    #[test]
    fn memory_slug_matches_sidecar_transform() {
        // The sidecar's `String(ws).replace(/[^\w.-]/g, '_').slice(-160)` —
        // on Windows path.resolve keeps `E:` + `\` separators, so both map
        // to `_` (two underscores after the drive letter).
        let slug = |ws: &str| -> String {
            mem_dir(Path::new("D:/data"), ws)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(
            slug("E:/GitHub/PublicRepos/ninfer-studio"),
            "E__GitHub_PublicRepos_ninfer-studio"
        );
        // Backslash vs slash paths must slug identically (Windows interop).
        assert_eq!(slug("E:\\GitHub\\proj"), slug("E:/GitHub/proj"));
        // Long paths keep their tail (slice(-160)).
        let long: String = "a".repeat(200);
        assert_eq!(slug(&long).len(), 160);
    }

    #[test]
    fn memory_slug_matches_js_utf16_semantics() {
        // JS replaces per UTF-16 code unit: an emoji is a surrogate pair →
        // TWO underscores, BMP non-ASCII → one.
        let slug = |ws: &str| -> String {
            mem_dir(Path::new("D:/data"), ws)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(slug("C:/w💡ork"), "C__w__ork"); // 💡 = two units → "__"
        assert_eq!(slug("C:/wéork"), "C__w_ork"); // é = one unit → "_"
        // Same input must slug identically regardless of implementation.
        let js_style: String = "C:/w💡ork"
            .encode_utf16()
            .map(|u| {
                let c = char::from_u32(u as u32).unwrap_or('_');
                if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        assert_eq!(slug("C:/w💡ork"), js_style);
    }

    #[test]
    fn memory_dir_migrates_prefixed_slug_dir() {
        // Simulate a pre-fix store: memory written under the slug of the
        // `\\?\\`-prefixed workspace string.
        let root = std::env::temp_dir().join(format!("ninfier-memtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let ws = "C:\\tmp";
        let clean = mem_dir(&root, ws);
        let old = mem_dir(&root, &format!("\\\\?\\{ws}"));
        assert_ne!(clean, old);
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("bank.md"), "# kept").unwrap();
        // Migration: old dir renamed into the clean slug dir.
        let got = memory_dir(&root, ws);
        assert_eq!(got, clean);
        assert!(clean.exists(), "old dir must be migrated into place");
        assert_eq!(
            std::fs::read_to_string(clean.join("bank.md")).unwrap(),
            "# kept"
        );
        // Idempotent: second call is a no-op.
        assert_eq!(memory_dir(&root, ws), clean);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn memory_ws_normalizes_relative_and_prefixed() {
        // A persisted relative or prefixed workspace must slug the same as
        // its plain absolute form (sidecar `path.resolve` parity).
        let tmp = std::env::temp_dir().join(format!("ninfier-memtest-ws-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let plain = tmp.to_string_lossy().into_owned();
        let a = memory_ws(&plain);
        assert!(Path::new(&a).is_absolute(), "not absolute: {a}");
        assert!(!a.starts_with("\\\\?\\"), "prefix not stripped: {a}");
        // Prefixed input resolves to the same key as the plain one.
        let b = memory_ws(&format!("\\\\?\\{plain}"));
        assert_eq!(a, b);
        // A not-yet-existing *relative* path is joined against the cwd
        // (path.resolve behavior), so it can never slug bare-relative.
        let rel = memory_ws("does/not/exist-yet");
        assert!(Path::new(&rel).is_absolute(), "relative slug: {rel}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn memory_handler_round_trip() {
        // Handler-level persistence regression: bank replace, JSONL append
        // fields, drop rewrite, per-workspace isolation, and the no-workspace
        // 400 — against a temp DATA_DIR, like coder_round_trip.
        let tmp =
            std::env::temp_dir().join(format!("ninfier-memtest-handler-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let ws_a = tmp.join("ws-a");
        let ws_b = tmp.join("ws-b");
        std::fs::create_dir_all(&ws_a).unwrap();
        std::fs::create_dir_all(&ws_b).unwrap();
        let state: S =
            std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        let ws = || AxumState(state.clone());

        // No workspace configured → 400.
        state.config.write().await.coder_workspace = String::new();
        let e = memory_get(ws(), Query(MemQuery { workspace: None }))
            .await
            .unwrap_err();
        assert_eq!(e.0, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(
            e.1.0.get("error").and_then(|v| v.as_str()),
            Some("no workspace configured")
        );

        // Workspace A: append → exact entry shape (id prefix, kind,
        // provenance default, task, ISO ts), then bank replace, both returned.
        state.config.write().await.coder_workspace = ws_a.to_string_lossy().into_owned();
        let r = memory_set(ws(), Json(json!({"learning": {"text": "run pnpm test", "kind": "tip", "provenance": "tool", "task": "t1"}})))
            .await
            .unwrap()
            .0;
        let l0 = r.get("learnings").and_then(|v| v.as_array()).unwrap()[0].clone();
        assert!(
            l0.get("id")
                .and_then(|v| v.as_str())
                .unwrap()
                .starts_with("l_")
        );
        assert_eq!(
            l0.get("text").and_then(|v| v.as_str()),
            Some("run pnpm test")
        );
        assert_eq!(l0.get("kind").and_then(|v| v.as_str()), Some("tip"));
        assert_eq!(l0.get("provenance").and_then(|v| v.as_str()), Some("tool"));
        assert_eq!(l0.get("task").and_then(|v| v.as_str()), Some("t1"));
        assert!(
            l0.get("ts")
                .and_then(|v| v.as_str())
                .unwrap()
                .ends_with('Z')
        );

        // The append landed on disk as JSONL under the clean slug.
        let on_disk = read_learnings(&memory_dir(
            &state.data_dir,
            &memory_ws(&ws_a.to_string_lossy()),
        ))
        .await;
        assert_eq!(on_disk.len(), 1);

        // Second append, then drop the first — rewrite keeps the rest.
        let r3 = memory_set(
            ws(),
            Json(json!({"learning": {"text": "second", "kind": "avoid"}})),
        )
        .await
        .unwrap()
        .0;
        let learnings = r3.get("learnings").and_then(|v| v.as_array()).unwrap();
        assert_eq!(learnings.len(), 2);
        let first_id = learnings[0]
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();
        let r4 = memory_set(ws(), Json(json!({"dropLearningId": first_id})))
            .await
            .unwrap()
            .0;
        let learnings = r4.get("learnings").and_then(|v| v.as_array()).unwrap();
        assert_eq!(learnings.len(), 1);
        assert_eq!(
            learnings[0].get("text").and_then(|v| v.as_str()),
            Some("second")
        );

        // Workspace B: fully isolated
        state.config.write().await.coder_workspace = ws_b.to_string_lossy().into_owned();
        let r5 = memory_get(ws(), Query(MemQuery { workspace: None }))
            .await
            .unwrap()
            .0;
        assert_eq!(
            r5.get("learnings")
                .and_then(|v| v.as_array())
                .unwrap()
                .len(),
            0
        );
        // …and A still has its learning.
        state.config.write().await.coder_workspace = ws_a.to_string_lossy().into_owned();
        let r6 = memory_get(ws(), Query(MemQuery { workspace: None }))
            .await
            .unwrap()
            .0;
        assert_eq!(
            r6.get("learnings")
                .and_then(|v| v.as_array())
                .unwrap()
                .len(),
            1
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn memory_explicit_workspace_override() {
        // An explicit `workspace` (query param / body field) must address
        // the named store even when the global pointer is elsewhere — the
        // UI mid-switch safety case. Omitted falls back to the pointer
        // (legacy behavior); pointer unset without an override → 400.
        let tmp =
            std::env::temp_dir().join(format!("ninfier-memtest-explicit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let ws_a = tmp.join("ws-a");
        let ws_b = tmp.join("ws-b");
        std::fs::create_dir_all(&ws_a).unwrap();
        std::fs::create_dir_all(&ws_b).unwrap();
        let state: S =
            std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        let ws = || AxumState(state.clone());
        let a = ws_a.to_string_lossy().into_owned();
        let q_a = || {
            Query(MemQuery {
                workspace: Some(a.clone()),
            })
        };
        let q_none = || Query(MemQuery { workspace: None });

        // Pointer → B. An explicit-A POST lands in A's store…
        state.config.write().await.coder_workspace = ws_b.to_string_lossy().into_owned();
        let r = memory_set(
            ws(),
            Json(json!({"workspace": a, "learning": {"text": "for A only", "kind": "tip"}})),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(
            r.get("learnings").and_then(|v| v.as_array()).unwrap().len(),
            1
        );
        // …and the pointer's store (B) stayed empty.
        let rb = memory_get(ws(), q_none()).await.unwrap().0;
        assert_eq!(
            rb.get("learnings")
                .and_then(|v| v.as_array())
                .unwrap()
                .len(),
            0
        );
        // Explicit GET reads A.
        let ra = memory_get(ws(), q_a()).await.unwrap().0;
        let la = ra.get("learnings").and_then(|v| v.as_array()).unwrap();
        assert_eq!(la.len(), 1);
        assert_eq!(
            la[0].get("text").and_then(|v| v.as_str()),
            Some("for A only")
        );

        // No pointer, no override → 400…
        state.config.write().await.coder_workspace = String::new();
        let e = memory_get(ws(), q_none()).await.unwrap_err();
        assert_eq!(e.0, axum::http::StatusCode::BAD_REQUEST);
        // …but an explicit override works with no pointer at all.
        let ok = memory_get(ws(), q_a()).await.unwrap().0;
        assert_eq!(
            ok.get("learnings")
                .and_then(|v| v.as_array())
                .unwrap()
                .len(),
            1
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn memory_drop_serializes_under_lock() {
        // A concurrent drop + append must not lose the append (per-store lock
        // holds across the drop's read-modify-write).
        let tmp = std::env::temp_dir().join(format!("ninfier-memtest-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let ws = tmp.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let state: S =
            std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        state.config.write().await.coder_workspace = ws.to_string_lossy().into_owned();
        let ws = || AxumState(state.clone());

        // Seed one entry.
        let r = memory_set(
            ws(),
            Json(json!({"learning": {"text": "seed", "kind": "tip"}})),
        )
        .await
        .unwrap()
        .0;
        let seed_id = r.get("learnings").and_then(|v| v.as_array()).unwrap()[0]
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();

        // Fire many appends and drops concurrently; the final state must equal
        // seed + (appends that weren't dropped) — nothing but the dropped id
        // may be lost.
        let mut handles = vec![];
        for i in 0..8 {
            let s = state.clone();
            handles.push(tokio::spawn(async move {
                let r = memory_set(
                    AxumState(s.clone()),
                    Json(json!({"learning": {"text": format!("append-{i}"), "kind": "tip"}})),
                )
                .await
                .unwrap()
                .0;
                // Every response is a consistent full snapshot.
                assert!(
                    !r.get("learnings")
                        .and_then(|v| v.as_array())
                        .unwrap()
                        .is_empty()
                );
            }));
            if i % 2 == 0 {
                let s = state.clone();
                let id = seed_id.clone();
                handles.push(tokio::spawn(async move {
                    let r = memory_set(AxumState(s), Json(json!({"dropLearningId": id})))
                        .await
                        .unwrap()
                        .0;
                    assert!(
                        !r.get("learnings")
                            .and_then(|v| v.as_array())
                            .unwrap()
                            .is_empty()
                    );
                }));
            }
        }
        for h in handles {
            h.await.unwrap();
        }
        let final_state = memory_get(ws(), Query(MemQuery { workspace: None }))
            .await
            .unwrap()
            .0;
        let learnings = final_state
            .get("learnings")
            .and_then(|v| v.as_array())
            .unwrap();
        // All 8 appends must survive (only the seed was a drop target).
        let texts: Vec<String> = learnings
            .iter()
            .map(|l| {
                l.get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        for i in 0..8 {
            assert!(texts.contains(&format!("append-{i}")), "append-{i} lost");
        }
        // No duplicate ids from concurrent appends.
        let ids: Vec<&str> = learnings
            .iter()
            .filter_map(|l| l.get("id").and_then(|v| v.as_str()))
            .collect();
        let unique: std::collections::HashSet<_> = ids.iter().copied().collect();
        assert_eq!(ids.len(), unique.len(), "duplicate ids under concurrency");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
