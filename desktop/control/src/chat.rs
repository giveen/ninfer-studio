//! Chat's Agent Mode settings: the tool-tier toggle plus the Memory/
//! Reflection/Deep-research capability toggles (`AgentTab.tsx`). Each is a
//! plain boolean persisted to `config.json` via `coder::persist_bool_setting`
//! — same read-merge-write shape Coder's Safe Mode/Sandbox/Commit Approval
//! already use, just for a different `AppSettings` field. See
//! `types/settings.rs` for field docs.

use crate::coder::persist_bool_setting;
use crate::engine::S;
use crate::memstore::{apply_memory_update, read_bank_and_learnings};
use axum::Json;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::path::PathBuf;

macro_rules! bool_toggle {
    ($get_fn:ident, $set_fn:ident, $field:ident) => {
        pub async fn $get_fn(AxumState(state): AxumState<S>) -> Json<Value> {
            Json(json!({ "enabled": state.config.read().await.$field }))
        }

        pub async fn $set_fn(
            AxumState(state): AxumState<S>,
            Json(req): Json<Value>,
        ) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
            let Some(enabled) = req.get("enabled").and_then(|v| v.as_bool()) else {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "field 'enabled' must be a boolean" })),
                ));
            };
            persist_bool_setting(&state, |c, v| c.$field = v, enabled).await;
            Ok(Json(json!({ "enabled": state.config.read().await.$field })))
        }
    };
}

bool_toggle!(agent_research_get, agent_research_set, chat_agent_research);
bool_toggle!(memory_enabled_get, memory_enabled_set, chat_memory_enabled);
bool_toggle!(reflection_enabled_get, reflection_enabled_set, chat_reflection_enabled);
bool_toggle!(deep_research_enabled_get, deep_research_enabled_set, chat_deep_research_enabled);

/// `<DATA_DIR>/chat-memory` — one fixed global store, unlike Coder's
/// per-workspace slugged dirs (Chat has no workspace to key on).
fn chat_memory_dir(state: &S) -> PathBuf {
    state.data_dir.join("chat-memory")
}

/// GET /api/chat/memory — the global bank + learnings.
pub async fn memory_get(
    AxumState(state): AxumState<S>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state.config.read().await.chat_memory_enabled {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "chat memory is disabled" })),
        ));
    }
    Ok(Json(read_bank_and_learnings(&chat_memory_dir(&state)).await?))
}

/// POST /api/chat/memory — same body shape as `/api/coder/memory`
/// (`{bank}` / `{learning}` / `{dropLearningId}`), applied to the single
/// global chat store.
pub async fn memory_set(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !state.config.read().await.chat_memory_enabled {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "chat memory is disabled" })),
        ));
    }
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
        let tmp = std::env::temp_dir().join(format!("ninfier-chattest1-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = Arc::new(State::new(tmp.clone(), tmp.clone(), None));
        let w = || AxumState(state.clone());

        assert_eq!(agent_research_get(w()).await["enabled"], false);
        assert_eq!(
            agent_research_set(w(), Json(json!({"enabled": true}))).await.unwrap()["enabled"],
            true
        );
        assert_eq!(agent_research_get(w()).await["enabled"], true);

        // Non-boolean returns 400 BAD_REQUEST
        let bad = agent_research_set(w(), Json(json!({"enabled": "yes"}))).await;
        assert_eq!(bad.unwrap_err().0, StatusCode::BAD_REQUEST);

        assert_eq!(memory_enabled_get(w()).await["enabled"], false);
        assert_eq!(
            memory_enabled_set(w(), Json(json!({"enabled": true}))).await.unwrap()["enabled"],
            true
        );

        assert_eq!(reflection_enabled_get(w()).await["enabled"], false);
        assert_eq!(
            reflection_enabled_set(w(), Json(json!({"enabled": true}))).await.unwrap()["enabled"],
            true
        );

        assert_eq!(deep_research_enabled_get(w()).await["enabled"], false);
        assert_eq!(
            deep_research_enabled_set(w(), Json(json!({"enabled": true}))).await.unwrap()["enabled"],
            true
        );

        // Persisted to config.json
        let on_disk = tokio::fs::read_to_string(tmp.join("config.json"))
            .await
            .unwrap();
        assert!(on_disk.contains("\"chatAgentResearch\": true"));
        assert!(on_disk.contains("\"chatMemoryEnabled\": true"));
        assert!(on_disk.contains("\"chatReflectionEnabled\": true"));
        assert!(on_disk.contains("\"chatDeepResearchEnabled\": true"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn memory_gate_and_bank_round_trip() {
        let tmp = std::env::temp_dir().join(format!("ninfier-chattest2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = Arc::new(State::new(tmp.clone(), tmp.clone(), None));
        let w = || AxumState(state.clone());

        // Initially disabled -> returns 403 FORBIDDEN
        assert_eq!(memory_get(w()).await.unwrap_err().0, StatusCode::FORBIDDEN);
        assert_eq!(
            memory_set(w(), Json(json!({"bank": "rule"}))).await.unwrap_err().0,
            StatusCode::FORBIDDEN
        );

        // Enable memory
        memory_enabled_set(w(), Json(json!({"enabled": true}))).await.unwrap();

        let empty = memory_get(w()).await.unwrap().0;
        assert_eq!(empty["learnings"].as_array().unwrap().len(), 0);
        assert_eq!(empty["bank"].as_str(), Some(""));

        // Set bank
        let b = memory_set(w(), Json(json!({"bank": "# Global Rules\n- Be concise"})))
            .await
            .unwrap()
            .0;
        assert_eq!(b["bank"].as_str(), Some("# Global Rules\n- Be concise"));

        // Set learning
        let r = memory_set(
            w(),
            Json(json!({"learning": {"text": "user prefers terse replies", "kind": "tip"}})),
        )
        .await
        .unwrap()
        .0;
        let l0 = r["learnings"].as_array().unwrap()[0].clone();
        assert!(l0["id"].as_str().unwrap().starts_with("l_"));
        assert_eq!(l0["text"].as_str(), Some("user prefers terse replies"));

        // Verify disk files
        assert!(tmp.join("chat-memory").join("bank.md").exists());
        assert!(tmp.join("chat-memory").join("learnings.jsonl").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}

