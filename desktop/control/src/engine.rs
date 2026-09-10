//! Engine process supervision: spawn / health-poll / stop / adopt-external.

use crate::types::{build_serve_args, AppEvent, EngineInner, EngineProfile, LastStart, State, now_ms};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub type S = Arc<State>;

pub async fn engine_health(port: u16) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
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

pub async fn engine_model_id(state: &State, port: u16) -> Option<String> {
    let api_key = state.config.read().await.api_key.clone();
    let mut req = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/v1/models"))
        .timeout(Duration::from_millis(1500));
    if !api_key.is_empty() {
        req = req.bearer_auth(&api_key);
    }
    let r = req.send().await.ok()?;
    let body: Value = r.json().await.ok()?;
    body["data"][0]["id"].as_str().map(|s| s.to_string())
}

/// Scan /proc for running `ninfer-serve` processes (Linux).
pub async fn find_external_serve_pids() -> Vec<u32> {
    discover_engines().await.into_iter().map(|d| d.pid).collect()
}

/// A locally-running ninfer-serve process discovered via /proc.
pub struct DiscoveredEngine {
    pub pid: u32,
    pub port: Option<u16>,
    /// cmdline args excluding the binary itself
    pub argv: Vec<String>,
    pub artifact: Option<String>,
}

/// Scan /proc for ninfer-serve processes and pull (pid, port, argv, artifact).
pub async fn discover_engines() -> Vec<DiscoveredEngine> {
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
                        eng.model_id = engine_model_id(state, port).await;
                    }
                }
            } else if eng.state == "starting" || eng.state == "running" {
                if eng.state == "starting" && eng.deadline.is_none() {
                    eng.deadline = Some(now_ms() + 180_000);
                }
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
                    Some("engine did not become healthy within 3 minutes".into());
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
                    eng.model_id = engine_model_id(state, port).await;
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
    eng.model_id = engine_model_id(state, port).await;
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
    let engine_binary = std::path::Path::new(ninfer_path)
        .join("build")
        .join("apps")
        .join("ninfer-serve");

    let port = profile.port.unwrap_or(cfg.engine_port);
    let artifact = artifact.filter(|a| !a.is_empty());

    // adopt-don't-kill: something already serves this port
    if engine_health(port).await {
        let pids = find_external_serve_pids().await;
        let mut eng = state.engine.write().await;
        eng.state = "external".into();
        eng.adopted = true;
        eng.port = Some(port);
        eng.artifact = artifact;
        eng.pid = pids.into_iter().next();
        eng.model_id = engine_model_id(state, port).await;
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
        eng.deadline = Some(now_ms() + 180_000);
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
        eng.pid = pid.map(|p| p as u32);
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
                        eng.model_id = engine_model_id(st.as_ref(), port2).await;
                    }
                }
                return;
            }
            let mut eng = st.engine.write().await;
            if let Some(deadline) = eng.deadline {
                if now_ms() > deadline {
                    eng.state = "failed".into();
                    eng.fail_reason =
                        Some("engine did not become healthy within 3 minutes".into());
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
                    let mut eng = state.engine.write().await;
                    eng.state = "stopped".into();
                    return json!({ "ok": true, "message": "no engine process found" });
                }
                Some(pid) => {
                    let ok = nix_kill(pid, 15);
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
    let ok = nix_kill(target, 15); // SIGTERM
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

/// Send a POSIX signal via `kill(1)` (avoids a libc dependency).
fn nix_kill(pid: u32, sig: i32) -> bool {
    std::process::Command::new("kill")
        .arg(format!("-{sig}"))
        .arg(pid.to_string())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn public_engine(eng: &EngineInner) -> Value {
    json!({
        "state": eng.state,
        "pid": eng.pid,
        "port": eng.port,
        "artifact": eng.artifact,
        "modelId": eng.model_id,
        "argv": eng.argv,
        "startedAt": eng.started_at,
        "logPath": eng.log_path,
        "adopted": eng.adopted,
        "failReason": eng.fail_reason,
    })
}
