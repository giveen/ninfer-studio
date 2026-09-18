//! Engine spawn / stop / signal + the public engine view.
use super::S;
use super::discover::discover_engines;
use super::health::{argv_max_context, engine_health, engine_model_info};
use super::log::{log_path_for, rotate_log_if_large};
use super::status::{adopt_external, resolve_external_pid};
use crate::types::{
    AppEvent, AppSettings, EngineInner, EngineProfile, EngineState, EngineStatus, LastStart, State,
    build_serve_args, now_ms,
};
use serde_json::{Value, json};
use std::time::Duration;

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
        let reason =
            "Ninfer path not configured — open Settings and set the Ninfer path.".to_string();
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
    // Resolve the engine binary from the configured path. Accepts:
    //   * a direct file path, e.g. E:\ninfer-windows-...\ninfer-serve.exe
    //   * a directory containing ninfer-serve.exe / ninfer-serve (Windows / Linux layout)
    //   * a directory with build/apps/ninfer-serve (.exe on Windows) (dev checkout)
    let configured = std::path::Path::new(ninfer_path);
    let dev_bin_name = if cfg!(windows) {
        "build/apps/ninfer-serve.exe"
    } else {
        "build/apps/ninfer-serve"
    };
    let engine_binary = if configured.is_file() {
        configured.to_path_buf()
    } else if configured.join("ninfer-serve.exe").is_file() {
        configured.join("ninfer-serve.exe")
    } else if configured.join("ninfer-serve").is_file() {
        configured.join("ninfer-serve")
    } else {
        configured.join(dev_bin_name)
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
    if engine_health(state.as_ref(), port).await {
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

    let artifact_path = std::path::Path::new(&artifact);

    // Check for v2 artifacts which are no longer supported by ninfer-serve
    if let Ok(mut f) = tokio::fs::File::open(artifact_path).await {
        use tokio::io::AsyncReadExt;
        let mut magic = [0u8; 8];
        if f.read_exact(&mut magic).await.is_ok()
            && (magic.starts_with(b"NINFER\0") || magic.starts_with(b"NINPRT\0"))
        {
            let version = magic[7] as u32;
            if version < 3 {
                return Err(json!({
                    "ok": false,
                    "message": "ninfer-serve requires v3 artifacts. Please upgrade this v2 artifact in the Models tab."
                }));
            }
        }
    }

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
        Ok(mut log) => {
            use tokio::io::AsyncWriteExt;
            let marker = format!("{}\n", super::log::ENGINE_START_MARKER);
            let _ = log.write_all(marker.as_bytes()).await;
            let _ = log.flush().await;
            Ok((log_file_path, log))
        }
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
    let epoch = {
        let mut eng = state.engine.write().await;
        eng.spawn_epoch += 1;
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
        eng.spawn_epoch
    };

    let mut cmd = tokio::process::Command::new(engine_binary);
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

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let log_clone_a = log.try_clone().await.ok();
    let log_clone_b = log.try_clone().await.ok();

    if let Some(stdout) = stdout
        && let Some(mut la) = log_clone_a
    {
        tokio::spawn(async move {
            let mut so = stdout;
            let _ = tokio::io::copy(&mut so, &mut la).await;
        });
    }
    if let Some(stderr) = stderr
        && let Some(mut lb) = log_clone_b
    {
        tokio::spawn(async move {
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

    spawn_reaper(state.clone(), epoch);
    spawn_health_poller(state.clone(), port, epoch);

    let eng = state.engine.read().await;
    json!({ "ok": true, "engine": public_engine(&eng) })
}

/// Watch the spawned child and record its exit. Bound to a specific `epoch`.
fn spawn_reaper(state: S, epoch: u64) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if state.engine.read().await.spawn_epoch != epoch {
                return; // Stale reaper from prior spawn
            }
            let exited = {
                let mut g = state.child.lock().await;
                match g.as_mut() {
                    Some(c) => c.try_wait().ok().flatten().is_some(),
                    None => return,
                }
            };
            if exited {
                let mut eng = state.engine.write().await;
                if eng.spawn_epoch == epoch
                    && (eng.state == EngineState::Starting || eng.state == EngineState::Running)
                {
                    eng.mark_exited();
                }
                *state.child.lock().await = None;
                return;
            }
        }
    });
}

/// Poll engine health until it reports ready or the startup deadline passes,
/// then mark it failed and kill the child. Bound to a specific `epoch`.
fn spawn_health_poller(state: S, port: u16, epoch: u64) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(2000)).await;
            if state.engine.read().await.spawn_epoch != epoch {
                return; // Stale poller from prior spawn
            }

            if engine_health(state.as_ref(), port).await {
                if state.engine.read().await.spawn_epoch != epoch {
                    return;
                }
                // Perform model info probe outside of engine write lock
                let (mid, mctx) = engine_model_info(state.as_ref(), port).await;

                let mut eng = state.engine.write().await;
                if eng.spawn_epoch == epoch
                    && (eng.state == EngineState::Starting || eng.state == EngineState::Running)
                {
                    eng.state = EngineState::Running;
                    if eng.model_id.is_none() {
                        eng.assign_model_info(mid, mctx);
                    }
                }
                return;
            }

            if state.engine.read().await.spawn_epoch != epoch {
                return;
            }

            let mut eng = state.engine.write().await;
            if eng.spawn_epoch == epoch
                && let Some(deadline) = eng.deadline
                && now_ms() > deadline
            {
                let msg = start_timeout_message();
                fail_and_emit(&mut eng, state.as_ref(), msg.clone(), msg);
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

    let (log_file_path, log) = match open_engine_log(state, port).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    let resp = spawn_and_attach(
        state,
        &engine_binary,
        &artifact,
        &args,
        port,
        log_file_path,
        log,
    )
    .await;

    if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let last_start = LastStart {
            port,
            profile: profile.clone(),
            artifact: Some(artifact.clone()),
            at: now_ms(),
        };
        *state.last_start.write().await = Some(last_start.clone());
        let path = state.data_dir.join("last-start.json");
        let _ = crate::atomic_write(
            &path,
            serde_json::to_string(&last_start).unwrap_or_default(),
        )
        .await;
    }

    resp
}

/// Gracefully terminate a spawned child process with SIGTERM, waiting up to 8s
/// before escalating to SIGKILL.
async fn graceful_kill_child(proc: &mut tokio::process::Child) {
    #[cfg(unix)]
    {
        if let Some(pid) = proc.id() {
            let _ = signal_engine_pid(pid);
        }
        if tokio::time::timeout(Duration::from_secs(8), proc.wait())
            .await
            .is_err()
        {
            let _ = proc.start_kill();
            let _ = proc.wait().await;
        }
    }
    #[cfg(windows)]
    {
        let _ = proc.start_kill();
        let _ = proc.wait().await;
    }
}

pub async fn stop_engine(state: &S, external_pid: Option<u32>) -> Value {
    // 1) our own child: SIGTERM with 8s grace using atomic single-lock take
    let child_proc = state.child.lock().await.take();
    if let Some(mut proc) = child_proc {
        {
            let mut eng = state.engine.write().await;
            eng.begin_stopping();
        }
        graceful_kill_child(&mut proc).await;
        let mut eng = state.engine.write().await;
        eng.reset_stopped();
        return json!({ "ok": true, "message": "engine stopped" });
    }

    // 2) explicit pid or adopted external (validated against discover_engines)
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
            let all = discover_engines().await;
            let cfg_port = state.config.read().await.engine_port;
            let pid = resolve_external_pid(&all, port, cfg_port);
            match pid {
                None => {
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

    // Validate that target PID is a valid discovered ninfer-serve process owned by current user
    let all = discover_engines().await;
    let cfg_port = state.config.read().await.engine_port;
    let validated_pid = resolve_external_pid(&all, state.engine.read().await.port, cfg_port);
    if validated_pid != Some(target) && !all.iter().any(|d| d.pid == target) {
        return json!({
            "ok": false,
            "message": format!("target pid {target} is not a valid discovered ninfer-serve process")
        });
    }

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
/// so force-kill via `taskkill /F`.
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
    let status = EngineStatus {
        state: eng.state,
        pid: eng.pid,
        port: eng.port,
        artifact: eng.artifact.clone(),
        model_id: eng.model_id.clone(),
        max_context: eng.max_context.or_else(|| argv_max_context(eng.argv.as_ref())),
        argv: eng.argv.clone(),
        started_at: eng.started_at,
        log_path: eng.log_path.clone(),
        adopted: eng.adopted,
        fail_reason: eng.fail_reason.clone(),
        fail_hint: None,
    };
    serde_json::to_value(status).unwrap_or_default()
}

#[cfg(test)]
mod launch_tests {
    use super::*;

    #[test]
    fn timeout_message_matches_constant() {
        assert!(start_timeout_message().contains("3 minutes"));
    }

    #[test]
    fn public_engine_serialization_shape() {
        let eng = EngineInner {
            state: EngineState::Running,
            pid: Some(1234),
            port: Some(8080),
            artifact: Some("model.ninfer".to_string()),
            model_id: Some("qwen2.5-coder".to_string()),
            max_context: Some(32768),
            argv: Some(vec!["model.ninfer".to_string(), "--port".to_string(), "8080".to_string()]),
            started_at: Some(1000),
            log_path: Some("/tmp/engine-8080.log".to_string()),
            adopted: false,
            fail_reason: None,
            deadline: None,
            spawn_epoch: 1,
        };
        let pub_json = public_engine(&eng);
        assert_eq!(pub_json["pid"], 1234);
        assert_eq!(pub_json["port"], 8080);
        assert_eq!(pub_json["artifact"], "model.ninfer");
        assert_eq!(pub_json["modelId"], "qwen2.5-coder");
        assert_eq!(pub_json["maxContext"], 32768);
    }
}
