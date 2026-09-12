//! Engine spawn / stop / signal + the public engine view.
use crate::types::{
    build_serve_args, AppEvent, AppSettings, EngineInner, EngineProfile, EngineState, LastStart, State, now_ms,
};
use serde_json::{json, Value};
use std::time::Duration;
use super::discover::discover_engines;
use super::health::{argv_max_context, engine_health, engine_model_info};
use super::log::{log_path_for, rotate_log_if_large};
use super::status::{adopt_external, resolve_external_pid};
use super::S;

/// Startup grace period (ms): how long a freshly spawned engine has to report
/// healthy before it's marked failed.
pub const ENGINE_START_TIMEOUT_MS: u64 = 180_000;

/// User-facing failure reason when an engine doesn't become healthy within
/// `ENGINE_START_TIMEOUT_MS` — derived from the constant so the wording can't
/// drift out of sync with the actual timeout.
pub fn start_timeout_message() -> String {
    format!(
        "engine did not become healthy within {} minutes",
        ENGINE_START_TIMEOUT_MS / 60_000
    )
}

/// Record a pre-spawn failure AND notify the desktop shell with the
/// user-facing wording. (The stored `fail_reason` is the short internal form;
/// the event carries the actionable message shown in the UI.)
pub fn fail_and_emit(eng: &mut EngineInner, state: &State, stored: String, shown: String) {
    eng.mark_failed(stored);
    state.emit(AppEvent::EngineFailed {
        reason: Some(shown),
    });
}

/// Validate engine launch prerequisites: a configured `ninfer_path` that
/// resolves to an existing `ninfer-serve` binary. On failure, records the
/// failed engine state via `fail_and_emit` and returns the error response
/// `start_engine` used to return inline.
async fn validate_launch(state: &S, cfg: &AppSettings) -> Result<std::path::PathBuf, Value> {
    // Fail fast with a clear message if no engine binary is configured. A
    // distributed build ships an empty default (never the developer's machine
    // path), so a fresh install must point Studio at the user's own
    // ninfer-serve before the engine can start.
    let ninfer_path = cfg.ninfer_path.trim();
    if ninfer_path.is_empty() {
        let reason = "Ninfer path not configured — open Settings and set the Ninfer path.".to_string();
        let mut eng = state.engine.write().await;
        fail_and_emit(
            &mut eng,
            state,
            "ninfer path not configured".to_string(),
            reason.clone(),
        );
        return Err(json!({
            "ok": false,
            "code": "not_configured",
            "message": reason,
        }));
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
        let reason = format!(
            "Engine binary not found at {} — point the Ninfer path at ninfer-serve (or its folder) in Settings.",
            engine_binary.display()
        );
        let mut eng = state.engine.write().await;
        fail_and_emit(
            &mut eng,
            state,
            format!("engine binary not found: {}", engine_binary.display()),
            reason.clone(),
        );
        return Err(json!({
            "ok": false,
            "code": "binary_missing",
            "message": reason,
        }));
    }
    Ok(engine_binary)
}

/// Resolve the model artifact to launch and guard against redundant spawns:
/// adopts an engine already serving `port` (rather than killing it) via the
/// shared `adopt_external` path, refuses a second concurrent spawn, and
/// validates the artifact exists. Returns the same early-return response
/// `start_engine` used to return inline for each guard.
async fn resolve_artifact(state: &S, port: u16, artifact: Option<String>) -> Result<String, Value> {
    // adopt-don't-kill: something already serves this port — same single path
    // as the refresh adopter (same-port pid policy, no cross-port fallback).
    if engine_health(port).await {
        let mut eng = state.engine.write().await;
        adopt_external(&mut eng, state, port).await;
        // Record the artifact the user asked to start (adopt keeps whatever
        // was already recorded, falling back to the discovered argv).
        if artifact.is_some() {
            eng.artifact = artifact;
        }
        return Err(json!({
            "ok": false,
            "code": "already_serving",
            "message": format!("an engine is already serving on port {port} (adopted as external)"),
            "engine": public_engine(&eng),
        }));
    }

    {
        let child = state.child.lock().await;
        if child.is_some() {
            return Err(json!({
                "ok": false,
                "code": "already_running",
                "message": "an engine spawn is already in progress"
            }));
        }
    }

    let Some(artifact) = artifact else {
        return Err(json!({
            "ok": false,
            "code": "no_artifact",
            "message": "select a downloaded .ninfer artifact first"
        }));
    };
    if tokio::fs::metadata(&artifact).await.is_err() {
        return Err(json!({
            "ok": false,
            "code": "artifact_missing",
            "message": format!("artifact not found: {artifact}")
        }));
    }
    Ok(artifact)
}

/// Open (creating if needed) the per-port engine log file, rotating it first
/// if it's grown too large. Returns the log path (recorded into engine state
/// for the UI) and the open file handle for the stdout/stderr pumps.
async fn open_engine_log(state: &S, port: u16) -> Result<(String, tokio::fs::File), Value> {
    let log_file_path = log_path_for(&state.data_dir, port);
    let _ = tokio::fs::create_dir_all(&state.data_dir).await;
    rotate_log_if_large(&log_file_path).await;
    match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
        .await
    {
        Ok(log) => Ok((log_file_path, log)),
        Err(_) => Err(json!({ "ok": false, "message": "could not open engine log file" })),
    }
}

/// Spawn the engine child process, pump its stdout/stderr into the already-open
/// log file, attach the child to shared state, then start the reaper and
/// health-poller background tasks. Returns the same `{ok: true, engine: ...}`
/// response `start_engine` used to return inline.
async fn spawn_and_attach(
    state: &S,
    engine_binary: &std::path::Path,
    artifact: &str,
    args: &[String],
    port: u16,
    log_file_path: String,
    log: tokio::fs::File,
) -> Value {
    {
        let mut eng = state.engine.write().await;
        eng.state = EngineState::Starting;
        eng.port = Some(port);
        eng.artifact = Some(artifact.to_string());
        eng.model_id = None;
        let mut argv = vec![artifact.to_string()];
        argv.extend(args.iter().cloned());
        eng.argv = Some(argv);
        eng.started_at = Some(now_ms());
        eng.log_path = Some(log_file_path);
        eng.adopted = false;
        eng.fail_reason = None;
        eng.deadline = Some(now_ms() + ENGINE_START_TIMEOUT_MS);
    }

    let mut cmd = tokio::process::Command::new(engine_binary);
    // Attach the FULL built command line. `args` carries every flag from the
    // user's profile (--port, --max-context, --kv-dtype, …); it was previously
    // only recorded into state.argv for display while the spawned process got
    // the artifact alone — so packaged apps launched engines at pure defaults
    // no matter what the GUI said.
    cmd.arg(artifact)
        .args(args)
        .current_dir(engine_binary.parent().unwrap_or(std::path::Path::new(".")))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let reason = format!("spawn failed: {e}");
            let mut eng = state.engine.write().await;
            fail_and_emit(&mut eng, state, reason.clone(), reason.clone());
            return json!({ "ok": false, "message": format!("spawn failed: {e}") });
        }
    };
    let pid = child.id();

    // pump stdout+stderr into the log file
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Some(stdout) = stdout
        && let Ok(la) = log.try_clone().await
    {
        tokio::spawn(async move {
            let mut la = la;
            let mut so = stdout;
            let _ = tokio::io::copy(&mut so, &mut la).await;
        });
    }
    if let Some(stderr) = stderr
        && let Ok(lb) = log.try_clone().await
    {
        tokio::spawn(async move {
            let mut lb = lb;
            let mut se = stderr;
            let _ = tokio::io::copy(&mut se, &mut lb).await;
        });
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

    spawn_reaper(state.clone());
    spawn_health_poller(state.clone(), port);

    let eng = state.engine.read().await;
    json!({ "ok": true, "engine": public_engine(&eng) })
}

/// Watch the spawned child and record its exit. The handle stays in
/// `state.child` (cleared only once the process is actually gone) so the
/// liveness checks in `refresh_engine_status` and the health poller keep
/// seeing a *live* child instead of a false "process exited" / "external".
fn spawn_reaper(state: S) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let exited = {
                let mut g = state.child.lock().await;
                match g.as_mut() {
                    Some(c) => c.try_wait().ok().flatten().is_some(),
                    None => return, // slot cleared (e.g. by stop_engine) — nothing to watch
                }
            };
            if exited {
                let mut eng = state.engine.write().await;
                if eng.state == EngineState::Starting || eng.state == EngineState::Running {
                    eng.mark_exited();
                }
                *state.child.lock().await = None;
                return;
            }
        }
    });
}

/// Poll engine health until it reports ready or the startup deadline passes,
/// then mark it failed and kill the child.
fn spawn_health_poller(state: S, port: u16) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(2000)).await;
            if engine_health(port).await {
                let mut eng = state.engine.write().await;
                if eng.state == EngineState::Starting || eng.state == EngineState::Running {
                    eng.state = EngineState::Running;
                    if eng.model_id.is_none() {
                        let (mid, mctx) = engine_model_info(state.as_ref(), port).await;
                        eng.assign_model_info(mid, mctx);
                    }
                }
                return;
            }
            let mut eng = state.engine.write().await;
            if let Some(deadline) = eng.deadline
                && now_ms() > deadline
            {
                eng.mark_failed(start_timeout_message());
                drop(eng);
                let mut c = state.child.lock().await;
                if let Some(c) = c.as_mut() {
                    let _ = c.start_kill();
                }
                return;
            }
        }
    });
}

pub async fn start_engine(state: &S, profile: EngineProfile, artifact: Option<String>) -> Value {
    let cfg = state.config.read().await.clone();

    let engine_binary = match validate_launch(state, &cfg).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };

    let port = profile.port.unwrap_or(cfg.engine_port);
    let artifact = artifact.filter(|a| !a.is_empty());

    let artifact = match resolve_artifact(state, port, artifact).await {
        Ok(a) => a,
        Err(resp) => return resp,
    };

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

    let (log_file_path, log) = match open_engine_log(state, port).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    spawn_and_attach(state, &engine_binary, &artifact, &args, port, log_file_path, log).await
}

pub async fn stop_engine(state: &S, external_pid: Option<u32>) -> Value {
    // 1) our own child: SIGTERM with 8s grace
    {
        let child = state.child.lock().await;
        if child.is_some() {
            drop(child);
            {
                let mut eng = state.engine.write().await;
                eng.begin_stopping();
            }
            let proc = state.child.lock().await.take();
            if let Some(mut proc) = proc {
                let _ = proc.start_kill();
                let _ = tokio::time::timeout(Duration::from_secs(8), proc.wait()).await;
                let mut eng = state.engine.write().await;
                eng.reset_stopped();
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
            (eng.state == EngineState::External, eng.port)
        };
        if is_external {
            // Same pid policy as adoption: only signal the process actually
            // serving this engine's port (see `resolve_external_pid`).
            let all = discover_engines().await;
            let cfg_port = state.config.read().await.engine_port;
            let pid = resolve_external_pid(&all, port, cfg_port);
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
                    eng.reset_stopped();
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
        eng.begin_stopping();
    }
    let ok = signal_engine_pid(target);
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let mut eng = state.engine.write().await;
    eng.reset_stopped();
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

