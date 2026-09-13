//! Chat's Agent Mode settings: the tool-tier toggle plus the Memory/
//! Reflection/Deep-research capability toggles (`AgentTab.tsx`). Each is a
//! plain boolean persisted to `config.json` via `coder::persist_bool_setting`
//! — same read-merge-write shape Coder's Safe Mode/Sandbox/Commit Approval
//! already use, just for a different `AppSettings` field. See
//! `types/settings.rs` for field docs.

use crate::coder::persist_bool_setting;
use crate::engine::S;
use axum::extract::State as AxumState;
use axum::Json;
use serde_json::{json, Value};

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
}
