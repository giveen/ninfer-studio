//! GPU stats via nvidia-smi.

// Rust guideline compliant 2026-07-28

use crate::types::GpuStats;
use serde_json::json;

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
        let gpu = std::process::Command::new("nvidia-smi")
            .args([
                "--query-gpu=name,memory.used,memory.total,utilization.gpu",
                "--format=csv,noheader,nounits",
            ])
            .output();
        let Ok(gpu) = gpu else {
            return fallback;
        };
        if !gpu.status.success() {
            return fallback;
        }
        let stdout = String::from_utf8_lossy(&gpu.stdout);
        let line = stdout.lines().next().unwrap_or("");
        let mut cols = line.split(',').map(|s| s.trim().to_string());
        let (name, mem_used_mib, mem_total_mib, util_pct) =
            match (cols.next(), cols.next(), cols.next(), cols.next()) {
                (Some(a), Some(b), Some(c), Some(d)) => (
                    a,
                    b.parse::<u64>().ok(),
                    c.parse::<u64>().ok(),
                    d.parse::<u64>().ok(),
                ),
                _ => return fallback,
            };

        let apps = std::process::Command::new("nvidia-smi")
            .args([
                "--query-compute-apps=pid,process_name,used_memory",
                "--format=csv,noheader,nounits",
            ])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .filter_map(|l| {
                        let mut c = l.split(',').map(|s| s.trim());
                        let (pid, pname, mem) = (c.next()?, c.next()?, c.next()?);
                        Some(crate::types::GpuApp {
                            pid: pid.parse().unwrap_or(0),
                            name: pname.to_string(),
                            mem_mib: mem.parse().unwrap_or(0),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

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
