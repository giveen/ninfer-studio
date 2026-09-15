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
//! while an engine is `Running`/`External` AND its own log is actively
//! growing (see `run_power_sampler`) is the closest approximation to "cost
//! of actually serving requests" available without per-process GPU power
//! accounting, which the driver doesn't expose — a model sitting loaded but
//! idle between requests still draws real board power, but that idle draw
//! isn't request-driven usage and would otherwise inflate the estimate.

use crate::engine::S;
use crate::gpu::gpu_stats;
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

async fn read_power_log(state: &S) -> BTreeMap<String, f64> {
    let Ok(raw) = tokio::fs::read_to_string(power_log_path(state)).await else {
        return BTreeMap::new();
    };
    #[derive(serde::Deserialize)]
    struct Doc {
        #[serde(default, rename = "byDay")]
        by_day: BTreeMap<String, f64>,
    }
    serde_json::from_str::<Doc>(&raw)
        .map(|d| d.by_day)
        .unwrap_or_default()
}

pub(crate) async fn write_power_log(state: &S, by_day: &BTreeMap<String, f64>) {
    let doc = serde_json::json!({ "byDay": by_day });
    if let Ok(text) = serde_json::to_string(&doc) {
        let _ = tokio::fs::create_dir_all(&state.data_dir).await;
        let _ = tokio::fs::write(power_log_path(state), text).await;
    }
}

/// Read the log and sum kWh for days in `[cutoff_day, today]` (inclusive,
/// lexicographic — `YYYY-MM-DD` sorts chronologically). Used by
/// `usage::usage_stats` to fold energy into the same window as token usage.
pub(crate) async fn energy_kwh_by_day(state: &S, cutoff_day: &str) -> BTreeMap<String, f64> {
    read_power_log(state)
        .await
        .into_iter()
        .filter(|(day, _)| day.as_str() >= cutoff_day)
        .collect()
}

/// Spawn the background sampling loop. Fire-and-forget: started once at boot
/// (`lib.rs::init_state`) and runs for the life of the process. Every error
/// path (GPU query failure, no power reading, disk write failure) just skips
/// that tick — this must never panic or block anything else in the server.
/// Pure decision: does this tick count as "the engine is doing something"?
/// Yes when the log at `path` changed size since `last` was recorded for
/// that same path — no baseline (first tick, or the path just changed
/// because the engine restarted) means "not yet known", not "flowing".
fn log_is_flowing(last: &Option<(String, u64)>, path: &str, len: u64) -> bool {
    match last {
        Some((last_path, prev_len)) => last_path == path && *prev_len != len,
        None => false,
    }
}

pub(crate) async fn run_power_sampler(state: S) {
    let mut by_day = read_power_log(&state).await;
    // Tracks the engine log's size across ticks so a tick only counts when
    // the log actually grew (or shrank via rotation — either way, activity)
    // since the last one — the "is the engine actually doing something"
    // signal, reset whenever the log path itself changes (a restart).
    let mut last_log: Option<(String, u64)> = None;
    loop {
        tokio::time::sleep(SAMPLE_INTERVAL).await;
        let (running, log_path) = {
            let eng = state.engine.read().await;
            (
                matches!(eng.state, EngineState::Running | EngineState::External),
                eng.log_path.clone(),
            )
        };
        if !running {
            continue;
        }
        let Some(log_path) = log_path else { continue };
        let Ok(meta) = tokio::fs::metadata(&log_path).await else {
            continue;
        };
        let len = meta.len();
        let flowing = log_is_flowing(&last_log, &log_path, len);
        last_log = Some((log_path, len));
        if !flowing {
            continue;
        }
        let g = gpu_stats().await;
        if !g.available {
            continue;
        }
        let Some(watts) = g.power_draw_w else {
            continue;
        };
        if watts <= 0.0 {
            continue;
        }
        let wh = watts * (SAMPLE_INTERVAL.as_secs_f64() / 3600.0);
        let day = day_string(crate::usage::now_ms());
        *by_day.entry(day).or_insert(0.0) += wh / 1000.0;
        write_power_log(&state, &by_day).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::State;

    #[test]
    fn no_flow_without_a_prior_baseline() {
        assert!(!log_is_flowing(&None, "/data/engine-8080.log", 100));
    }

    #[test]
    fn flow_only_when_the_same_log_changed_size() {
        let last = Some(("/data/engine-8080.log".to_string(), 100));
        assert!(
            !log_is_flowing(&last, "/data/engine-8080.log", 100),
            "unchanged size is idle, not flow"
        );
        assert!(
            log_is_flowing(&last, "/data/engine-8080.log", 150),
            "grew — a request was served"
        );
        assert!(
            log_is_flowing(&last, "/data/engine-8080.log", 10),
            "shrank via rotation — still activity"
        );
        assert!(
            !log_is_flowing(&last, "/data/engine-8081.log", 999),
            "a different log (restart) has no baseline yet"
        );
    }
    use std::sync::Arc;

    fn temp_state() -> S {
        let dir = std::env::temp_dir().join(format!(
            "ninfier-power-test-{}",
            crate::memstore::mem_rand_suffix()
        ));
        Arc::new(State::new(dir, PathBuf::from("."), None))
    }

    #[tokio::test]
    async fn energy_window_sums_only_days_on_or_after_cutoff() {
        let state = temp_state();
        let mut by_day = BTreeMap::new();
        by_day.insert("2026-09-01".to_string(), 1.0);
        by_day.insert("2026-09-10".to_string(), 2.5);
        by_day.insert("2026-09-14".to_string(), 0.75);
        write_power_log(&state, &by_day).await;

        let windowed = energy_kwh_by_day(&state, "2026-09-10").await;
        let total: f64 = windowed.values().sum();
        assert_eq!(windowed.len(), 2);
        assert!((total - 3.25).abs() < 1e-9);
    }

    #[tokio::test]
    async fn missing_power_log_yields_empty_window() {
        let state = temp_state();
        let windowed = energy_kwh_by_day(&state, "2020-01-01").await;
        assert!(windowed.is_empty());
    }
}
