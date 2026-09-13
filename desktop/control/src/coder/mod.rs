//! Coder harness endpoints, one file per concern:
//!   exec      — shell execution, safe mode, bwrap sandbox, background jobs
//!   fs        — workspace tree + file read/write/edit/patch/base64
//!   grep      — content grep + glob listing
//!   search    — ranked repo search (cached symbol index), repo map, git diff
//!   web       — SSRF-guarded web fetch + DuckDuckGo search
//!   browser   — built-in headless browser (Obscura engine) for JS-heavy pages
//!   memory    — per-workspace self-improving memory bank
//!   workspace — workspace pointer + host directory browsing (UI picker)
//!   common    — shared path resolution + tool permissions
//!
//! Every public handler/type is re-exported here so the router in `lib.rs`
//! (and `types.rs`'s `coder_perms`) keeps using `coder::…` paths unchanged.

// Rust guideline compliant 2026-07-28

mod browser;
mod common;
mod exec;
mod fs;
mod grep;
mod memory;
mod search;
mod web;
mod workspace;

pub use browser::{browser, BrowserSlot};
pub use common::{perms_approve, perms_get, perms_set, ApprovalTicket, CoderPerms, PermTier};
pub use exec::{
    bwrap_available, exec, job_get, job_kill, safe_mode_get, safe_mode_set, sandbox_get, sandbox_set, BgJob,
};
pub use fs::{fs_b64, fs_edit, fs_patch, fs_read, fs_write, tree};
pub use grep::{glob, grep};
pub use memory::{memory_get, memory_set, MemQuery};
pub use search::{diff, repo_map, search, SearchQuery, SymHit};
pub use web::{web_fetch, web_search};
pub use workspace::{dirs, workspace_get, workspace_set, WorkspaceReq, WorkspaceResp};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::S;
    use axum::Json;
    use serde_json::json;

    /// End-to-end contract test: workspace → write → read → edit → tree →
    /// glob → stateful exec → safe-mode block → dirs, all against a temp dir.
    #[tokio::test]
    async fn coder_round_trip() {
        use axum::extract::{Query, State as AxumState};
        use std::collections::HashMap;

        let tmp = std::env::temp_dir().join(format!("ninfier-coder-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let state: S = std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        state.config.write().await.coder_workspace = tmp.to_string_lossy().into_owned();
        let ws = || AxumState(state.clone());

        // write (creates parents) then read back
        let w = fs_write(ws(), Json(json!({"path": "sub/hello.txt", "content": "line1\nline2\n"})))
            .await
            .unwrap()
            .0;
        assert_eq!(w.get("created").and_then(|v| v.as_bool()), Some(true));
        let r = fs_read(ws(), Json(json!({"path": "sub/hello.txt"}))).await.unwrap().0;
        assert_eq!(r.get("content").and_then(|v| v.as_str()), Some("line1\nline2\n"));
        assert_eq!(r.get("truncated").and_then(|v| v.as_bool()), Some(false));

        // exact edit, then a whitespace-fuzzy edit
        let e = fs_edit(ws(), Json(json!({"path": "sub/hello.txt", "old": "line2", "new": "LINE2"})))
            .await
            .unwrap()
            .0;
        assert_eq!(e.get("replacements").and_then(|v| v.as_u64()), Some(1));
        let e2 = fs_edit(ws(), Json(json!({"path": "sub/hello.txt", "old": "\n  LINE2  \n", "new": "done"})))
            .await
            .unwrap()
            .0;
        assert_eq!(e2.get("replacements").and_then(|v| v.as_u64()), Some(1));
        // ambiguous exact edit is refused, not silently applied
        let e3 = fs_edit(ws(), Json(json!({"path": "sub/hello.txt", "old": "e", "new": "x"})))
            .await
            .unwrap()
            .0;
        assert_eq!(e3.get("replacements").and_then(|v| v.as_u64()), Some(0));

        // tree lists the new dir; glob `**` crosses directories, `*` does not
        let mut p = HashMap::new();
        p.insert("depth".to_string(), "2".to_string());
        let t = tree(ws(), Query(p)).await.unwrap().0;
        let names: Vec<&str> = t
            .get("nodes")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|n| n.get("name").and_then(|v| v.as_str()))
            .collect();
        assert!(names.contains(&"sub"));
        let g = glob(ws(), Json(json!({"pattern": "**/*.txt"}))).await.unwrap().0;
        let files: Vec<&str> = g
            .get("files")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(files.contains(&"sub/hello.txt"));
        let g2 = glob(ws(), Json(json!({"pattern": "*.txt"}))).await.unwrap().0;
        assert!(g2.get("files").and_then(|v| v.as_array()).unwrap().is_empty());

        // stateful exec: cd persists within a session id
        let x = exec(ws(), Json(json!({"command": "echo hi", "sessionId": "t1"}))).await.unwrap().0;
        assert_eq!(x.get("exitCode").and_then(|v| v.as_i64()), Some(0));
        assert!(x.get("stdout").and_then(|v| v.as_str()).unwrap().contains("hi"));
        let _ = exec(ws(), Json(json!({"command": "cd sub", "sessionId": "t1"}))).await.unwrap();
        let x2 = exec(ws(), Json(json!({"command": "pwd", "sessionId": "t1"}))).await.unwrap().0;
        assert!(x2.get("stdout").and_then(|v| v.as_str()).unwrap().trim().ends_with("sub"));
        // traversal escapes the workspace
        assert!(fs_read(ws(), Json(json!({"path": "../escape"}))).await.is_err());
        // safe mode blocks, and can be toggled
        let b = exec(ws(), Json(json!({"command": "rm -rf /"}))).await.unwrap().0;
        assert_eq!(b.get("blocked").and_then(|v| v.as_bool()), Some(true));
        let _ = safe_mode_set(ws(), Json(json!({"enabled": false}))).await;
        assert_eq!(safe_mode_get(ws()).await.0.get("enabled").and_then(|v| v.as_bool()), Some(false));
        let _ = safe_mode_set(ws(), Json(json!({"enabled": true}))).await;

        // b64 + dirs
        let b64 = fs_b64(ws(), Json(json!({"path": "sub/hello.txt"}))).await.unwrap().0;
        assert!(b64.get("dataUrl").and_then(|v| v.as_str()).unwrap().starts_with("data:application/octet-stream;base64,"));
        let d = dirs(Query(HashMap::from([("root".to_string(), tmp.to_string_lossy().into_owned())]))).await.0;
        let dirs: Vec<&str> = d
            .get("dirs")
            .and_then(|v| v.as_array())
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(dirs.contains(&"sub"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A `deny`-tiered tool or denied path is rejected at the endpoint
    /// itself — not only by the client dispatcher that normally decides
    /// whether to call it (e.g. an agent routing `bash` around a denied
    /// `write` tool must not be able to reach `fs_write` either).
    #[tokio::test]
    async fn perms_are_enforced_server_side() {
        use axum::extract::State as AxumState;

        let tmp = std::env::temp_dir().join(format!("ninfier-perms-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let state: S = std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        state.config.write().await.coder_workspace = tmp.to_string_lossy().into_owned();
        let ws = || AxumState(state.clone());

        // Defaults: nothing denied.
        let got = perms_get(ws()).await.0;
        assert_eq!(got.get("tools").and_then(|v| v.as_object()).map(|m| m.len()), Some(0));

        // Push a policy: bash denied outright, anything under "secret" denied by path.
        let _ = perms_set(ws(), Json(json!({"tools": {"bash": "deny"}, "denyPaths": ["secret"]}))).await;
        let got = perms_get(ws()).await.0;
        assert_eq!(got.get("tools").and_then(|v| v.get("bash")).and_then(|v| v.as_str()), Some("deny"));

        // bash is denied even though safe mode alone would have allowed "echo hi".
        assert!(exec(ws(), Json(json!({"command": "echo hi"}))).await.is_err());

        // write under the denied prefix is rejected; a sibling path still works.
        assert!(fs_write(ws(), Json(json!({"path": "secret/x.txt", "content": "no"}))).await.is_err());
        assert!(fs_write(ws(), Json(json!({"path": "ok/x.txt", "content": "yes"}))).await.is_ok());
        // exact-match on the denied prefix itself (no trailing content) is also rejected.
        assert!(fs_read(ws(), Json(json!({"path": "secret"}))).await.is_err());
        // unrelated read-only tools are unaffected.
        assert!(grep(ws(), Json(json!({"pattern": "yes"}))).await.is_ok());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// `ask` used to have zero server-side effect (only `deny`/`denyPaths`
    /// were enforced) — a call that skipped the approval dialog entirely was
    /// treated exactly like `allow`. Now it requires a valid, matching,
    /// single-use token minted by `perms_approve` at the moment a human
    /// approves.
    #[tokio::test]
    async fn ask_tier_requires_a_valid_approval_token() {
        use axum::extract::State as AxumState;

        let tmp = std::env::temp_dir().join(format!("ninfier-ask-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = std::sync::Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));
        state.config.write().await.coder_workspace = tmp.to_string_lossy().into_owned();
        let ws = || AxumState(state.clone());

        let _ = perms_set(ws(), Json(json!({"tools": {"write": "ask"}, "denyPaths": []}))).await;

        // No token at all: rejected.
        assert!(fs_write(ws(), Json(json!({"path": "a.txt", "content": "x"}))).await.is_err());
        assert!(!tmp.join("a.txt").exists());

        // Wrong tool's token: still rejected.
        let bash_token = perms_approve(ws(), Json(json!({"tool": "bash"}))).await.unwrap().0;
        let bash_token = bash_token.get("token").and_then(|v| v.as_str()).unwrap();
        assert!(fs_write(ws(), Json(json!({"path": "a.txt", "content": "x", "approvalToken": bash_token}))).await.is_err());

        // A matching approval lets the call through...
        let r = perms_approve(ws(), Json(json!({"tool": "write"}))).await.unwrap().0;
        let token = r.get("token").and_then(|v| v.as_str()).unwrap().to_string();
        assert!(fs_write(ws(), Json(json!({"path": "a.txt", "content": "x", "approvalToken": token}))).await.is_ok());
        assert!(tmp.join("a.txt").exists());

        // ...but only once: the same token is rejected on a second use.
        assert!(fs_write(ws(), Json(json!({"path": "a.txt", "content": "y", "approvalToken": token}))).await.is_err());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
