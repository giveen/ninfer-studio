//! GPU stats via nvidia-smi.

// Rust guideline compliant 2026-07-28

use crate::types::{GpuApp, GpuStats};
use serde_json::json;
use std::process::Stdio;

/// Hard cap per `nvidia-smi` query (the sidecar uses 3s for `execFile`;
/// 5s here). `status()` calls this on every poll, so a wedged driver must
/// not be able to hang the polling task behind a hung child.
const NVSMI_TIMEOUT_MS: u64 = 5_000;

/// Wait for a spawned child, collecting its output, giving up (and killing
/// it) if it does not exit by `deadline`. Runs on a blocking thread.
fn wait_capped(mut child: std::process::Child, deadline: std::time::Instant) -> Option<std::process::Output> {
    loop {
        match child.try_wait().ok().flatten() {
            Some(_) => return child.wait_with_output().ok(),
            None => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
}

/// Parse the first line of `--query-gpu=name,memory.used,memory.total,
/// utilization.gpu --format=csv,noheader,nounits` output (one line per
/// GPU; only the first is used, as before the refactor). Requires all four
/// cells to be present — a malformed first line means the whole query is
/// treated as failed, matching the pre-refactor behavior. Numeric fields
/// are best-effort (non-numeric cell -> None, not a failure).
fn parse_gpu_csv(stdout: &str) -> Option<(String, Option<u64>, Option<u64>, Option<u64>)> {
    let line = stdout.lines().next()?;
    let cols = line.split(',').map(|s| s.trim());
    let (name, used, total, util) =
        match (cols.clone().next(), cols.clone().nth(1), cols.clone().nth(2), cols.clone().nth(3)) {
            (Some(a), Some(b), Some(c), Some(d)) => (a, b, c, d),
            _ => return None,
        };
    Some((
        name.to_string(),
        used.parse::<u64>().ok(),
        total.parse::<u64>().ok(),
        util.parse::<u64>().ok(),
    ))
}

/// Parse `--query-compute-apps=pid,process_name,used_memory` CSV output.
/// A line missing any of the three fields (blank separator lines, an
/// unexpected header) is skipped, not fatal.
fn parse_apps_csv(stdout: &str) -> Vec<GpuApp> {
    stdout
        .lines()
        .filter_map(|l| {
            let mut c = l.split(',').map(|s| s.trim());
            let (pid, pname, mem) = (c.next()?, c.next()?, c.next()?);
            if pid.is_empty() {
                return None;
            }
            Some(GpuApp {
                pid: pid.parse().unwrap_or(0),
                name: pname.to_string(),
                mem_mib: mem.parse().unwrap_or(0),
            })
        })
        .collect()
}

pub async fn gpu_stats() -> GpuStats {
    fn fallback() -> GpuStats {
        GpuStats {
            available: false,
            name: None,
            mem_used_mib: None,
            mem_total_mib: None,
            util_pct: None,
            apps: vec![],
        }
    }
    let result = tokio::task::spawn_blocking(|| {
        let fallback = fallback();
        // nvidia-smi accepts only ONE `--query-*` switch per invocation
        // ("Only one --query-* switch can be used at a time"), so GPU
        // metrics and the compute-apps table cannot come from a single
        // process. Both queries are therefore launched concurrently in this
        // one blocking task: wall time is one query, not two sequential
        // ones (the pre-refactor shape).
        // Stdio must be piped (not inherited) for `wait_with_output` to
        // return the query result — inherited output would leak into this
        // process's own stdout and yield an empty `Output`.
        let gpu_child = match std::process::Command::new("nvidia-smi")
            .args([
                "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                "--format=csv,noheader,nounits",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => return fallback,
        };
        let apps_child = std::process::Command::new("nvidia-smi")
            .args([
                "--query-compute-apps=pid,process_name,used_memory",
                "--format=csv,noheader,nounits",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .ok();

        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(NVSMI_TIMEOUT_MS);
        let Some(gpu_out) = wait_capped(gpu_child, deadline).filter(|o| o.status.success()) else {
            return fallback;
        };
        let (name, mem_used_mib, mem_total_mib, util_pct) =
            match parse_gpu_csv(&String::from_utf8_lossy(&gpu_out.stdout)) {
                Some(v) => v,
                None => return fallback,
            };

        // Apps are secondary: a failed/late apps query degrades to an empty
        // list, exactly like the pre-refactor fallback.
        let apps = match apps_child {
            Some(child) => wait_capped(child, deadline)
                .filter(|o| o.status.success())
                .map(|o| parse_apps_csv(&String::from_utf8_lossy(&o.stdout)))
                .unwrap_or_default(),
            None => vec![],
        };

        GpuStats {
            available: true,
            name: Some(name),
            mem_used_mib,
            mem_total_mib,
            util_pct,
            apps,
        }
    })
    .await;
    match result {
        Ok(g) => g,
        Err(_) => fallback(),
    }
}

/// Serialize GpuStats to a JSON value (same field names as the web types).
pub fn gpu_value(g: &GpuStats) -> serde_json::Value {
    json!({
        "available": g.available,
        "name": g.name,
        "memUsedMiB": g.mem_used_mib,
        "memTotalMiB": g.mem_total_mib,
        "utilPct": g.util_pct,
        "apps": g.apps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_gpu_csv_full_line() {
        let (name, used, total, util) =
            parse_gpu_csv("NVIDIA GeForce RTX 5090, 3072, 32768, 47\n").unwrap();
        assert_eq!(name, "NVIDIA GeForce RTX 5090");
        assert_eq!(used, Some(3072));
        assert_eq!(total, Some(32768));
        assert_eq!(util, Some(47));
    }

    #[test]
    fn parse_gpu_csv_multi_gpu_first_line_wins() {
        let (name, used, total, util) = parse_gpu_csv("GPU A, 1, 2, 3\nGPU B, 4, 5, 6\n").unwrap();
        assert_eq!(name, "GPU A");
        assert_eq!((used, total, util), (Some(1), Some(2), Some(3)));
    }

    #[test]
    fn parse_gpu_csv_malformed_yields_none() {
        // No output, blank first line, or fewer than four cells: the whole
        // query counts as failed (pre-refactor semantics).
        assert!(parse_gpu_csv("").is_none());
        assert!(parse_gpu_csv("\n").is_none());
        assert!(parse_gpu_csv("onlyname\n").is_none());
        assert!(parse_gpu_csv("A, 1, 2\n").is_none());
    }

    #[test]
    fn parse_gpu_csv_non_numeric_cells_are_none_not_failure() {
        let (name, used, total, util) =
            parse_gpu_csv("GPU A, [N/A], 32768, [N/A]\n").unwrap();
        assert_eq!(name, "GPU A");
        assert_eq!(used, None);
        assert_eq!(total, Some(32768));
        assert_eq!(util, None);
    }

    #[test]
    fn parse_apps_csv_skips_blank_and_short_lines() {
        let apps = parse_apps_csv("1234, python3, 512\n\n5678, node, 256\nmalformed\n");
        assert_eq!(apps.len(), 2);
        assert_eq!((apps[0].pid, apps[0].name.as_str(), apps[0].mem_mib), (1234, "python3", 512));
        assert_eq!((apps[1].pid, apps[1].name.as_str(), apps[1].mem_mib), (5678, "node", 256));
    }

    #[test]
    fn parse_apps_csv_empty_when_no_apps() {
        assert!(parse_apps_csv("").is_empty());
        assert!(parse_apps_csv("\n").is_empty());
    }

    /// End-to-end: gpu_stats() must spawn nvidia-smi with piped stdio and
    /// surface real data. Guards the regression where spawned children
    /// inherited the server's stdout, so `wait_with_output` returned empty
    /// output and every poll reported `available: false`. Skips on machines
    /// without nvidia-smi (e.g. CI runners).
    #[tokio::test]
    async fn gpu_stats_live_when_nvidia_smi_present() {
        if std::process::Command::new("which")
            .arg("nvidia-smi")
            .output()
            .map(|o| !o.status.success())
            .unwrap_or(true)
        {
            return; // no nvidia-smi here — nothing to test against
        }
        let g = gpu_stats().await;
        assert!(
            g.available,
            "nvidia-smi is installed and healthy, so gpu_stats must succeed (name={:?})",
            g.name
        );
        assert!(g.name.is_some() && !g.name.as_ref().unwrap().is_empty());
    }

    #[test]
    fn gpu_value_field_names_match_web_types() {
        let g = GpuStats {
            available: true,
            name: Some("GPU".into()),
            mem_used_mib: Some(1),
            mem_total_mib: Some(2),
            util_pct: Some(3),
            apps: vec![GpuApp { pid: 9, name: "x".into(), mem_mib: 4 }],
        };
        let v = gpu_value(&g);
        assert_eq!(v["available"], true);
        assert_eq!(v["memUsedMiB"], 1);
        assert_eq!(v["apps"][0]["memMiB"], 4);
    }
}
