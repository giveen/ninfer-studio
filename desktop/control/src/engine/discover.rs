//! Discovery of externally-running `ninfer-serve` processes (/proc on Linux, tasklist+netstat on Windows).

/// Scan /proc for running `ninfer-serve` processes (Linux).
pub async fn find_external_serve_pids() -> Vec<u32> {
    discover_engines().await.into_iter().map(|d| d.pid).collect()
}

/// A locally-running ninfer-serve process discovered via /proc.
#[derive(Debug)]
pub struct DiscoveredEngine {
    pub pid: u32,
    pub port: Option<u16>,
    /// cmdline args excluding the binary itself
    pub argv: Vec<String>,
    pub artifact: Option<String>,
}

/// Find locally-running ninfer-serve processes, with (pid, port, argv, artifact).
/// Linux: /proc scan (argv + port from cmdline). Windows: tasklist + netstat
/// (argv unavailable without WMI — callers treat empty argv as "not readable").
pub async fn discover_engines() -> Vec<DiscoveredEngine> {
    #[cfg(not(windows))]
    {
        discover_engines_proc().await
    }
    #[cfg(windows)]
    {
        discover_engines_windows()
    }
}

/// Scan /proc for ninfer-serve processes and pull (pid, port, argv, artifact).
#[cfg(not(windows))]
async fn discover_engines_proc() -> Vec<DiscoveredEngine> {
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
        let Ok(cmdline) = tokio::fs::read_to_string(format!("/proc/{name}/cmdline")).await else {
            continue;
        };
        let parts: Vec<String> = cmdline.split('\0').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
        let is_serve = parts
            .first()
            .map(|p| p.ends_with("ninfer-serve"))
            .unwrap_or(false);
        if !is_serve {
            continue;
        }
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        let args = parts.iter().skip(1).cloned().collect::<Vec<_>>();
        let mut port: Option<u16> = None;
        let mut artifact: Option<String> = None;
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--port" if i + 1 < args.len() => {
                    if let Ok(p) = args[i + 1].parse::<u16>() {
                        port = Some(p);
                    }
                    i += 2;
                    continue;
                }
                _ => {}
            }
            if let Some(stripped) = args[i].strip_prefix("--port=") {
                if let Ok(p) = stripped.parse::<u16>() {
                    port = Some(p);
                }
            }
            if artifact.is_none()
                && !args[i].starts_with('-')
                && args[i].ends_with(".ninfer")
            {
                artifact = Some(args[i].clone());
            }
            i += 1;
        }
        out.push(DiscoveredEngine {
            pid,
            port,
            argv: args,
            artifact,
        });
    }
    out
}

/// Windows: no /proc. `tasklist` gives the `ninfer-serve.exe` pids and
/// `netstat` which ports they listen on; joined by pid — port ownership is
/// what stop_engine signals, so it is authoritative.
#[cfg(windows)]
fn discover_engines_windows() -> Vec<DiscoveredEngine> {
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
                argv: vec![],
                artifact: None,
            });
        }
    }
    // serve processes not (yet) listening — e.g. still starting up
    for pid in &serve_pids {
        if !seen.contains(pid) {
            out.push(DiscoveredEngine {
                pid: *pid,
                port: None,
                argv: vec![],
                artifact: None,
            });
        }
    }
    out
}

#[cfg(windows)]
fn tasklist_serve_pids() -> Vec<u32> {
    let out = match std::process::Command::new("tasklist").args(["/FO", "CSV", "/NH"]).output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
        Err(_) => return Vec::new(),
    };
    parse_tasklist_serve_pids(&out)
}

#[cfg(windows)]
fn netstat_listeners() -> Vec<(u16, u32)> {
    let out = match std::process::Command::new("netstat").args(["-ano", "-p", "tcp"]).output() {
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
        if name.eq_ignore_ascii_case("ninfer-serve.exe") {
            if let Some(pid) = pid {
                pids.push(pid);
            }
        }
    }
    pids
}

/// Parse `netstat -ano -p tcp` output into (port, pid) for LISTENING entries.
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
        // local address is "ip:port" or "[v6]:port" — port follows the last ':'
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
    use super::{parse_netstat_listeners, parse_tasklist_serve_pids};

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
        assert_eq!(parse_tasklist_serve_pids("INFO: No Task running\n\n"), Vec::<u32>::new());
        // missing/invalid pid is skipped
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
        // the ESTABLISHED row and the out-of-range port are excluded
        assert_eq!(ls.len(), 3);
    }
}

