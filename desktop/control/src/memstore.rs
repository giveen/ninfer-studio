//! Shared file-level primitives for a `learnings.jsonl` memory
//! store. Both Coder's per-workspace stores (`coder::memory`, one directory
//! per slugged workspace) and Chat's single global store (`chat::memory`,
//! one fixed directory) are just directories in this exact shape — this
//! module owns the on-disk format and the read/write/lock logic so the two
//! callers can never drift apart.

use crate::engine::S;
use axum::Json;
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;

/// Read a memory file, returning empty string when it doesn't exist (`NotFound`).
pub async fn read_mem_file(dir: &Path, name: &str) -> std::io::Result<String> {
    match tokio::fs::read_to_string(dir.join(name)).await {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e),
    }
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b_len = b.chars().count();
    if b_len == 0 {
        return a.chars().count();
    }
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

pub async fn read_learnings(dir: &Path) -> Result<Vec<Value>, (StatusCode, Json<Value>)> {
    let raw = read_mem_file(dir, "learnings.jsonl").await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("read learnings failed: {e}")})),
        )
    })?;
    let entries: Vec<Value> = raw
        .split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();

    // Stores (component, scope, target_key, verified_index)
    let mut shadowed: Vec<(String, String, String, usize)> = Vec::new();
    let mut verified = Vec::new();

    for entry in entries {
        let comp = entry
            .get("component")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let scope = entry.get("scope").and_then(|v| v.as_str()).unwrap_or("");
        let key = entry
            .get("target_key")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if comp.is_empty() && scope.is_empty() && key.is_empty() {
            verified.push(entry);
        } else {
            let mut found_idx = None;
            for s in &shadowed {
                if s.0 == comp && s.1 == scope {
                    let k1 = &s.2;
                    let k2 = key;
                    let k1_chars = k1.chars().count();
                    let k2_chars = k2.chars().count();
                    // Require exact match for short keys or CLI flags to prevent shadowing
                    let is_match = if k1_chars < 10
                        || k2_chars < 10
                        || k1.starts_with('-')
                        || k2.starts_with('-')
                    {
                        k1 == k2
                    } else {
                        // Scale threshold by character length: ~1 edit per 8 characters
                        levenshtein(k1, k2) <= (k1_chars.min(k2_chars) / 8)
                    };

                    if is_match {
                        found_idx = Some(s.3);
                        break;
                    }
                }
            }

            if let Some(idx) = found_idx {
                verified[idx] = entry;
            } else {
                shadowed.push((
                    comp.to_string(),
                    scope.to_string(),
                    key.to_string(),
                    verified.len(),
                ));
                verified.push(entry);
            }
        }
    }

    Ok(verified)
}

/// Create the memory dir and write a file atomically.
pub async fn write_mem_file(
    dir: &Path,
    name: &str,
    content: &str,
) -> Result<(), (StatusCode, Json<Value>)> {
    tokio::fs::create_dir_all(dir).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("mkdir failed: {e}")})),
        )
    })?;
    // 0600 (not the plain `atomic_write`'s umask-dependent default): bank.md
    // and learnings.jsonl accumulate project-sensitive text the memory bank
    // was built to remember, same class of content as config.json's secrets.
    crate::atomic_write_secret(&dir.join(name), content)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("write failed: {e}")})),
            )
        })?;
    Ok(())
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC) — the same shape as Node's
/// `new Date().toISOString()` (Hinnant's civil-from-days algorithm).
pub fn iso_now() -> (String, u64) {
    let ms = crate::types::now_ms();
    let (secs, ms_part) = (ms / 1000, ms % 1000);
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(secs / 86_400);
    (
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            y,
            m,
            d,
            rem / 3600,
            (rem % 3600) / 60,
            rem % 60,
            ms_part
        ),
        ms,
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

/// 5-char base36 suffix for learning ids with uniform rejection sampling.
pub fn mem_rand_suffix() -> String {
    use std::sync::atomic::AtomicU64;
    static CTR: AtomicU64 = AtomicU64::new(0x2545F4914F6CDD1D);
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut state = now_ns
        .wrapping_mul(0x9E3779B97F4A7C15)
        .wrapping_add(CTR.fetch_add(0x9E3779B97F4A7C15, Ordering::SeqCst));
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut suffix = String::with_capacity(5);
    for _ in 0..5 {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
        let mut val = (state >> 32) as u32;
        while val >= (u32::MAX - (u32::MAX % 36)) {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
            val = (state >> 32) as u32;
        }
        suffix.push(ALPHABET[(val % 36) as usize] as char);
    }
    suffix
}

/// Per-store mutation lock: a POST is a read-modify-write (a drop rewrites
/// the whole JSONL), so concurrent writers to the same store must serialize.
/// Keyed by canonical store dir so path spellings match, and unused entries
/// (`strong_count == 1`) are evicted to prevent unbounded lock map growth.
pub fn mem_lock(state: &S, dir: impl AsRef<Path>) -> Arc<tokio::sync::Mutex<()>> {
    let dir = dir.as_ref();
    let key = dir
        .canonicalize()
        .unwrap_or_else(|_| dir.to_path_buf())
        .to_string_lossy()
        .into_owned();
    let mut map = state.memory_locks.lock();
    map.retain(|_, lock| Arc::strong_count(lock) > 1);
    map.entry(key)
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// `{bank, learnings}` — the shape every memory GET (and the tail of every
/// memory POST) returns.
pub async fn read_bank_and_learnings(dir: &Path) -> Result<Value, (StatusCode, Json<Value>)> {
    let bank = read_mem_file(dir, "bank.md").await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("read bank failed: {e}")})),
        )
    })?;
    let learnings = read_learnings(dir).await?;
    Ok(json!({"bank": bank, "learnings": learnings}))
}

/// Apply the standard POST body shape to `dir` under its store lock, then
/// return the refreshed `{bank, learnings}`:
///   `{ bank }`            replace the markdown bank wholesale
///   `{ learning: {...} }` append one structured learning
///   `{ dropLearningId }`  drop a single learning (file rewritten, rest kept)
pub async fn apply_memory_update(
    state: &S,
    dir: &Path,
    req: &Value,
) -> Result<Value, (StatusCode, Json<Value>)> {
    let store_lock = mem_lock(state, dir);
    let _guard = store_lock.lock().await;

    if let Some(bank) = req.get("bank").and_then(|v| v.as_str()) {
        write_mem_file(dir, "bank.md", bank).await?;
    }

    if let Some(learning_val) = req.get("learning") {
        let Some(learning) = learning_val.as_object() else {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "'learning' must be a JSON object"})),
            ));
        };
        let text = learning
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .unwrap_or("");
        if text.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "'learning.text' is required and cannot be empty"})),
            ));
        }
        if text.chars().count() > 10_000 {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "'learning.text' exceeds maximum length of 10000 characters"})),
            ));
        }
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
        tokio::fs::create_dir_all(dir).await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("mkdir failed: {e}")})),
            )
        })?;
        use tokio::io::AsyncWriteExt as _;
        let learnings_path = dir.join("learnings.jsonl");
        let mut open_opts = tokio::fs::OpenOptions::new();
        open_opts.create(true).append(true);
        // 0600 on creation (same rationale as `write_mem_file`'s
        // `atomic_write_secret`); this only takes effect for a *new* file, so
        // also re-assert it below for one already on disk from before this
        // fix, since `.append()` reopens an existing file as-is otherwise.
        #[cfg(unix)]
        open_opts.mode(0o600);
        let mut f = open_opts.open(&learnings_path).await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("append failed: {e}")})),
            )
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = tokio::fs::set_permissions(&learnings_path, std::fs::Permissions::from_mode(0o600)).await;
        }
        let line = format!("{}\n", serde_json::to_string(&entry).unwrap_or_default());
        f.write_all(line.as_bytes()).await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("append failed: {e}")})),
            )
        })?;
        let _ = f.sync_all().await;
    }

    if let Some(drop_id) = req.get("dropLearningId").and_then(|v| v.as_str()) {
        let raw = read_mem_file(dir, "learnings.jsonl").await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("read learnings failed during drop: {e}")})),
            )
        })?;
        let mut keep_lines = Vec::new();
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                if v.get("id").and_then(|v| v.as_str()) == Some(drop_id) {
                    continue;
                }
            }
            keep_lines.push(trimmed);
        }
        let content = if keep_lines.is_empty() {
            String::new()
        } else {
            keep_lines.join("\n") + "\n"
        };
        write_mem_file(dir, "learnings.jsonl", &content).await?;
    }

    read_bank_and_learnings(dir).await
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

        let r = apply_memory_update(
            &state,
            &tmp,
            &json!({"learning": {"text": "a", "kind": "tip"}}),
        )
        .await
        .unwrap();
        let l0 = r.get("learnings").and_then(|v| v.as_array()).unwrap()[0].clone();
        assert!(
            l0.get("id")
                .and_then(|v| v.as_str())
                .unwrap()
                .starts_with("l_")
        );
        assert_eq!(l0.get("text").and_then(|v| v.as_str()), Some("a"));

        let id = l0.get("id").and_then(|v| v.as_str()).unwrap().to_string();
        let r3 = apply_memory_update(&state, &tmp, &json!({"dropLearningId": id}))
            .await
            .unwrap();
        assert_eq!(
            r3.get("learnings")
                .and_then(|v| v.as_array())
                .unwrap()
                .len(),
            0
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn test_fuzzy_shadowing() {
        let tmp =
            std::env::temp_dir().join(format!("ninfier-memstore-fuzzy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));

        // 1. Add first learning
        apply_memory_update(&state, &tmp, &json!({"learning": {"text": "npm", "kind": "tip", "component": "general", "scope": "repo", "target_key": "packageManager"}})).await.unwrap();

        // 2. Add second learning with fuzzy matched key (dist 1, len 14)
        let r = apply_memory_update(&state, &tmp, &json!({"learning": {"text": "pnpm", "kind": "tip", "component": "general", "scope": "repo", "target_key": "packagemanager"}})).await.unwrap();

        let learnings = r.get("learnings").and_then(|v| v.as_array()).unwrap();
        assert_eq!(
            learnings.len(),
            1,
            "The second learning should have shadowed the first"
        );
        assert_eq!(
            learnings[0].get("text").and_then(|v| v.as_str()),
            Some("pnpm")
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn drop_learning_preserves_unparseable_lines() {
        let tmp = std::env::temp_dir().join(format!("ninfier-memstore-unparseable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));

        let file_path = tmp.join("learnings.jsonl");
        let line1 = r#"{"id": "l_1", "text": "valid 1", "kind": "tip"}"#;
        let line2 = r#"RAW_CORRUPT_NON_JSON_LINE"#;
        let line3 = r#"{"id": "l_2", "text": "valid 2", "kind": "tip"}"#;
        std::fs::write(&file_path, format!("{line1}\n{line2}\n{line3}\n")).unwrap();

        let r = apply_memory_update(&state, &tmp, &json!({"dropLearningId": "l_1"}))
            .await
            .unwrap();
        let learnings = r.get("learnings").and_then(|v| v.as_array()).unwrap();
        assert_eq!(learnings.len(), 1);
        assert_eq!(learnings[0].get("id").and_then(|v| v.as_str()), Some("l_2"));

        let disk_content = std::fs::read_to_string(&file_path).unwrap();
        assert!(disk_content.contains(line2), "Unparseable line must be preserved on disk");
        assert!(disk_content.contains("l_2"));
        assert!(!disk_content.contains("l_1"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn post_learning_payload_validation() {
        let tmp = std::env::temp_dir().join(format!("ninfier-memstore-val-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));

        // Missing text
        let err = apply_memory_update(&state, &tmp, &json!({"learning": {"kind": "tip"}}))
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);

        // Empty text
        let err = apply_memory_update(&state, &tmp, &json!({"learning": {"text": "  "}}))
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);

        // Over-long text
        let err = apply_memory_update(&state, &tmp, &json!({"learning": {"text": "a".repeat(10_001)}}))
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn mem_lock_canonicalization_and_eviction() {
        let tmp = std::env::temp_dir().join(format!("ninfier-memstore-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));

        let lock1 = mem_lock(&state, &tmp);
        let dot_path = tmp.join(".");
        let lock2 = mem_lock(&state, &dot_path);
        assert!(Arc::ptr_eq(&lock1, &lock2), "Lock keying must canonicalize paths");

        drop(lock1);
        drop(lock2);
        let _lock3 = mem_lock(&state, &tmp);
        assert_eq!(state.memory_locks.lock().len(), 1, "Unused lock entries should be evicted");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn memory_bank_files_are_written_0600() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = std::env::temp_dir().join(format!("ninfier-memstore-perms-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let state: S = Arc::new(crate::types::State::new(tmp.clone(), tmp.clone(), None));

        write_mem_file(&tmp, "bank.md", "# notes").await.unwrap();
        apply_memory_update(&state, &tmp, &json!({"learning": {"text": "remember this"}}))
            .await
            .unwrap();

        for name in ["bank.md", "learnings.jsonl"] {
            let mode = std::fs::metadata(tmp.join(name)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{name} should be owner-only (0600), got {mode:o}");
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
