//! Engine process supervision: spawn / health-poll / stop / adopt-external.

// Rust guideline compliant 2026-07-28

use crate::types::{build_serve_args, AppEvent, EngineInner, EngineProfile, LastStart, State, now_ms};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub type S = Arc<State>;

/// Startup grace period (ms): how long a freshly spawned engine has to report
/// healthy before it's marked failed.
const ENGINE_START_TIMEOUT_MS: u64 = 180_000;

/// HTTP client timeout (ms) for a single health/model-info probe of the
/// locally spawned engine — short, since a slow local loopback response
/// means the engine isn't ready rather than that the network is slow.
const ENGINE_PROBE_TIMEOUT_MS: u64 = 1500;

/// User-facing failure reason when an engine doesn't become healthy within
/// `ENGINE_START_TIMEOUT_MS` — derived from the constant so the wording can't
/// drift out of sync with the actual timeout.
fn start_timeout_message() -> String {
    format!(
        "engine did not become healthy within {} minutes",
        ENGINE_START_TIMEOUT_MS / 60_000
    )
}

pub async fn engine_health(port: u16) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(ENGINE_PROBE_TIMEOUT_MS))
        .build()
    else {
        return false;
    };
    client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Probe the engine's /v1/models for the model id and its context window.
pub async fn engine_model_info(state: &State, port: u16) -> (Option<String>, Option<u64>) {
    let api_key = state.config.read().await.api_key.clone();
    let mut req = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/v1/models"))
        .timeout(Duration::from_millis(ENGINE_PROBE_TIMEOUT_MS));
    if !api_key.is_empty() {
        req = req.bearer_auth(&api_key);
    }
    let Some(r) = req.send().await.ok() else {
        return (None, None);
    };
    let Ok(body) = r.json::<Value>().await else {
        return (None, None);
    };
    let model = body["data"][0]["id"].as_str().map(|s| s.to_string());
    let max_context = body["data"][0]["max_model_len"].as_u64();
    (model, max_context)
}

/// --max-context out of a raw argv (fallback when /v1/models has not been
/// probed yet, and for adopted engines).
fn argv_max_context(argv: Option<&Vec<String>>) -> Option<u64> {
    let argv = argv?;
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        if let Some(rest) = a.strip_prefix("--max-context=") {
            return rest.parse().ok();
        }
        if a == "--max-context" {
            return it.next().and_then(|v| v.parse().ok());
        }
    }
    None
}

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

/// Reconcile in-memory state with reality (health, child liveness, external adoption).
pub async fn refresh_engine_status(state: &State) {
    // Liveness of a Studio-spawned child: the slot is occupied while the process
    // is alive (the reaper only clears it on actual exit). Treat a briefly-busy
    // lock as "alive" so a refresh racing the reaper's poll never flips the
    // engine to failed/external.
    let has_child = match state.child.try_lock() {
        Ok(g) => g.is_some(),
        Err(_) => true,
    };
    let mut eng = state.engine.write().await;
    let prev_state = eng.state.clone();

    if has_child {
        if let Some(port) = eng.port {
            if engine_health(port).await {
                if eng.state != "running" {
                    eng.state = "running".into();
                    if eng.model_id.is_none() {
                        let (mid, mctx) = engine_model_info(state, port).await;
                        eng.model_id = mid;
                        eng.max_context = mctx;
                    }
                }
            } else if eng.state == "starting" && eng.deadline.is_none() {
                eng.deadline = Some(now_ms() + ENGINE_START_TIMEOUT_MS);
            }
        }
    } else if eng.state == "starting" || eng.state == "running" {
        eng.state = "failed".into();
        eng.fail_reason = Some("engine process exited".into());
    }

    if eng.state == "starting" {
        if let Some(deadline) = eng.deadline {
            if now_ms() > deadline {
                eng.state = "failed".into();
                eng.fail_reason =
                    Some(start_timeout_message());
            }
        }
    }

    if eng.state == "stopped" {
        if let Some(port) = eng.port {
            if engine_health(port).await {
                adopt_external(&mut eng, state, port).await;
            }
        }
    } else if eng.state == "failed" && !has_child {
        // a failed spawn must not mask a live engine: if the spawn targeted a
        // non-configured port and the configured port serves, restore its view
        let cfg_port = state.config.read().await.engine_port;
        let port = if eng.port != Some(cfg_port) && engine_health(cfg_port).await {
            Some(cfg_port)
        } else {
            eng.port
        };
        if let Some(port) = port {
            if engine_health(port).await {
                adopt_external(&mut eng, state, port).await;
            }
        }
    } else if eng.state == "external" {
        if let Some(port) = eng.port {
            if engine_health(port).await {
                // keep pid + argv fresh (the external process may restart)
                let pid = discover_engines()
                    .await
                    .into_iter()
                    .find(|d| d.port == Some(port))
                    .map(|d| d.pid);
                if let Some(p) = pid {
                    eng.pid = Some(p);
                }
                if eng.model_id.is_none() {
                    let (mid, mctx) = engine_model_info(state, port).await;
                        eng.model_id = mid;
                        eng.max_context = mctx;
                }
            } else {
                eng.state = "stopped".into();
                eng.adopted = false;
                eng.pid = None;
                eng.argv = None;
            }
        }
    }

    // Edge-triggered desktop-shell events (tray state + OS notifications).
    let new_state = eng.state.clone();
    drop(eng);
    if new_state != prev_state {
        match new_state.as_str() {
            "running" => {
                let model = state.engine.read().await.model_id.clone();
                let port = state.config.read().await.engine_port;
                state.emit(AppEvent::EngineReady { model, port });
            }
            "failed" => {
                let reason = state.engine.read().await.fail_reason.clone();
                state.emit(AppEvent::EngineFailed { reason });
            }
            "stopped" => {
                state.emit(AppEvent::EngineStopped);
            }
            _ => {}
        }
    }
}

fn log_path_for(data_dir: &std::path::Path, port: u16) -> String {
    data_dir
        .join(format!("engine-{port}.log"))
        .to_string_lossy()
        .to_string()
}

/// Cap on-disk engine log growth. The file is opened in append mode and
/// piped the engine's stdout+stderr for its whole run, and that same file
/// persists across restarts (never truncated), so a long-lived install would
/// otherwise grow it forever — the engine logs a throughput line every
/// `--log-stats-interval-ms` (default 5s) even at idle.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
const LOG_KEEP_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// If the engine log at `path` is already over the size cap, rewrite it down
/// to just its last `LOG_KEEP_TAIL_BYTES` (trimmed to a clean line boundary)
/// instead of leaving it to grow unbounded. Called right before each start,
/// so the cap is enforced once per engine launch rather than continuously.
async fn rotate_log_if_large(path: &str) {
    let Ok(md) = tokio::fs::metadata(path).await else {
        return;
    };
    if md.len() <= MAX_LOG_BYTES {
        return;
    }
    let path = path.to_string();
    let _ = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        use std::io::{Read, Seek, SeekFrom, Write};
        let mut f = std::fs::File::open(&path)?;
        let len = f.metadata()?.len();
        let start = len.saturating_sub(LOG_KEEP_TAIL_BYTES);
        f.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        // Drop a leading partial line so the kept tail starts cleanly.
        if let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            buf.drain(..=nl);
        }
        let mut out = std::fs::File::create(&path)?; // truncates in place
        out.write_all(b"--- log truncated: earlier entries removed to cap file size ---\n")?;
        out.write_all(&buf)?;
        Ok(())
    })
    .await;
}

/// VRAM safety floor (GiB): when the engine reports less free memory than this
/// after load, the UI warns that any growth (CUDA graph re-capture, media
/// buffers, desktop spill) can OOM the run.
pub const VRAM_FLOOR_GIB: f64 = 1.8;

/// Parse one engine `capacity |` log line into (runtime GiB, free GiB).
/// Real shapes seen in the wild:
///   capacity | KV 240,000 tokens, fp8, explicit | pages 3,750/7,500 | runtime 9.41 GiB | free 3.34 GiB
///   capacity | KV 8,192 tokens, bf16, explicit | pages 128/128 | runtime 982.1 MiB | free 9.70 GiB
/// Units vary per line, so both MiB and GiB are handled.
fn parse_capacity_line(line: &str) -> Option<(f64, f64)> {
    if !line.contains("capacity |") {
        return None;
    }
    let mut runtime = None;
    let mut free = None;
    for seg in line.split('|') {
        let seg = seg.trim();
        for (label, slot) in [("runtime ", &mut runtime), ("free ", &mut free)] {
            if let Some(rest) = seg.strip_prefix(label) {
                let mut it = rest.split_whitespace();
                let val: f64 = it.next()?.parse().ok()?;
                match it.next()?.to_lowercase().as_str() {
                    "gib" => *slot = Some(val),
                    "mib" => *slot = Some(val / 1024.0),
                    _ => {}
                }
            }
        }
    }
    Some((runtime?, free?))
}

/// Tail the engine log for the most recent `capacity |` line — the engine's
/// own VRAM accounting after weights + KV are resident. Works for adopted
/// engines too, since it reads the shared log file rather than our spawn pipe.
pub async fn vram_status(data_dir: &std::path::Path, port: u16) -> Option<(f64, f64)> {
    let path = log_path_for(data_dir, port);
    tokio::task::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(&path).ok()?;
        let start = f.metadata().ok()?.len().saturating_sub(65_536);
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut tail = String::new();
        f.read_to_string(&mut tail).ok()?;
        tail.lines().rev().find_map(parse_capacity_line)
    })
    .await
    .unwrap_or(None)
}

async fn adopt_external(eng: &mut EngineInner, state: &State, port: u16) {
    // find the discovered process serving this port (pid + full argv).
    // Never fall back to a process bound to a *different* port — only to
    // portless ones when adopting the configured default port.
    let all = discover_engines().await;
    let disc = all.iter().find(|d| d.port == Some(port));
    let disc_pid = disc.map(|d| d.pid);
    let disc_argv = disc.map(|d| d.argv.clone());
    let disc_artifact = disc.and_then(|d| d.artifact.clone());
    let is_default_port = port == state.config.read().await.engine_port;
    let fallback_pid = if is_default_port {
        all.iter()
            .find(|d| d.port.is_none())
            .map(|d| d.pid)
    } else {
        None
    };
    eng.state = "external".into();
    eng.adopted = true;
    eng.port = Some(port);
    eng.pid = disc_pid.or(fallback_pid);
    eng.argv = disc_argv;
    eng.artifact = eng.artifact.clone().or(disc_artifact);
    let (mid, mctx) = engine_model_info(state, port).await;
                        eng.model_id = mid;
                        eng.max_context = mctx;
    eng.fail_reason = None;
    eng.log_path = Some(log_path_for(&state.data_dir, port));
}

pub async fn start_engine(state: &S, profile: EngineProfile, artifact: Option<String>) -> Value {
    let cfg = state.config.read().await.clone();

    // Fail fast with a clear message if no engine binary is configured. A
    // distributed build ships an empty default (never the developer's machine
    // path), so a fresh install must point Studio at the user's own
    // ninfer-serve before the engine can start.
    let ninfer_path = cfg.ninfer_path.trim();
    if ninfer_path.is_empty() {
        let mut eng = state.engine.write().await;
        eng.state = "failed".into();
        eng.fail_reason = Some("ninfer path not configured".into());
        let reason = "Ninfer path not configured — open Settings and set the Ninfer path.".to_string();
        state.emit(AppEvent::EngineFailed {
            reason: Some(reason.clone()),
        });
        return json!({
            "ok": false,
            "code": "not_configured",
            "message": reason,
        });
    }
    // Resolve the engine binary from the configured path. Accepts (private
    // Windows support):
    //   * a direct file path, e.g. E:\ninfer-windows-...\ninfer-serve.exe
    //   * a directory containing ninfer-serve.exe (Windows release layout)
    //   * a directory with build/apps/ninfer-serve (Linux dev checkout)
    let configured = std::path::Path::new(ninfer_path);
    let engine_binary = if configured.is_file() {
        configured.to_path_buf()
    } else if configured.join("ninfer-serve.exe").is_file() {
        configured.join("ninfer-serve.exe")
    } else {
        configured.join("build").join("apps").join("ninfer-serve")
    };
    if !engine_binary.is_file() {
        let mut eng = state.engine.write().await;
        eng.state = "failed".into();
        eng.fail_reason = Some(format!("engine binary not found: {}", engine_binary.display()));
        let reason = format!(
            "Engine binary not found at {} — point the Ninfer path at ninfer-serve (or its folder) in Settings.",
            engine_binary.display()
        );
        state.emit(AppEvent::EngineFailed {
            reason: Some(reason.clone()),
        });
        return json!({
            "ok": false,
            "code": "binary_missing",
            "message": reason,
        });
    }

    let port = profile.port.unwrap_or(cfg.engine_port);
    let artifact = artifact.filter(|a| !a.is_empty());

    // adopt-don't-kill: something already serves this port
    if engine_health(port).await {
        // Adopt the PID that actually owns THIS port. Discovery carries
        // (pid, port) pairs; a bare first-PID pick with engines on two ports
        // could record the OTHER engine, and a later Stop would kill it.
        // Fall back to the first discovered PID when the port can't be
        // resolved (e.g. netstat couldn't attribute the listener).
        let discovered = discover_engines().await;
        let pid = discovered
            .iter()
            .find(|d| d.port == Some(port))
            .map(|d| d.pid)
            .or_else(|| discovered.first().map(|d| d.pid));
        let mut eng = state.engine.write().await;
        eng.state = "external".into();
        eng.adopted = true;
        eng.port = Some(port);
        eng.artifact = artifact;
        eng.pid = pid;
        let (mid, mctx) = engine_model_info(state, port).await;
                        eng.model_id = mid;
                        eng.max_context = mctx;
        eng.log_path = Some(log_path_for(&state.data_dir, port));
        eng.fail_reason = None;
        return json!({
            "ok": false,
            "code": "already_serving",
            "message": format!("an engine is already serving on port {port} (adopted as external)"),
            "engine": public_engine(&eng),
        });
    }

    {
        let child = state.child.lock().await;
        if child.is_some() {
            return json!({
                "ok": false,
                "code": "already_running",
                "message": "an engine spawn is already in progress"
            });
        }
    }

    let Some(artifact) = artifact else {
        return json!({
            "ok": false,
            "code": "no_artifact",
            "message": "select a downloaded .ninfer artifact first"
        });
    };
    if tokio::fs::metadata(&artifact).await.is_err() {
        return json!({
            "ok": false,
            "code": "artifact_missing",
            "message": format!("artifact not found: {artifact}")
        });
    }

    let args = build_serve_args(&profile, port);
    // remember what we're about to start (dirty-check source for the UI)
    {
        let last_start = LastStart {
            port,
            profile: profile.clone(),
            artifact: Some(artifact.clone()),
            at: now_ms(),
        };
        *state.last_start.write().await = Some(last_start.clone());
        let path = state.data_dir.join("last-start.json");
        let _ = std::fs::write(&path, serde_json::to_string(&last_start).unwrap_or_default());
    }
    let log_file_path = log_path_for(&state.data_dir, port);
    let _ = tokio::fs::create_dir_all(&state.data_dir).await;
    rotate_log_if_large(&log_file_path).await;
    let Ok(log) = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
        .await
    else {
        return json!({ "ok": false, "message": "could not open engine log file" });
    };

    {
        let mut eng = state.engine.write().await;
        eng.state = "starting".into();
        eng.port = Some(port);
        eng.artifact = Some(artifact.clone());
        eng.model_id = None;
        let mut argv = vec![artifact.clone()];
        argv.extend(args.iter().cloned());
        eng.argv = Some(argv);
        eng.started_at = Some(now_ms());
        eng.log_path = Some(log_file_path);
        eng.adopted = false;
        eng.fail_reason = None;
        eng.deadline = Some(now_ms() + ENGINE_START_TIMEOUT_MS);
    }

    let mut cmd = tokio::process::Command::new(&engine_binary);
    // Attach the FULL built command line. `args` carries every flag from the
    // user's profile (--port, --max-context, --kv-dtype, …); it was previously
    // only recorded into state.argv for display while the spawned process got
    // the artifact alone — so packaged apps launched engines at pure defaults
    // no matter what the GUI said.
    cmd.arg(&artifact)
        .args(&args)
        .current_dir(
            engine_binary
                .parent()
                .unwrap_or(std::path::Path::new(".")),
        )
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let mut eng = state.engine.write().await;
            eng.state = "failed".into();
            let reason = format!("spawn failed: {e}");
            eng.fail_reason = Some(reason.clone());
            state.emit(AppEvent::EngineFailed {
                reason: Some(reason),
            });
            return json!({ "ok": false, "message": format!("spawn failed: {e}") });
        }
    };
    let pid = child.id();

    // pump stdout+stderr into the log file
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Some(stdout) = stdout {
        if let Ok(la) = log.try_clone().await {
            tokio::spawn(async move {
                let mut la = la;
                let mut so = stdout;
                let _ = tokio::io::copy(&mut so, &mut la).await;
            });
        }
    }
    if let Some(stderr) = stderr {
        if let Ok(lb) = log.try_clone().await {
            tokio::spawn(async move {
                let mut lb = lb;
                let mut se = stderr;
                let _ = tokio::io::copy(&mut se, &mut lb).await;
            });
        }
    }

    {
        *state.child.lock().await = Some(child);
    }
    {
        *state.log_file.lock().await = Some(log);
    }
    {
        let mut eng = state.engine.write().await;
        eng.pid = pid;
    }

    // reaper: watch the spawned child and record its exit. The handle stays in
    // `state.child` (cleared only once the process is actually gone) so the
    // liveness checks in `refresh_engine_status` and the health poller keep
    // seeing a *live* child instead of a false "process exited" / "external".
    {
        let st = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let exited = {
                    let mut g = st.child.lock().await;
                    match g.as_mut() {
                        Some(c) => c.try_wait().ok().flatten().is_some(),
                        None => return, // slot cleared (e.g. by stop_engine) — nothing to watch
                    }
                };
                if exited {
                    let mut eng = st.engine.write().await;
                    if eng.state == "starting" || eng.state == "running" {
                        eng.state = "failed".into();
                        eng.fail_reason = Some("engine process exited".into());
                        eng.pid = None;
                        eng.adopted = false;
                    }
                    *st.child.lock().await = None;
                    return;
                }
            }
        });
    }

    // health poller until ready or deadline
    let st = state.clone();
    let port2 = port;
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(2000)).await;
            if engine_health(port2).await {
                let mut eng = st.engine.write().await;
                if eng.state == "starting" || eng.state == "running" {
                    eng.state = "running".into();
                    if eng.model_id.is_none() {
                        let (mid, mctx) = engine_model_info(st.as_ref(), port2).await;
                        eng.model_id = mid;
                        eng.max_context = mctx;
                    }
                }
                return;
            }
            let mut eng = st.engine.write().await;
            if let Some(deadline) = eng.deadline {
                if now_ms() > deadline {
                    eng.state = "failed".into();
                    eng.fail_reason =
                        Some(start_timeout_message());
                    drop(eng);
                    let mut c = st.child.lock().await;
                    if let Some(c) = c.as_mut() {
                        let _ = c.start_kill();
                    }
                    return;
                }
            }
        }
    });

    let eng = state.engine.read().await;
    json!({ "ok": true, "engine": public_engine(&eng) })
}

pub async fn stop_engine(state: &S, external_pid: Option<u32>) -> Value {
    // 1) our own child: SIGTERM with 8s grace
    {
        let child = state.child.lock().await;
        if child.is_some() {
            drop(child);
            {
                let mut eng = state.engine.write().await;
                eng.state = "stopping".into();
            }
            let proc = state.child.lock().await.take();
            if let Some(mut proc) = proc {
                let _ = proc.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(8), proc.wait()).await;
                let mut eng = state.engine.write().await;
                eng.state = "stopped".into();
                eng.adopted = false;
                eng.pid = None;
                return json!({ "ok": true, "message": "engine stopped" });
            }
        }
    }

    // 2) explicit pid or adopted external
    let target = {
        let eng = state.engine.read().await;
        external_pid.or(eng.pid)
    };
    let Some(target) = target else {
        let (is_external, port) = {
            let eng = state.engine.read().await;
            (eng.state == "external", eng.port)
        };
        if is_external {
            // port-aware: only signal the process actually serving this engine's port
            let all = discover_engines().await;
            let is_default = port == Some(state.config.read().await.engine_port);
            let pid = all
                .iter()
                .find(|d| d.port == port)
                .map(|d| d.pid)
                .or_else(|| {
                    if is_default {
                        all.iter().find(|d| d.port.is_none()).map(|d| d.pid)
                    } else {
                        None
                    }
                });
            match pid {
                None => {
                    // the port is served (we only get here with the engine already
                    // health-probed) but its owning process could not be
                    // identified. Report honestly and keep the state `external` —
                    // the next reconcile re-checks health and keeps the adoption.
                    return json!({
                        "ok": false,
                        "message": "external engine is serving, but its process could not be identified — stop it manually (Ctrl+C in its terminal window)"
                    });
                }
                Some(pid) => {
                    let ok = signal_engine_pid(pid);
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    let mut eng = state.engine.write().await;
                    eng.state = "stopped".into();
                    eng.adopted = false;
                    eng.pid = None;
                    return if ok {
                        json!({ "ok": true, "message": format!("signaled external pid {pid}") })
                    } else {
                        json!({ "ok": false, "message": "failed to signal external pid" })
                    };
                }
            }
        }
        return json!({ "ok": false, "message": "no engine process is running" });
    };

    {
        let mut eng = state.engine.write().await;
        eng.state = "stopping".into();
    }
    let ok = signal_engine_pid(target);
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let mut eng = state.engine.write().await;
    eng.state = "stopped".into();
    eng.adopted = false;
    eng.pid = None;
    if ok {
        json!({ "ok": true, "message": format!("signaled pid {target}") })
    } else {
        json!({ "ok": false, "message": "failed to signal target pid" })
    }
}

/// Signal a foreign engine process to stop.
/// POSIX: SIGTERM via `kill(1)` (avoids a libc dependency).
/// Windows: no portable graceful signal exists for a foreign console process,
/// so force-kill via `taskkill /F` — the same thing tokio already does when
/// stopping our own child on Windows.
fn signal_engine_pid(pid: u32) -> bool {
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .arg("-15")
            .arg(pid.to_string())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        std::process::Command::new("taskkill")
            .args(["/F", "/PID"])
            .arg(pid.to_string())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

pub fn public_engine(eng: &EngineInner) -> Value {
    json!({
        "state": eng.state,
        "pid": eng.pid,
        "port": eng.port,
        "artifact": eng.artifact,
        "modelId": eng.model_id,
        "maxContext": eng.max_context.or_else(|| argv_max_context(eng.argv.as_ref())),
        "argv": eng.argv,
        "startedAt": eng.started_at,
        "logPath": eng.log_path,
        "adopted": eng.adopted,
        "failReason": eng.fail_reason,
    })
}

#[cfg(test)]
mod log_rotation_tests {
    use super::{rotate_log_if_large, LOG_KEEP_TAIL_BYTES, MAX_LOG_BYTES};

    fn tmp_log(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ninfier-logrotate-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    #[tokio::test]
    async fn leaves_a_small_log_untouched() {
        let path = tmp_log("small.log");
        std::fs::write(&path, "line one\nline two\n").unwrap();
        rotate_log_if_large(path.to_str().unwrap()).await;
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, "line one\nline two\n");
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn caps_a_large_log_to_its_tail() {
        let path = tmp_log("large.log");
        // Build a log well past MAX_LOG_BYTES out of numbered, easily
        // recognizable lines so we can verify the kept content is really the
        // tail and nothing from the dropped head survives.
        let line = "x".repeat(100);
        let target = MAX_LOG_BYTES + LOG_KEEP_TAIL_BYTES; // guarantee rotation fires
        let mut body = String::new();
        let mut i: u64 = 0;
        while (body.len() as u64) < target {
            body.push_str(&format!("{i} {line}\n"));
            i += 1;
        }
        let last_line_no = i - 1;
        std::fs::write(&path, &body).unwrap();
        let original_len = std::fs::metadata(&path).unwrap().len();
        assert!(original_len > MAX_LOG_BYTES, "test setup should exceed the cap");

        rotate_log_if_large(path.to_str().unwrap()).await;

        let new_len = std::fs::metadata(&path).unwrap().len();
        assert!(new_len < original_len, "rotation should shrink the file");
        assert!(new_len <= LOG_KEEP_TAIL_BYTES + 200, "kept tail should be close to LOG_KEEP_TAIL_BYTES, got {new_len}");

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("--- log truncated"), "should carry the truncation marker");
        // The very last line written must survive (nothing lost off the end).
        assert!(content.trim_end().ends_with(&format!("{last_line_no} {line}")));
        // An early line must NOT survive (the head was actually dropped).
        assert!(!content.contains(&format!("\n0 {line}\n")));
        // No partial line at the top of the kept tail (other than the marker).
        let mut lines = content.lines();
        assert!(lines.next().unwrap().starts_with("--- log truncated"));
        for l in lines {
            if l.is_empty() { continue; }
            assert!(l.ends_with(&line), "kept line should be a complete, unbroken original line: {l:?}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn missing_file_is_a_noop() {
        let path = tmp_log("does-not-exist.log");
        let _ = std::fs::remove_file(&path);
        rotate_log_if_large(path.to_str().unwrap()).await; // must not panic
        assert!(!path.exists());
    }
}

#[cfg(test)]
mod vram_tests {
    use super::parse_capacity_line;

    #[test]
    fn parses_the_two_observed_line_shapes() {
        let gig = "2026-09-10 17:42:45.669  INFO  capacity | KV 240,000 tokens, fp8, explicit | pages 3,750/7,500 | runtime 9.41 GiB | free 3.34 GiB";
        let (r, f) = parse_capacity_line(gig).expect("gigabyte line parses");
        assert!((r - 9.41).abs() < 1e-9 && (f - 3.34).abs() < 1e-9);

        let mib = "2026-09-10 17:20:03.051  INFO  capacity | KV 8,192 tokens, bf16, explicit | pages 128/128 | runtime 982.1 MiB | free 9.70 GiB";
        let (r, f) = parse_capacity_line(mib).expect("megabyte line parses");
        assert!((r - 982.1 / 1024.0).abs() < 1e-9 && (f - 9.70).abs() < 1e-9);
    }

    #[test]
    fn rejects_non_capacity_lines() {
        assert!(parse_capacity_line("2026-09-10 17:42:45.763  INFO  listening on http://127.0.0.1:8080 | model qwen3.8-27b | auth disabled").is_none());
        assert!(parse_capacity_line("").is_none());
    }
}

#[cfg(test)]
mod argv_tests {
    use super::argv_max_context;

    #[test]
    fn parses_both_max_context_forms() {
        let space = vec!["ninfer-serve".to_string(), "--max-context".to_string(), "240000".to_string()];
        assert_eq!(argv_max_context(Some(&space)), Some(240_000));
        let eq = vec!["--max-context=128000".to_string()];
        assert_eq!(argv_max_context(Some(&eq)), Some(128_000));
        assert_eq!(argv_max_context(None), None);
        assert_eq!(argv_max_context(Some(&vec!["--port".to_string(), "8080".to_string()])), None);
    }
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
