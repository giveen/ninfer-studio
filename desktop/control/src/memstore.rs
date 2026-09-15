//! Shared file-level primitives for a `learnings.jsonl` memory
//! store. Both Coder's per-workspace stores (`coder::memory`, one directory
//! per slugged workspace) and Chat's single global store (`chat::memory`,
//! one fixed directory) are just directories in this exact shape — this
//! module owns the on-disk format and the read/write/lock logic so the two
//! callers can never drift apart.

use crate::engine::S;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// Read a memory file, returning `def` when it doesn't exist.
pub async fn read_mem_file(dir: &Path, name: &str, def: &str) -> String {
    match tokio::fs::read_to_string(dir.join(name)).await {
        Ok(t) => t,
        Err(_) => def.to_string(),
    }
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b_len = b.chars().count();
    if b_len == 0 { return a.chars().count(); }
    let mut cache: Vec<usize> = (1..=b_len).collect();
    let mut result = b_len;
    for (i, a_char) in a.chars().enumerate() {
        result = i + 1;
        let mut distance_b = i;
        for (j, b_char) in b.chars().enumerate() {
            let cost = if a_char == b_char { 0 } else { 1 };
            let distance_a = distance_b + cost;
            distance_b = cache[j];
            result = std::cmp::min(result + 1, std::cmp::min(distance_a, distance_b + 1));
            cache[j] = result;
        }
    }
    result
}

pub async fn read_learnings(dir: &Path) -> Vec<Value> {
    let raw = read_mem_file(dir, "learnings.jsonl", "").await;
    let entries: Vec<Value> = raw.split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();

    // Stores (component, scope, target_key, verified_index)
    let mut shadowed: Vec<(String, String, String, usize)> = Vec::new();
    let mut verified = Vec::new();

    for entry in entries {
        let comp = entry.get("component").and_then(|v| v.as_str()).unwrap_or("");
        let scope = entry.get("scope").and_then(|v| v.as_str()).unwrap_or("");
        let key = entry.get("target_key").and_then(|v| v.as_str()).unwrap_or("");

        if comp.is_empty() && scope.is_empty() && key.is_empty() {
            verified.push(entry);
        } else {
            let mut found_idx = None;
            for s in &shadowed {
                if s.0 == comp && s.1 == scope && levenshtein(&s.2, key) <= 2 {
                    found_idx = Some(s.3);
                    break;
                }
            }

            if let Some(idx) = found_idx {
                verified[idx] = entry;
            } else {
                shadowed.push((comp.to_string(), scope.to_string(), key.to_string(), verified.len()));
                verified.push(entry);
            }
        }
    }

    verified
}

/// Create the memory dir and write a file.
pub async fn write_mem_file(dir: &Path, name: &str, content: &str) -> Result<(), (StatusCode, Json<Value>)> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("mkdir failed: {e}")}))))?;
    tokio::fs::write(dir.join(name), content)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("write failed: {e}")}))))?;
    Ok(())
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC) — the same shape as Node's
/// `new Date().toISOString()` (Hinnant's civil-from-days algorithm).
pub fn iso_now() -> (String, u64) {
    let (secs, ms_part) = {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        (ms / 1000, ms % 1000)
    };
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(secs / 86_400);
    (
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60, ms_part
        ),
        secs * 1000 + ms_part,
    )
}

/// `YYYY-MM-DD` (UTC) for a unix-ms timestamp — the calendar-day bucket key
/// used by usage-log aggregation (active days, heatmap, daily trend).
pub fn day_string(ms: u64) -> String {
    let (y, m, d) = civil_from_days(ms / 1000 / 86_400);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Hinnant's `civil_from_days`: days since 1970-01-01 → (year, month, day).
fn civil_from_days(days: u64) -> (i64, u32, u32) {
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (mp as i64 + if mp < 10 { 3 } else { -9 }) as u32;
    let y = yoe as i64 + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

/// 5-char base36 suffix for learning ids — cheap entropy, no extra dep
/// (the sidecar uses `Math.random().toString(36).slice(2, 7)`).
pub fn mem_rand_suffix() -> String {
    use std::sync::atomic::AtomicU64;
    static CTR: AtomicU64 = AtomicU64::new(0x2545F4914F6CDD1D);
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let n = now_ns
        .wrapping_mul(0x9E3779B97F4A7C15)
        .wrapping_add(CTR.fetch_add(0x9E3779B97F4A7C15, Ordering::SeqCst));
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    (0..5).map(|i| ALPHABET[((n >> (6 + 6 * i)) % 36) as usize] as char).collect()
}

/// Per-store mutation lock: a POST is a read-modify-write (a drop rewrites
/// the whole JSONL), so concurrent writers to the same store must serialize
/// or a stale rewrite can clobber a newer append. Keyed by store dir so
/// distinct stores (different workspaces, or Coder vs Chat) never contend.
pub fn mem_lock(state: &S, store: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = state.memory_locks.lock().unwrap();
    map.entry(store.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// `{learnings}` — the shape every memory GET (and the tail of every
/// memory POST) returns.
pub async fn read_bank_and_learnings(dir: &Path) -> Value {
    let learnings = read_learnings(dir).await;
    json!({"learnings": learnings})
}

/// Apply the standard POST body shape to `dir` under its store lock, then
/// return the refreshed `{learnings}`. At most one of the two
/// fields is expected per call, matching every existing caller:
///   `{ learning: {...} }` append one structured learning
///   `{ dropLearningId }`  drop a single learning (file rewritten, rest kept)
pub async fn apply_memory_update(state: &S, dir: &Path, req: &Value) -> Result<Value, (StatusCode, Json<Value>)> {
    let store_key = dir.to_string_lossy().into_owned();
    let store_lock = mem_lock(state, &store_key);
    let _guard = store_lock.lock().await;
    if let Some(learning) = req.get("learning").and_then(|v| v.as_object())
        && let Some(text) = learning.get("text").and_then(|v| v.as_str())
    {
        let (ts, now_ms) = iso_now();
        let entry = json!({
            "id": format!("l_{now_ms}_{}", mem_rand_suffix()),
            "component": learning.get("component").and_then(|v| v.as_str()).unwrap_or(""),
            "scope": learning.get("scope").and_then(|v| v.as_str()).unwrap_or(""),
            "target_key": learning.get("target_key").and_then(|v| v.as_str()).unwrap_or(""),
            "value": learning.get("value").and_then(|v| v.as_str()).unwrap_or(""),
            "text": text,
            "kind": learning.get("kind").and_then(|v| v.as_str()).unwrap_or("tip"),
            "provenance": learning.get("provenance").and_then(|v| v.as_str()).unwrap_or(""),
            "task": learning.get("task").and_then(|v| v.as_str()).unwrap_or(""),
            "ts": ts,
        });
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("mkdir failed: {e}")}))))?;
        use tokio::io::AsyncWriteExt as _;
        let mut f = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("learnings.jsonl"))
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("append failed: {e}")}))))?;
        let line = format!("{}\n", serde_json::to_string(&entry).unwrap_or_default());
        f.write_all(line.as_bytes())
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("append failed: {e}")}))))?;
        let _ = f.sync_all().await;
    }
    if let Some(drop_id) = req.get("dropLearningId").and_then(|v| v.as_str()) {
        let keep: Vec<Value> = read_learnings(dir)
            .await
            .into_iter()
            .filter(|l| l.get("id").and_then(|v| v.as_str()) != Some(drop_id))
            .collect();
        let content = if keep.is_empty() {
            String::new()
        } else {
            keep.iter()
                .map(|l| serde_json::to_string(l).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n")
                + "\n"
        };
        write_mem_file(dir, "learnings.jsonl", &content).await?;
    }

    Ok(read_bank_and_learnings(dir).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_now_shape_matches_js_toisostring() {
        let (ts, ms) = iso_now();
        assert_eq!(ts.len(), 24);
        assert!(ts.ends_with('Z'));
        assert!(ts[4..5].contains('-') && ts[10..11].contains('T') && ts[13..14].contains(':'));
        assert!(ms > 1_700_000_000_000);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_454), (2026, 1, 1));
    }

    #[tokio::test]
    async fn apply_memory_update_round_trip() {
        let tmp = std::env::temp_dir().join(format!("ninfier-memstoretest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));

        let r = apply_memory_update(&state, &tmp, &json!({"learning": {"text": "a", "kind": "tip"}})).await.unwrap();
        let l0 = r.get("learnings").and_then(|v| v.as_array()).unwrap()[0].clone();
        assert!(l0.get("id").and_then(|v| v.as_str()).unwrap().starts_with("l_"));
        assert_eq!(l0.get("text").and_then(|v| v.as_str()), Some("a"));

        let id = l0.get("id").and_then(|v| v.as_str()).unwrap().to_string();
        let r3 = apply_memory_update(&state, &tmp, &json!({"dropLearningId": id})).await.unwrap();
        assert_eq!(r3.get("learnings").and_then(|v| v.as_array()).unwrap().len(), 0);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn test_fuzzy_shadowing() {
        let tmp = std::env::temp_dir().join(format!("ninfier-memstore-fuzzy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));

        // 1. Add first learning
        apply_memory_update(&state, &tmp, &json!({"learning": {"text": "npm", "kind": "tip", "component": "general", "scope": "repo", "target_key": "packageManager"}})).await.unwrap();
        
        // 2. Add second learning with fuzzy matched key
        let r = apply_memory_update(&state, &tmp, &json!({"learning": {"text": "pnpm", "kind": "tip", "component": "general", "scope": "repo", "target_key": "package_manager"}})).await.unwrap();
        
        let learnings = r.get("learnings").and_then(|v| v.as_array()).unwrap();
        assert_eq!(learnings.len(), 1, "The second learning should have shadowed the first");
        assert_eq!(learnings[0].get("text").and_then(|v| v.as_str()), Some("pnpm"));

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
