//! Chat's Agent Mode settings: the tool-tier toggle plus the Memory/
//! Reflection/Deep-research capability toggles (`AgentTab.tsx`). Each is a
//! plain boolean persisted to `config.json` via `coder::persist_bool_setting`
//! — same read-merge-write shape Coder's Safe Mode/Sandbox/Commit Approval
//! already use, just for a different `AppSettings` field. See
//! `types/settings.rs` for field docs.

use crate::coder::persist_bool_setting;
use crate::engine::S;
use crate::memstore::{apply_memory_update, read_bank_and_learnings};
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use std::path::PathBuf;

pub async fn agent_research_get(AxumState(state): AxumState<S>) -> Json<Value> {
    Json(json!({"enabled": state.config.read().await.chat_agent_research}))
}

pub async fn agent_research_set(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Json<Value> {
    if let Some(enabled) = req.get("enabled").and_then(|v| v.as_bool()) {
        persist_bool_setting(&state, |c, v| c.chat_agent_research = v, enabled).await;
    }
    Json(json!({"enabled": state.config.read().await.chat_agent_research}))
}

pub async fn memory_enabled_get(AxumState(state): AxumState<S>) -> Json<Value> {
    Json(json!({"enabled": state.config.read().await.chat_memory_enabled}))
}

pub async fn memory_enabled_set(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Json<Value> {
    if let Some(enabled) = req.get("enabled").and_then(|v| v.as_bool()) {
        persist_bool_setting(&state, |c, v| c.chat_memory_enabled = v, enabled).await;
    }
    Json(json!({"enabled": state.config.read().await.chat_memory_enabled}))
}

pub async fn reflection_enabled_get(AxumState(state): AxumState<S>) -> Json<Value> {
    Json(json!({"enabled": state.config.read().await.chat_reflection_enabled}))
}

pub async fn reflection_enabled_set(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Json<Value> {
    if let Some(enabled) = req.get("enabled").and_then(|v| v.as_bool()) {
        persist_bool_setting(&state, |c, v| c.chat_reflection_enabled = v, enabled).await;
    }
    Json(json!({"enabled": state.config.read().await.chat_reflection_enabled}))
}

pub async fn deep_research_enabled_get(AxumState(state): AxumState<S>) -> Json<Value> {
    Json(json!({"enabled": state.config.read().await.chat_deep_research_enabled}))
}

pub async fn deep_research_enabled_set(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Json<Value> {
    if let Some(enabled) = req.get("enabled").and_then(|v| v.as_bool()) {
        persist_bool_setting(&state, |c, v| c.chat_deep_research_enabled = v, enabled).await;
    }
    Json(json!({"enabled": state.config.read().await.chat_deep_research_enabled}))
}

/// `<DATA_DIR>/chat-memory` — one fixed global store, unlike Coder's
/// per-workspace slugged dirs (Chat has no workspace to key on).
fn chat_memory_dir(state: &S) -> PathBuf {
    state.data_dir.join("chat-memory")
}

/// GET /api/chat/memory — the global bank + learnings.
pub async fn memory_get(AxumState(state): AxumState<S>) -> Json<Value> {
    Json(read_bank_and_learnings(&chat_memory_dir(&state)).await)
}

/// POST /api/chat/memory — same body shape as `/api/coder/memory`
/// (`{bank}` / `{learning}` / `{dropLearningId}`), applied to the single
/// global chat store.
pub async fn memory_set(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let dir = chat_memory_dir(&state);
    Ok(Json(apply_memory_update(&state, &dir, &req).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::State;
    use axum::extract::State as AxumState;
    use std::sync::Arc;

    #[tokio::test]
    async fn agent_toggles_round_trip_and_default_to_off() {
        let tmp = std::env::temp_dir().join(format!("ninfier-chataagenttest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = Arc::new(State::new(tmp.clone(), tmp.clone(), None));
        let w = || AxumState(state.clone());

        assert_eq!(agent_research_get(w()).await["enabled"], false);
        assert_eq!(agent_research_set(w(), Json(json!({"enabled": true}))).await["enabled"], true);
        assert_eq!(agent_research_get(w()).await["enabled"], true);

        assert_eq!(memory_enabled_get(w()).await["enabled"], false);
        assert_eq!(memory_enabled_set(w(), Json(json!({"enabled": true}))).await["enabled"], true);

        assert_eq!(reflection_enabled_get(w()).await["enabled"], false);
        assert_eq!(reflection_enabled_set(w(), Json(json!({"enabled": true}))).await["enabled"], true);

        assert_eq!(deep_research_enabled_get(w()).await["enabled"], false);
        assert_eq!(deep_research_enabled_set(w(), Json(json!({"enabled": true}))).await["enabled"], true);

        // Persisted to config.json, not just in memory (pretty-printed, so
        // ": " with a space between key and value).
        let on_disk = tokio::fs::read_to_string(tmp.join("config.json")).await.unwrap();
        assert!(on_disk.contains("\"chatAgentResearch\": true"));
        assert!(on_disk.contains("\"chatMemoryEnabled\": true"));
        assert!(on_disk.contains("\"chatReflectionEnabled\": true"));
        assert!(on_disk.contains("\"chatDeepResearchEnabled\": true"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn memory_round_trip_is_one_global_store() {
        let tmp = std::env::temp_dir().join(format!("ninfier-chatmemtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = Arc::new(State::new(tmp.clone(), tmp.clone(), None));
        let w = || AxumState(state.clone());

        let empty = memory_get(w()).await.0;
        assert_eq!(empty.get("learnings").and_then(|v| v.as_array()).unwrap().len(), 0);

        let r = memory_set(w(), Json(json!({"learning": {"text": "user prefers terse replies", "kind": "tip"}})))
            .await
            .unwrap()
            .0;
        let l0 = r.get("learnings").and_then(|v| v.as_array()).unwrap()[0].clone();
        assert!(l0.get("id").and_then(|v| v.as_str()).unwrap().starts_with("l_"));
        assert_eq!(l0.get("text").and_then(|v| v.as_str()), Some("user prefers terse replies"));

        // Landed under the single fixed <DATA_DIR>/chat-memory store, not a slug.
        assert!(tmp.join("chat-memory").join("learnings.jsonl").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
