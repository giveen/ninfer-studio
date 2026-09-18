//! Engine source management: git pull + rebuild of the NInfer engine.

// Rust guideline compliant 2026-07-28

use crate::clear_appimage_env;
use crate::types::{AppEvent, State, now_ms};
use serde_json::{Value, json};
use std::sync::Arc;

pub type S = Arc<State>;

/// Start a pull or build job. Only one job at a time.
pub async fn start_update(state: &S, action: &str) -> Value {
    match action {
        "pull" | "build" => {}
        _ => return json!({ "ok": false, "message": "action must be 'pull' or 'build'" }),
    }

    let id = format!("upd_{:x}_{}", now_ms(), std::process::id());

    // single job at a time - reserve slot up-front under lock
    {
        let mut job = state.update_job.lock().await;
        if let Some(j) = job.as_ref()
            && !j.done
        {
            let act = j.action.as_deref().unwrap_or("job");
            let article = if act.starts_with(['a', 'e', 'i', 'o', 'u']) { "an" } else { "a" };
            return json!({
                "ok": false,
                "message": format!(
                    "{} {} job is already running (pid {:?})",
                    article, act, j.pid
                )
            });
        }
        // Reserve job slot
        *job = Some(crate::types::JobRec {
            id: id.clone(),
            action: Some(action.to_string()),
            cmd: None,
            repo: None,
            file: None,
            local_dir: None,
            pid: None,
            out: String::new(),
            exit_code: None,
            done: false,
            failed: false,
            total_bytes: None,
            downloaded_bytes: None,
            speed_bps: None,
            started_at: now_ms(),
        });
    }

    let res_id = id.clone();
    // Helper to fail the reserved job slot cleanly if validation/spawn fails
    let fail_reservation = |msg: String| async move {
        let mut j = state.update_job.lock().await;
        if let Some(r) = j.as_mut()
            && r.id == res_id
        {
            r.done = true;
            r.failed = true;
            r.exit_code = Some(-1);
            crate::append_log_line(&mut r.out, &format!("✗ {msg}"), crate::LOG_TAIL_LINES);
        }
        json!({ "ok": false, "message": msg })
    };

    let cfg = state.config.read().await.clone();
    let repo = cfg.ninfer_path.clone();
    if repo.is_empty() {
        return fail_reservation("Ninfer path is not configured".to_string()).await;
    }

    let Ok(md) = tokio::fs::metadata(&repo).await else {
        return fail_reservation(format!("repo dir not found: {repo}")).await;
    };
    if !md.is_dir() {
        return fail_reservation(format!("not a directory: {repo}")).await;
    }

    let cmd = match action {
        "pull" => {
            // verify it's a git work tree up front (clearer error than a mid-stream fail)
            let probe = tokio::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .arg("rev-parse")
                .arg("--is-inside-work-tree")
                .output()
                .await;
            match probe {
                Ok(o) if o.status.success() => {}
                _ => {
                    return fail_reservation(format!("{repo} is not a git work tree")).await;
                }
            }
            format!("git -C {repo:?} pull --ff-only")
        }
        "build" => cfg.build_command.clone(),
        _ => unreachable!(),
    };
    if action == "build" && cmd.is_empty() {
        return fail_reservation("buildCommand is not configured".to_string()).await;
    }

    // Rebuilding links a fresh build/apps/ninfer-serve — over a running engine
    // the link step fails (text file busy) or the binary is clobbered
    // mid-execution. Stop the engine first and let the kernel release the file.
    let mut stopped_note = String::new();
    let mut engine_was_running = false;
    if action == "build" {
        engine_was_running = {
            let eng = state.engine.read().await;
            matches!(
                eng.state,
                crate::types::EngineState::Running
                    | crate::types::EngineState::Starting
                    | crate::types::EngineState::Stopping
            ) && eng.pid.is_some()
        };
        if engine_was_running {
            crate::engine::stop_engine(state, None).await;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            stopped_note = "▪ engine was stopped for the rebuild\n".into();
        }
    }

    // Update reservation with cmd and initial out
    {
        let mut j = state.update_job.lock().await;
        if let Some(r) = j.as_mut()
            && r.id == id
        {
            r.cmd = Some(cmd.clone());
            r.out = stopped_note;
        } else {
            return json!({ "ok": false, "message": "job reservation was cancelled" });
        }
    }

    // "pull" runs `git` directly (no shell) so a repo path with spaces or
    // shell metacharacters can't break out of the intended command — the
    // path comes from user-editable config, reachable via `PUT /api/config`.
    // "build" keeps `sh -c` since `buildCommand` is meant to be a shell
    // command the user writes themselves.
    let mut proc_cmd = if action == "pull" {
        let mut c = tokio::process::Command::new("git");
        c.arg("-C").arg(&repo).arg("pull").arg("--ff-only");
        c
    } else {
        let mut c = tokio::process::Command::new("sh");
        c.arg("-c").arg(&cmd);
        c
    };
    proc_cmd
        .current_dir(&repo)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    clear_appimage_env(&mut proc_cmd);
    let Ok(mut child) = proc_cmd.spawn() else {
        return fail_reservation(format!("could not spawn: {cmd}")).await;
    };

    let child_pid = child.id();
    {
        let mut j = state.update_job.lock().await;
        if let Some(r) = j.as_mut()
            && r.id == id
        {
            r.pid = child_pid;
        }
    }

    // pump stdout + stderr (keep last 2000 lines)
    if let Some(stdout) = child.stdout.take() {
        let st = state.clone();
        let id_clone = id.clone();
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stdout);
            crate::pump_log_lines(lines, |line| {
                let st = st.clone();
                let id = id_clone.clone();
                async move {
                    let mut j = st.update_job.lock().await;
                    if let Some(r) = j.as_mut()
                        && r.id == id
                    {
                        crate::append_log_line(&mut r.out, &line, crate::LOG_TAIL_LINES);
                    }
                }
            })
            .await;
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let st = state.clone();
        let id_clone = id.clone();
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stderr);
            crate::pump_log_lines(lines, |line| {
                let st = st.clone();
                let id = id_clone.clone();
                async move {
                    let mut j = st.update_job.lock().await;
                    if let Some(r) = j.as_mut()
                        && r.id == id
                    {
                        crate::append_log_line(&mut r.out, &line, crate::LOG_TAIL_LINES);
                    }
                }
            })
            .await;
        });
    }

    // reap exit
    let st = state.clone();
    let id_clone = id.clone();
    tokio::spawn(async move {
        let code = child.wait().await.ok().map(|s| s.code().unwrap_or(-1));
        let (action, ok) = {
            let mut j = st.update_job.lock().await;
            match j.as_mut() {
                Some(r) if r.id == id_clone => {
                    r.exit_code = code;
                    r.done = true;
                    r.failed = code.map(|c| c != 0).unwrap_or(true);
                    if !r.failed {
                        crate::append_log_line(&mut r.out, "✓ done (exit 0)", crate::LOG_TAIL_LINES);
                    } else {
                        crate::append_log_line(
                            &mut r.out,
                            &format!("✗ failed (exit {:?})", code),
                            crate::LOG_TAIL_LINES,
                        );
                    }
                    (r.action.clone().unwrap_or_default(), !r.failed)
                }
                _ => (String::new(), false),
            }
        };

        if action == "build" && ok && engine_was_running {
            let (profile, artifact) = {
                let ls = st.last_start.read().await;
                match ls.as_ref() {
                    Some(l) => (l.profile.clone(), l.artifact.clone()),
                    None => (crate::types::EngineProfile::default(), None),
                }
            };
            crate::engine::start_engine(&st, profile, artifact).await;
        }

        st.emit(AppEvent::BuildFinished { action, ok });
    });

    json!({ "ok": true, "id": id, "cmd": cmd })
}

/// Cancel a running update job.
pub async fn cancel_update(state: &S) -> Value {
    let pid = {
        let mut j = state.update_job.lock().await;
        let Some(r) = j.as_mut() else {
            return json!({ "ok": false, "message": "no update job running" });
        };
        if r.done {
            return json!({ "ok": false, "message": "update job already completed" });
        }
        r.done = true;
        r.failed = true;
        r.exit_code = Some(-1);
        crate::append_log_line(&mut r.out, "✗ cancelled by user", crate::LOG_TAIL_LINES);
        r.pid
    };

    if let Some(pid) = pid {
        #[cfg(unix)]
        {
            let _ = tokio::process::Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .output()
                .await;
        }
        #[cfg(windows)]
        {
            let _ = tokio::process::Command::new("taskkill")
                .arg("/F")
                .arg("/PID")
                .arg(pid.to_string())
                .output()
                .await;
        }
    }

    json!({ "ok": true, "message": "update job cancelled" })
}

/// Serialize the current/last update job (camelCase, for the UI).
pub async fn update_public(state: &S) -> Option<Value> {
    let j = state.update_job.lock().await;
    j.as_ref().and_then(|r| serde_json::to_value(r).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> S {
        let dir = std::env::temp_dir().join(format!("ninfer_repo_test_{}", now_ms()));
        Arc::new(State::new(dir.clone(), dir, None))
    }

    #[tokio::test]
    async fn test_start_update_concurrency_and_grammar() {
        let state = test_state();

        // Place an active pull job in update_job
        {
            let mut j = state.update_job.lock().await;
            *j = Some(crate::types::JobRec {
                id: "test_1".to_string(),
                action: Some("pull".to_string()),
                cmd: None,
                repo: None,
                file: None,
                local_dir: None,
                pid: Some(12345),
                out: String::new(),
                exit_code: None,
                done: false,
                failed: false,
                total_bytes: None,
                downloaded_bytes: None,
                speed_bps: None,
                started_at: now_ms(),
            });
        }

        let res = start_update(&state, "build").await;
        assert_eq!(res.get("ok").and_then(|v| v.as_bool()), Some(false));
        let msg = res.get("message").and_then(|v| v.as_str()).unwrap_or("");
        assert!(
            msg.contains("a pull job is already running"),
            "expected 'a pull job', got '{msg}'"
        );
    }

    #[tokio::test]
    async fn test_start_update_unconfigured_ninfer_path() {
        let state = test_state();
        let res = start_update(&state, "pull").await;
        assert_eq!(res.get("ok").and_then(|v| v.as_bool()), Some(false));
        let pub_val = update_public(&state).await.expect("reserved job record should exist");
        assert_eq!(pub_val.get("done").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(pub_val.get("failed").and_then(|v| v.as_bool()), Some(true));
    }

    #[tokio::test]
    async fn test_cancel_update() {
        let state = test_state();
        {
            let mut j = state.update_job.lock().await;
            *j = Some(crate::types::JobRec {
                id: "test_cancel".to_string(),
                action: Some("build".to_string()),
                cmd: Some("sleep 10".to_string()),
                repo: None,
                file: None,
                local_dir: None,
                pid: None,
                out: String::new(),
                exit_code: None,
                done: false,
                failed: false,
                total_bytes: None,
                downloaded_bytes: None,
                speed_bps: None,
                started_at: now_ms(),
            });
        }

        let res = cancel_update(&state).await;
        assert_eq!(res.get("ok").and_then(|v| v.as_bool()), Some(true));

        let pub_val = update_public(&state).await.expect("job record exists");
        assert_eq!(pub_val.get("done").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(pub_val.get("failed").and_then(|v| v.as_bool()), Some(true));
        let out = pub_val.get("out").and_then(|v| v.as_str()).unwrap_or("");
        assert!(out.contains("✗ cancelled by user"));
    }
}

