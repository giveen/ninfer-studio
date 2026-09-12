//! Engine source management: git pull + rebuild of the NInfer engine.

// Rust guideline compliant 2026-07-28

use crate::types::{AppEvent, State, now_ms};
use serde_json::{json, Value};
use std::sync::Arc;

pub type S = Arc<State>;

/// Start a pull or build job. Only one job at a time.
pub async fn start_update(state: &S, action: &str) -> Value {
    match action {
        "pull" | "build" => {}
        _ => return json!({ "ok": false, "message": "action must be 'pull' or 'build'" }),
    }

    // single job at a time
    {
        let job = state.update_job.lock().await;
        if let Some(j) = job.as_ref() {
            if !j.done {
                return json!({
                    "ok": false,
                    "message": format!(
                        "an {} job is already running (pid {:?})",
                        j.action.as_deref().unwrap_or("?"),
                        j.pid
                    )
                });
            }
        }
    }

    let cfg = state.config.read().await.clone();
    let repo = cfg.ninfer_path.clone();
    if repo.is_empty() {
        return json!({ "ok": false, "message": "Ninfer path is not configured" });
    }

    let Ok(md) = tokio::fs::metadata(&repo).await else {
        return json!({ "ok": false, "message": format!("repo dir not found: {repo}") });
    };
    if !md.is_dir() {
        return json!({ "ok": false, "message": format!("not a directory: {repo}") });
    }

    let cmd = match action {
        "pull" => {
            // verify it's a git work tree up front (clearer error than a mid-stream fail)
            let probe = std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .arg("rev-parse")
                .arg("--is-inside-work-tree")
                .output();
            match probe {
                Ok(o) if o.status.success() => {}
                _ => {
                    return json!({
                        "ok": false,
                        "message": format!("{repo} is not a git work tree")
                    })
                }
            }
            format!("git -C {repo} pull --ff-only")
        }
        "build" => cfg.build_command.clone(),
        _ => unreachable!(),
    };
    if cmd.is_empty() {
        return json!({ "ok": false, "message": "buildCommand is not configured" });
    }

    // Rebuilding links a fresh build/apps/ninfer-serve — over a running engine
    // the link step fails (text file busy) or the binary is clobbered
    // mid-execution. Stop the engine first and let the kernel release the file.
    let mut stopped_note = String::new();
    if action == "build" {
        let running = {
            let eng = state.engine.read().await;
            matches!(eng.state, crate::types::EngineState::Running | crate::types::EngineState::Starting | crate::types::EngineState::Stopping) && eng.pid.is_some()
        };
        if running {
            crate::engine::stop_engine(state, None).await;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            stopped_note = "▪ engine was stopped for the rebuild\n".into();
        }
    }

    let id = format!("upd_{:x}_{}", now_ms(), std::process::id());
    let mut rec = crate::types::JobRec {
        id: id.clone(),
        action: Some(action.to_string()),
        cmd: Some(cmd.clone()),
        repo: None,
        file: None,
        local_dir: None,
        pid: None,
        out: stopped_note,
        exit_code: None,
        done: false,
        failed: false,
        total_bytes: None,
        downloaded_bytes: None,
        speed_bps: None,
        started_at: now_ms(),
    };

    let Ok(mut child) = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&cmd)
        .current_dir(&repo)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    else {
        return json!({ "ok": false, "message": format!("could not spawn: {cmd}") });
    };
    rec.pid = child.id();
    {
        let mut j = state.update_job.lock().await;
        *j = Some(rec);
    }

    // pump stdout + stderr (keep last 2000 lines)
    if let Some(stdout) = child.stdout.take() {
        let st = state.clone();
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stdout);
            crate::pump_log_lines(lines, |line| {
                let st = st.clone();
                async move {
                    let mut j = st.update_job.lock().await;
                    if let Some(r) = j.as_mut() {
                        crate::append_log_line(&mut r.out, &line, crate::LOG_TAIL_LINES);
                    }
                }
            })
            .await;
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let st = state.clone();
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stderr);
            crate::pump_log_lines(lines, |line| {
                let st = st.clone();
                async move {
                    let mut j = st.update_job.lock().await;
                    if let Some(r) = j.as_mut() {
                        crate::append_log_line(&mut r.out, &line, crate::LOG_TAIL_LINES);
                    }
                }
            })
            .await;
        });
    }

    // reap exit
    let st = state.clone();
    tokio::spawn(async move {
        let code = child.wait().await.ok().map(|s| s.code().unwrap_or(-1));
        let (action, ok) = {
            let mut j = st.update_job.lock().await;
            match j.as_mut() {
                Some(r) => {
                    r.exit_code = code;
                    r.done = true;
                    r.failed = code.map(|c| c != 0).unwrap_or(true);
                    if !r.failed {
                        r.out.push_str("\n✓ done (exit 0)");
                    } else {
                        r.out.push_str(&format!("\n✗ failed (exit {:?})", code));
                    }
                    (r.action.clone().unwrap_or_default(), !r.failed)
                }
                None => (String::new(), false),
            }
        };
        st.emit(AppEvent::BuildFinished { action, ok });
    });

    json!({ "ok": true, "id": id, "cmd": cmd })
}

/// Serialize the current/last update job (camelCase, for the UI).
pub async fn update_public(state: &S) -> Option<Value> {
    let j = state.update_job.lock().await;
    j.as_ref().and_then(|r| serde_json::to_value(r).ok())
}
