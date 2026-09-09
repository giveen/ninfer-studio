//! Engine source management: git pull + rebuild of the NInfer engine.

use crate::types::{AppEvent, State, now_ms};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;

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
                    "message": format!("an {} job is already running (pid {:?})", j.action, j.pid)
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

    let id = format!("upd_{:x}_{}", now_ms(), std::process::id());
    let mut rec = crate::types::UpdateJob {
        id: id.clone(),
        action: action.to_string(),
        cmd: cmd.clone(),
        pid: None,
        out: String::new(),
        exit_code: None,
        done: false,
        failed: false,
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
    rec.pid = child.id().map(|p| p as u32);
    {
        let mut j = state.update_job.lock().await;
        *j = Some(rec);
    }

    // pump stdout + stderr (keep last 2000 lines)
    if let Some(stdout) = child.stdout.take() {
        let st = state.clone();
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stdout);
            pump_lines(st, lines).await;
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let st = state.clone();
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stderr);
            pump_lines(st, lines).await;
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
                    (r.action.clone(), !r.failed)
                }
                None => (String::new(), false),
            }
        };
        st.emit(AppEvent::BuildFinished { action, ok });
    });

    json!({ "ok": true, "id": id, "cmd": cmd })
}

async fn pump_lines<S>(st: Arc<State>, mut lines: S)
where
    S: tokio::io::AsyncBufRead + Unpin,
{
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = match lines.read_line(&mut buf).await {
            Ok(n) if n > 0 => n,
            _ => break,
        };
        let _ = n;
        let line: String = buf.chars().take(2000).collect();
        let mut j = st.update_job.lock().await;
        if let Some(r) = j.as_mut() {
            let mut lines: Vec<&str> = r.out.lines().chain(std::iter::once(line.as_str())).collect();
            if lines.len() > 2000 {
                lines = lines.split_off(lines.len() - 2000);
            }
            r.out = lines.join("\n");
        }
    }
}

/// Serialize the current/last update job (camelCase, for the UI).
pub async fn update_public(state: &S) -> Option<Value> {
    let j = state.update_job.lock().await;
    j.as_ref().map(|r| {
        json!({
            "id": r.id,
            "action": r.action,
            "cmd": r.cmd,
            "pid": r.pid,
            "out": r.out,
            "exitCode": r.exit_code,
            "done": r.done,
            "failed": r.failed,
            "startedAt": r.started_at,
        })
    })
}
