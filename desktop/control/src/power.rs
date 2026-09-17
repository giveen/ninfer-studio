//! GPU energy tracking: a background sampler that turns `nvidia-smi`'s
//! instantaneous power draw into a per-day kWh rollup, so the Usage tab can
//! show an estimated electricity cost alongside token usage.
//!
//! This is a continuous physical quantity, not a discrete per-request event
//! like `usage.rs`'s proxied-request log — so instead of an append-only
//! JSONL, the whole rollup lives in one small rewritten-in-place JSON file
//! (`power-log.json`), the same shape as `config.json`/`profile.json`.
//!
//! Caveat, surfaced in the UI rather than hidden: `nvidia-smi` reports total
//! board power, not power attributable to a single process. Sampling only
//! while an engine is `Running`/`External` AND its usage log is actively
//! growing (see `run_power_sampler`) is the closest approximation to "cost
//! of actually serving requests" available without per-process GPU power
//! accounting, which the driver doesn't expose — a model sitting loaded but
//! idle between requests still draws real board power, but that idle draw
//! isn't request-driven usage and would otherwise inflate the estimate.

use crate::engine::S;
use crate::gpu::gpu_stats_for_device;
use crate::memstore::day_string;
use crate::types::EngineState;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

/// How often the sampler wakes up and (when an engine is active) folds one
/// more increment of energy into today's bucket.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(15);

fn power_log_path(state: &S) -> PathBuf {
    state.data_dir.join("power-log.json")
}

fn usage_log_path(state: &S) -> PathBuf {
    state.data_dir.join("usage-log.jsonl")
}

async fn read_power_log(state: &S) -> BTreeMap<String, f64> {
    let path = power_log_path(state);
    let Ok(raw) = tokio::fs::read_to_string(&path).await else {
        return BTreeMap::new();
    };
    #[derive(serde::Deserialize)]
    struct Doc {
        #[serde(default, rename = "byDay")]
        by_day: BTreeMap<String, f64>,
    }
    match serde_json::from_str::<Doc>(&raw) {
        Ok(d) => d
            .by_day
            .into_iter()
            .filter(|(_, v)| v.is_finite() && *v >= 0.0)
            .collect(),
        Err(e) => {
            tracing::warn!("corrupted power-log.json: {e}; backing up to power-log.json.bad");
            let bad_path = state.data_dir.join("power-log.json.bad");
            let _ = tokio::fs::rename(&path, &bad_path).await;
            BTreeMap::new()
        }
    }
}

pub(crate) async fn write_power_log(state: &S, by_day: &BTreeMap<String, f64>) {
    let clean: BTreeMap<String, f64> = by_day
        .iter()
        .filter(|(_, v)| v.is_finite() && **v >= 0.0)
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    let doc = serde_json::json!({ "byDay": clean });
    if let Ok(text) = serde_json::to_string(&doc) {
        let _ = tokio::fs::create_dir_all(&state.data_dir).await;
        let _ = crate::atomic_write(&power_log_path(state), &text).await;
    }
}

/// Read the log and sum kWh for days in `[cutoff_day, today]` (inclusive,
/// lexicographic — `YYYY-MM-DD` sorts chronologically). Used by
/// `usage::usage_stats` to fold energy into the same window as token usage.
pub(crate) async fn energy_kwh_by_day(state: &S, cutoff_day: &str) -> BTreeMap<String, f64> {
    let today = day_string(crate::types::now_ms());
    read_power_log(state)
        .await
        .into_iter()
        .filter(|(day, _)| day.as_str() >= cutoff_day && day.as_str() <= today.as_str())
        .collect()
}

/// Pure decision: does this tick count as "the engine is doing something"?
/// Yes when the log at `path` changed size since `last` was recorded for
/// that same path — no baseline (first tick, or the path just changed)
/// means "not yet known", not "flowing".
fn log_is_flowing(last: &Option<(String, u64)>, path: &str, len: u64) -> bool {
    match last {
        Some((last_path, prev_len)) => last_path == path && *prev_len != len,
        None => false,
    }
}

/// Spawn the background sampling loop. Fire-and-forget: started once at boot
/// (`lib.rs::init_state`) and runs for the life of the process. Every error
/// path (GPU query failure, no power reading, disk write failure) just skips
/// that tick — this must never panic or block anything else in the server.
///
/// Sampling occurs only while an engine is `Running` or `External`, and active
/// request inference is detected via growth of the usage log (`usage-log.jsonl`).
pub(crate) async fn run_power_sampler(state: S) {
    let mut by_day = read_power_log(&state).await;
    // Tracks the usage log's size across ticks so a tick only counts when
    // request completions were logged since the last tick.
    let mut last_log: Option<(String, u64)> = None;
    let mut last_tick = std::time::Instant::now();

    loop {
        tokio::time::sleep(SAMPLE_INTERVAL).await;
        let now_inst = std::time::Instant::now();
        let elapsed_secs = now_inst.duration_since(last_tick).as_secs_f64();
        last_tick = now_inst;

        let running = {
            let eng = state.engine.read().await;
            matches!(eng.state, EngineState::Running | EngineState::External)
        };
        if !running {
            continue;
        }

        let usage_path_buf = usage_log_path(&state);
        let usage_path = usage_path_buf.to_string_lossy().to_string();
        let Ok(meta) = tokio::fs::metadata(&usage_path_buf).await else {
            continue;
        };
        let len = meta.len();
        let flowing = log_is_flowing(&last_log, &usage_path, len);
        last_log = Some((usage_path, len));
        if !flowing {
            continue;
        }

        let gpu_id = {
            let last = state.last_start.read().await;
            last.as_ref().and_then(|l| l.profile.device)
        };

        let g = gpu_stats_for_device(gpu_id).await;
        if !g.available {
            continue;
        }
        let Some(watts) = g.power_draw_w else {
            continue;
        };
        if !watts.is_finite() || watts <= 0.0 {
            continue;
        }

        let wh = watts * (elapsed_secs / 3600.0);
        let day = day_string(crate::types::now_ms());
        *by_day.entry(day).or_insert(0.0) += wh / 1000.0;
        write_power_log(&state, &by_day).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::State;
    use std::sync::Arc;

    struct TempState {
        state: S,
        dir: PathBuf,
    }

    impl std::ops::Deref for TempState {
        type Target = S;
        fn deref(&self) -> &Self::Target {
            &self.state
        }
    }

    impl Drop for TempState {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn temp_state() -> TempState {
        let dir = std::env::temp_dir().join(format!(
            "ninfier-power-test-{}",
            crate::memstore::mem_rand_suffix()
        ));
        let state = Arc::new(State::new(dir.clone(), PathBuf::from("."), None));
        TempState { state, dir }
    }

    #[test]
    fn no_flow_without_a_prior_baseline() {
        assert!(!log_is_flowing(&None, "/data/usage-log.jsonl", 100));
    }

    #[test]
    fn flow_only_when_the_same_log_changed_size() {
        let last = Some(("/data/usage-log.jsonl".to_string(), 100));
        assert!(
            !log_is_flowing(&last, "/data/usage-log.jsonl", 100),
            "unchanged size is idle, not flow"
        );
        assert!(
            log_is_flowing(&last, "/data/usage-log.jsonl", 150),
            "grew — a request was served"
        );
        assert!(
            log_is_flowing(&last, "/data/usage-log.jsonl", 10),
            "shrank via rotation — still activity"
        );
        assert!(
            !log_is_flowing(&last, "/data/other.log", 999),
            "a different log (restart) has no baseline yet"
        );
    }

    #[tokio::test]
    async fn energy_window_sums_only_days_on_or_after_cutoff() {
        let state = temp_state();
        let today = day_string(crate::types::now_ms());
        let mut by_day = BTreeMap::new();
        by_day.insert("2026-09-01".to_string(), 1.0);
        by_day.insert(today.clone(), 2.5);
        by_day.insert("2099-12-31".to_string(), 99.0); // future-dated entry
        write_power_log(&state, &by_day).await;

        let windowed = energy_kwh_by_day(&state, "2026-09-01").await;
        assert!(!windowed.contains_key("2099-12-31"), "future date must be excluded");
        assert_eq!(windowed.get(&today).copied(), Some(2.5));
    }

    #[tokio::test]
    async fn missing_power_log_yields_empty_window() {
        let state = temp_state();
        let windowed = energy_kwh_by_day(&state, "2020-01-01").await;
        assert!(windowed.is_empty());
    }

    #[tokio::test]
    async fn corrupted_power_log_backs_up_and_returns_empty() {
        let state = temp_state();
        let path = power_log_path(&state);
        let _ = tokio::fs::create_dir_all(&state.data_dir).await;
        let _ = tokio::fs::write(&path, "{ invalid json ").await;

        let read_res = read_power_log(&state).await;
        assert!(read_res.is_empty());

        let bad_path = state.data_dir.join("power-log.json.bad");
        assert!(bad_path.exists(), "corrupted file must be renamed to .bad");
    }

    #[tokio::test]
    async fn nan_and_infinite_power_values_are_rejected() {
        let state = temp_state();
        let mut by_day = BTreeMap::new();
        by_day.insert("2026-09-17".to_string(), f64::NAN);
        by_day.insert("2026-09-18".to_string(), f64::INFINITY);
        by_day.insert("2026-09-19".to_string(), 1.25);
        write_power_log(&state, &by_day).await;

        let read_res = read_power_log(&state).await;
        assert_eq!(read_res.len(), 1);
        assert_eq!(read_res.get("2026-09-19").copied(), Some(1.25));
    }
}
