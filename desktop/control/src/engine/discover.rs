// Rust guideline compliant 2026-07-28

//! Discovery of externally-running `ninfer-serve` processes (/proc on Linux, tasklist+netstat on Windows).

/// Scan for running `ninfer-serve` processes.
#[allow(dead_code)]
pub async fn find_external_serve_pids() -> Vec<u32> {
    discover_engines()
        .await
        .into_iter()
        .map(|d| d.pid)
        .collect()
}

/// A locally-running ninfer-serve process discovered via /proc or tasklist/netstat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredEngine {
    pub pid: u32,
    pub port: Option<u16>,
    pub start_time: Option<u64>,
    /// cmdline args excluding the binary itself
    pub argv: Vec<String>,
    pub artifact: Option<String>,
}

/// Find locally-running ninfer-serve processes, with (pid, port, start_time, argv, artifact).
/// Linux: /proc scan (argv + port + starttime + socket inodes). Windows: tasklist + netstat
/// (argv unavailable without WMI — callers treat empty argv as "not readable").
pub async fn discover_engines() -> Vec<DiscoveredEngine> {
    #[cfg(not(windows))]
    {
        discover_engines_proc().await
    }
    #[cfg(windows)]
    {
        discover_engines_windows().await
    }
}

/// Parse raw process cmdline bytes (split on NUL bytes, lossy UTF-8 decoded).
/// Identifies `ninfer-serve` / `ninfer-serve.exe` (skipping wrapper launchers like `env`, `nice`, `numactl`),
/// and extracts `(args, bin_path, port, artifact)`.
pub fn parse_cmdline_bytes(
    raw: &[u8],
) -> Option<(Vec<String>, String, Option<u16>, Option<String>)> {
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<String> = raw
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();

    if parts.is_empty() {
        return None;
    }

    const WRAPPERS: &[&str] = &[
        "env", "nice", "stdbuf", "numactl", "sh", "bash", "taskset", "chrt", "ionice",
    ];

    let mut bin_idx = None;
    for (idx, part) in parts.iter().enumerate() {
        let p = std::path::Path::new(part);
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "ninfer-serve" || name == "ninfer-serve.exe" {
            bin_idx = Some(idx);
            break;
        }
        if WRAPPERS.contains(&name) || part.starts_with('-') {
            continue;
        }
        break;
    }

    let bin_idx = bin_idx?;
    let bin_path = parts[bin_idx].clone();
    let args: Vec<String> = parts.into_iter().skip(bin_idx + 1).collect();

    let mut port: Option<u16> = None;
    let mut artifact: Option<String> = None;
    let mut i = 0;

    while i < args.len() {
        let arg = &args[i];
        if (arg == "--port" || arg == "-p") && i + 1 < args.len() {
            if let Ok(p) = args[i + 1].parse::<u16>() {
                port = Some(p);
            }
            i += 2;
            continue;
        }
        if let Some(stripped) = arg.strip_prefix("--port=").or_else(|| arg.strip_prefix("-p=")) {
            if let Ok(p) = stripped.parse::<u16>() {
                port = Some(p);
            }
        }

        if (arg == "--model" || arg == "-m") && i + 1 < args.len() {
            if artifact.is_none() {
                artifact = Some(args[i + 1].clone());
            }
            i += 2;
            continue;
        }
        if let Some(stripped) = arg.strip_prefix("--model=").or_else(|| arg.strip_prefix("-m=")) {
            if artifact.is_none() {
                artifact = Some(stripped.to_string());
            }
        }

        if artifact.is_none()
            && !arg.starts_with('-')
            && (arg.ends_with(".ninfer")
                || arg.ends_with(".gguf")
                || arg.ends_with(".safetensors")
                || arg.ends_with(".bin"))
        {
            artifact = Some(arg.clone());
        }

        i += 1;
    }

    Some((args, bin_path, port, artifact))
}

/// Scan /proc for ninfer-serve processes and pull (pid, port, start_time, argv, artifact).
#[cfg(target_os = "linux")]
async fn discover_engines_proc() -> Vec<DiscoveredEngine> {
    use std::os::unix::fs::MetadataExt;
    let current_uid = std::fs::metadata("/proc/self").map(|m| m.uid()).ok();
    let mut out: Vec<DiscoveredEngine> = Vec::new();

    let Ok(entries) = tokio::fs::read_dir("/proc").await else {
        return out;
    };
    let mut it = entries;
    while let Ok(Some(entry)) = it.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let proc_path = entry.path();
        if let Ok(meta) = std::fs::metadata(&proc_path) {
            if let Some(uid) = current_uid {
                if meta.uid() != uid {
                    continue;
                }
            }
        } else {
            continue;
        }

        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };

        let Ok(cmdline_bytes) = tokio::fs::read(format!("/proc/{name}/cmdline")).await else {
            continue;
        };

        let Some((args, _bin_path, mut port, mut artifact)) = parse_cmdline_bytes(&cmdline_bytes) else {
            continue;
        };

        let start_time = get_proc_starttime(pid);

        // Resolve relative artifact path against process working directory
        if let Some(art) = artifact.as_ref() {
            if std::path::Path::new(art).is_relative() {
                if let Ok(cwd) = std::fs::read_link(format!("/proc/{name}/cwd")) {
                    artifact = Some(cwd.join(art).to_string_lossy().to_string());
                }
            }
        }

        // If port is missing or 0, attempt socket inode resolution via /proc/net/tcp
        if port.unwrap_or(0) == 0 {
            let socket_inodes = get_proc_socket_inodes(pid);
            if let Some(tcp_port) = parse_proc_net_tcp_listening_ports(&socket_inodes) {
                port = Some(tcp_port);
            }
        }

        out.push(DiscoveredEngine {
            pid,
            port,
            start_time,
            argv: args,
            artifact,
        });
    }

    out.sort_by(|a, b| a.port.cmp(&b.port).then_with(|| a.pid.cmp(&b.pid)));
    out
}

#[cfg(not(any(target_os = "linux", windows)))]
async fn discover_engines_proc() -> Vec<DiscoveredEngine> {
    Vec::new()
}

#[cfg(target_os = "linux")]
fn get_proc_starttime(pid: u32) -> Option<u64> {
    let stat_text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rparen = stat_text.rfind(')')?;
    let rest = &stat_text[rparen + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    fields.get(19)?.parse::<u64>().ok()
}

#[cfg(target_os = "linux")]
fn get_proc_socket_inodes(pid: u32) -> std::collections::HashSet<u64> {
    let mut inodes = std::collections::HashSet::new();
    let fd_dir = format!("/proc/{pid}/fd");
    let Ok(entries) = std::fs::read_dir(fd_dir) else {
        return inodes;
    };
    for entry in entries.flatten() {
        if let Ok(target) = std::fs::read_link(entry.path()) {
            let s = target.to_string_lossy();
            if let Some(stripped) = s.strip_prefix("socket:[") {
                if let Some(inode_str) = stripped.strip_suffix(']') {
                    if let Ok(inode) = inode_str.parse::<u64>() {
                        inodes.insert(inode);
                    }
                }
            }
        }
    }
    inodes
}

#[cfg(any(target_os = "linux", test))]
fn parse_tcp_listening_ports_from_text(content: &str, inodes: &std::collections::HashSet<u64>) -> Option<u16> {
    for line in content.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 {
            continue;
        }
        if fields[3] != "0A" {
            continue;
        }
        let Ok(inode) = fields[9].parse::<u64>() else {
            continue;
        };
        if inodes.contains(&inode) {
            if let Some((_, port_hex)) = fields[1].rsplit_once(':') {
                if let Ok(port) = u16::from_str_radix(port_hex, 16) {
                    if port > 0 {
                        return Some(port);
                    }
                }
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn parse_proc_net_tcp_listening_ports(inodes: &std::collections::HashSet<u64>) -> Option<u16> {
    for net_file in ["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(content) = std::fs::read_to_string(net_file) {
            if let Some(port) = parse_tcp_listening_ports_from_text(&content, inodes) {
                return Some(port);
            }
        }
    }
    None
}

/// Windows: no /proc. `tasklist` gives the `ninfer-serve.exe` pids and
/// `netstat` which ports they listen on; joined by pid — port ownership is
/// what stop_engine signals, so it is authoritative. Offloaded to spawn_blocking.
#[cfg(windows)]
async fn discover_engines_windows() -> Vec<DiscoveredEngine> {
    tokio::task::spawn_blocking(move || {
        let serve_pids = tasklist_serve_pids();
        if serve_pids.is_empty() {
            return Vec::new();
        }
        let mut out: Vec<DiscoveredEngine> = Vec::new();
        let mut seen: Vec<u32> = Vec::new();
        for (port, pid) in netstat_listeners() {
            if serve_pids.contains(&pid) && !seen.contains(&pid) {
                seen.push(pid);
                out.push(DiscoveredEngine {
                    pid,
                    port: Some(port),
                    start_time: None,
                    argv: vec![],
                    artifact: None,
                });
            }
        }
        for pid in &serve_pids {
            if !seen.contains(pid) {
                out.push(DiscoveredEngine {
                    pid: *pid,
                    port: None,
                    start_time: None,
                    argv: vec![],
                    artifact: None,
                });
            }
        }
        out.sort_by(|a, b| a.port.cmp(&b.port).then_with(|| a.pid.cmp(&b.pid)));
        out
    })
    .await
    .unwrap_or_default()
}

#[cfg(windows)]
fn tasklist_serve_pids() -> Vec<u32> {
    let out = match std::process::Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output()
    {
        Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
        Err(_) => return Vec::new(),
    };
    parse_tasklist_serve_pids(&out)
}

#[cfg(windows)]
fn netstat_listeners() -> Vec<(u16, u32)> {
    let out = match std::process::Command::new("netstat")
        .args(["-ano"])
        .output()
    {
        Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
        Err(_) => return Vec::new(),
    };
    parse_netstat_listeners(&out)
}

/// Parse `tasklist /FO CSV /NH` output into the pids of `ninfer-serve.exe`.
/// Lines look like: `"ninfer-serve.exe","1234","Console","1","150,000 K"`.
#[cfg(any(windows, test))]
fn parse_tasklist_serve_pids(output: &str) -> Vec<u32> {
    let mut pids = Vec::new();
    for line in output.lines() {
        let mut it = line.split('"');
        let _lead = it.next();
        let name = it.next().unwrap_or("");
        let _sep = it.next();
        let pid = it.next().and_then(|p| p.parse::<u32>().ok());
        if name.eq_ignore_ascii_case("ninfer-serve.exe")
            && let Some(pid) = pid
        {
            pids.push(pid);
        }
    }
    pids
}

/// Parse `netstat -ano` output into (port, pid) for LISTENING entries.
/// Lines look like:
/// `TCP    127.0.0.1:8080       0.0.0.0:0              LISTENING       5678`.
#[cfg(any(windows, test))]
fn parse_netstat_listeners(output: &str) -> Vec<(u16, u32)> {
    let mut out = Vec::new();
    for line in output.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 5 || f[3] != "LISTENING" {
            continue;
        }
        let port: u16 = match f[1].rsplit_once(':') {
            Some((_, p)) => match p.parse() {
                Ok(p) => p,
                Err(_) => continue,
            },
            None => continue,
        };
        let pid: u32 = match f[4].parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        out.push((port, pid));
    }
    out
}

#[cfg(test)]
mod discovery_tests {
    use super::*;

    #[test]
    fn parse_cmdline_bytes_extracts_ninfer_serve() {
        let raw = b"/usr/local/bin/ninfer-serve\0--port\08080\0--model\0models/v1.ninfer\0";
        let (args, bin, port, artifact) = parse_cmdline_bytes(raw).unwrap();
        assert_eq!(bin, "/usr/local/bin/ninfer-serve");
        assert_eq!(port, Some(8080));
        assert_eq!(artifact, Some("models/v1.ninfer".to_string()));
        assert_eq!(args, vec!["--port", "8080", "--model", "models/v1.ninfer"]);
    }

    #[test]
    fn parse_cmdline_handles_non_utf8_bytes_and_wrappers() {
        let mut raw = Vec::new();
        raw.extend_from_slice(b"nice\0/build/ninfer-serve\0--port=9090\0");
        raw.extend_from_slice(b"/path/with/non_utf8_\xFF\xFE_model.gguf\0");
        let (args, bin, port, artifact) = parse_cmdline_bytes(&raw).unwrap();
        assert_eq!(bin, "/build/ninfer-serve");
        assert_eq!(port, Some(9090));
        assert!(artifact.unwrap().contains("non_utf8_"));
        assert_eq!(args.len(), 2);
    }

    #[test]
    fn parse_cmdline_rejects_other_binaries() {
        let raw = b"/usr/bin/my-ninfer-serve\0--port\08080\0";
        assert!(parse_cmdline_bytes(raw).is_none());
    }

    #[test]
    fn parse_tcp_listening_ports_from_proc_net() {
        let content = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0 0 10 -1
   1: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 67890 1 0 0 10 -1
";
        let mut inodes = std::collections::HashSet::new();
        inodes.insert(12345);
        assert_eq!(parse_tcp_listening_ports_from_text(content, &inodes), Some(8080));
    }

    #[test]
    fn tasklist_picks_serve_pids_and_ignores_the_rest() {
        let out = "\
\"Image Name\",\"PID\",\"Session Name\",\"Session#\",\"Mem Usage\"
\"System\",\"4\",\"Services\",\"0\",\"1,052 K\"
\"explorer.exe\",\"4321\",\"Console\",\"1\",\"20,000 K\"
\"ninfer-serve.exe\",\"1234\",\"Console\",\"1\",\"150,000 K\"
\"NINFER-SERVE.EXE\",\"5678\",\"Console\",\"1\",\"151,000 K\"
\"ninfer.exe\",\"7\",\"Console\",\"1\",\"1,000 K\"
";
        assert_eq!(parse_tasklist_serve_pids(out), vec![1234, 5678]);
    }

    #[test]
    fn tasklist_handles_garbage_lines() {
        assert_eq!(
            parse_tasklist_serve_pids("INFO: No Task running\n\n"),
            Vec::<u32>::new()
        );
        assert_eq!(
            parse_tasklist_serve_pids("\"ninfer-serve.exe\",\"\",\"Console\",\"1\",\"5 K\"\n"),
            Vec::<u32>::new()
        );
    }

    #[test]
    fn netstat_picks_listening_entries_only() {
        let out = "
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       5678
  TCP    [::1]:8081             [::]:0                 LISTENING       9999
  TCP    127.0.0.1:8080         127.0.0.1:51234        ESTABLISHED     5678
  TCP    127.0.0.1:99999        0.0.0.0:0              LISTENING       42
";
        let ls = parse_netstat_listeners(out);
        assert!(ls.contains(&(135, 1234)));
        assert!(ls.contains(&(8080, 5678)));
        assert!(ls.contains(&(8081, 9999)));
        assert_eq!(ls.len(), 3);
    }
}
