//! GPU stats via nvidia-smi.

// Rust guideline compliant 2026-07-28

use crate::types::{GpuApp, GpuStats};
use std::process::Stdio;

/// Hard cap per `nvidia-smi` query (the sidecar uses 3s for `execFile`;
/// 5s here). `status()` calls this on every poll, so a wedged driver must
/// not be able to hang the polling task behind a hung child.
const NVSMI_TIMEOUT_MS: u64 = 5_000;

/// Wait for a spawned child, collecting its output, giving up (and killing
/// it) if it does not exit by `deadline`. Runs on a blocking thread.
fn wait_capped(
    mut child: std::process::Child,
    deadline: std::time::Instant,
) -> Option<std::process::Output> {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Helper to ensure a spawned child process is killed and reaped if not needed.
fn cleanup_child(child: Option<std::process::Child>) {
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// A parsed `nvidia-smi --query-gpu` line: name, used/total VRAM (MiB),
/// utilization percent, and power draw (watts). Each numeric field is `None`
/// on a non-numeric cell (e.g. `[N/A]`) — that alone doesn't fail the parse,
/// see `parse_gpu_csv`.
struct GpuCsvLine {
    name: String,
    mem_used_mib: Option<u64>,
    mem_total_mib: Option<u64>,
    util_pct: Option<u64>,
    power_draw_w: Option<f64>,
}

/// Parse the first line of `--query-gpu=name,memory.used,memory.total,
/// utilization.gpu,power.draw --format=csv,noheader,nounits` output (one
/// line per GPU; only the first is used, as before the refactor). Requires
/// the first four cells to be present — a malformed first line means the
/// whole query is treated as failed, matching the pre-refactor behavior. The
/// trailing power.draw cell is optional (older drivers may omit the field
/// entirely, yielding a short line) and, like the other numeric fields,
/// best-effort (non-numeric cell -> None, not a failure).
fn parse_gpu_csv(stdout: &str) -> Option<GpuCsvLine> {
    let line = stdout.lines().next()?;
    let cols: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
    if cols.len() < 4 {
        return None;
    }
    let name = cols[0].to_string();
    let mem_used_mib = cols[1].parse::<u64>().ok();
    let mem_total_mib = cols[2].parse::<u64>().ok();
    let util_pct = cols[3].parse::<u64>().ok();
    let power_draw_w = cols.get(4).and_then(|s| s.parse::<f64>().ok());
    Some(GpuCsvLine {
        name,
        mem_used_mib,
        mem_total_mib,
        util_pct,
        power_draw_w,
    })
}

/// Parse `--query-compute-apps=pid,process_name,used_memory` CSV output.
/// A line missing any of the three fields (blank separator lines, an
/// unexpected header) is skipped, not fatal.
fn parse_apps_csv(stdout: &str) -> Vec<GpuApp> {
    stdout
        .lines()
        .filter_map(|l| {
            let mut c = l.split(',').map(|s| s.trim());
            let (pid_str, pname, mem_str) = (c.next()?, c.next()?, c.next()?);
            let pid = pid_str.parse::<u32>().ok()?;
            let mem_mib = mem_str.parse::<u64>().unwrap_or(0);
            Some(GpuApp {
                pid,
                name: pname.to_string(),
                mem_mib,
            })
        })
        .collect()
}

pub async fn gpu_stats() -> GpuStats {
    gpu_stats_for_device(None).await
}

pub async fn gpu_stats_for_device(gpu_id: Option<u32>) -> GpuStats {
    fn fallback() -> GpuStats {
        GpuStats {
            available: false,
            name: None,
            mem_used_mib: None,
            mem_total_mib: None,
            util_pct: None,
            power_draw_w: None,
            apps: vec![],
        }
    }
    let result = tokio::task::spawn_blocking(move || {
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
        let mut gpu_cmd = std::process::Command::new("nvidia-smi");
        if let Some(id) = gpu_id {
            gpu_cmd.arg(format!("--id={id}"));
        }
        gpu_cmd.args([
            "--query-gpu=name,memory.used,memory.total,utilization.gpu,power.draw",
            "--format=csv,noheader,nounits",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        let gpu_child = match gpu_cmd.spawn() {
            Ok(c) => c,
            Err(_) => return fallback,
        };

        let mut apps_cmd = std::process::Command::new("nvidia-smi");
        if let Some(id) = gpu_id {
            apps_cmd.arg(format!("--id={id}"));
        }
        apps_cmd.args([
            "--query-compute-apps=pid,process_name,used_memory",
            "--format=csv,noheader,nounits",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        let apps_child = apps_cmd.spawn().ok();

        let gpu_deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(NVSMI_TIMEOUT_MS);
        let Some(gpu_out) = wait_capped(gpu_child, gpu_deadline).filter(|o| o.status.success()) else {
            cleanup_child(apps_child);
            return fallback;
        };
        let gpu_line = match parse_gpu_csv(&String::from_utf8_lossy(&gpu_out.stdout)) {
            Some(v) => v,
            None => {
                cleanup_child(apps_child);
                return fallback;
            }
        };

        // Apps are secondary: a failed/late apps query degrades to an empty
        // list, exactly like the pre-refactor fallback.
        let apps_deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(NVSMI_TIMEOUT_MS);
        let apps = match apps_child {
            Some(child) => wait_capped(child, apps_deadline)
                .filter(|o| o.status.success())
                .map(|o| parse_apps_csv(&String::from_utf8_lossy(&o.stdout)))
                .unwrap_or_default(),
            None => vec![],
        };

        GpuStats {
            available: true,
            name: Some(gpu_line.name),
            mem_used_mib: gpu_line.mem_used_mib,
            mem_total_mib: gpu_line.mem_total_mib,
            util_pct: gpu_line.util_pct,
            power_draw_w: gpu_line.power_draw_w,
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
    serde_json::to_value(g).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_gpu_csv_full_line() {
        let line =
            parse_gpu_csv("NVIDIA GeForce RTX 5090, 3072, 32768, 47, 320.50\n").unwrap();
        assert_eq!(line.name, "NVIDIA GeForce RTX 5090");
        assert_eq!(line.mem_used_mib, Some(3072));
        assert_eq!(line.mem_total_mib, Some(32768));
        assert_eq!(line.util_pct, Some(47));
        assert_eq!(line.power_draw_w, Some(320.50));
    }

    #[test]
    fn parse_gpu_csv_multi_gpu_first_line_wins() {
        let line =
            parse_gpu_csv("GPU A, 1, 2, 3, 4\nGPU B, 5, 6, 7, 8\n").unwrap();
        assert_eq!(line.name, "GPU A");
        assert_eq!(
            (line.mem_used_mib, line.mem_total_mib, line.util_pct, line.power_draw_w),
            (Some(1), Some(2), Some(3), Some(4.0))
        );
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
        let line =
            parse_gpu_csv("GPU A, [N/A], 32768, [N/A], [N/A]\n").unwrap();
        assert_eq!(line.name, "GPU A");
        assert_eq!(line.mem_used_mib, None);
        assert_eq!(line.mem_total_mib, Some(32768));
        assert_eq!(line.util_pct, None);
        assert_eq!(line.power_draw_w, None);
    }

    #[test]
    fn parse_gpu_csv_missing_power_column_is_none_not_failure() {
        // Older drivers/GPUs may omit power.draw entirely — the line is one
        // cell short, not malformed, since the first four cells are intact.
        let line = parse_gpu_csv("GPU A, 1, 2, 3\n").unwrap();
        assert_eq!(line.name, "GPU A");
        assert_eq!(line.power_draw_w, None);
    }

    #[test]
    fn parse_apps_csv_skips_blank_and_short_lines() {
        let apps = parse_apps_csv("1234, python3, 512\n\n5678, node, 256\nmalformed\n");
        assert_eq!(apps.len(), 2);
        assert_eq!(
            (apps[0].pid, apps[0].name.as_str(), apps[0].mem_mib),
            (1234, "python3", 512)
        );
        assert_eq!(
            (apps[1].pid, apps[1].name.as_str(), apps[1].mem_mib),
            (5678, "node", 256)
        );
    }

    #[test]
    fn parse_apps_csv_skips_na_pid_and_headers() {
        let input = "pid, process_name, used_memory\n[N/A], python3, 512\n1234, node, 256\n";
        let apps = parse_apps_csv(input);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].pid, 1234);
        assert_eq!(apps[0].name, "node");
        assert_eq!(apps[0].mem_mib, 256);
    }

    #[test]
    fn parse_apps_csv_empty_when_no_apps() {
        assert!(parse_apps_csv("").is_empty());
        assert!(parse_apps_csv("\n").is_empty());
    }

    /// End-to-end: gpu_stats() must spawn nvidia-smi with piped stdio and
    /// surface real data. Guards the regression where spawned children
    /// inherited the server's stdout, so `wait_with_output` returned empty
    /// output and every poll reported `available: false`. Skips when
    /// nvidia-smi is missing *or* the driver is unreachable — e.g. CI
    /// runners, and containers where the host binary leaks onto PATH but no
    /// GPU driver is visible inside the container.
    #[tokio::test]
    async fn gpu_stats_live_when_nvidia_smi_present() {
        let driver_alive = std::process::Command::new("nvidia-smi")
            .arg("-L")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !driver_alive {
            return; // no usable nvidia-smi here — nothing to test against
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
            power_draw_w: Some(250.5),
            apps: vec![GpuApp {
                pid: 9,
                name: "x".into(),
                mem_mib: 4,
            }],
        };
        let v = gpu_value(&g);
        assert_eq!(v["available"], true);
        assert_eq!(v["memUsedMiB"], 1);
        assert_eq!(v["powerDrawW"], 250.5);
        assert_eq!(v["apps"][0]["memMiB"], 4);
    }
}
