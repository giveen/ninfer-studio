//! Models directory scanning + Hugging Face download supervision.

use crate::types::{now_ms, AppEvent, ARTIFACTS, DownloadRec, ModelArtifact, State};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::AsyncBufReadExt;

pub async fn list_models(state: &State) -> Value {
    let dir = state.config.read().await.models_dir.clone();
    let mut artifacts: Vec<ModelArtifact> = Vec::new();
    let Ok(entries) = tokio::fs::read_dir(&dir).await else {
        return json!({ "dir": dir, "artifacts": [] });
    };
    let mut entries = entries;
    let mut names: Vec<String> = Vec::new();
    while let Ok(Some(e)) = entries.next_entry().await {
        let n = e.file_name().to_string_lossy().to_string();
        if n.ends_with(".ninfer") {
            names.push(n);
        }
    }
    names.sort();
    for name in names {
        let full = format!("{dir}/{name}");
        let Ok(md) = tokio::fs::metadata(&full).await else {
            continue;
        };
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let known = ARTIFACTS.iter().find(|a| a.file == name).cloned();
        artifacts.push(ModelArtifact {
            file: name.clone(),
            path: full,
            size: md.len(),
            mtime,
            model_id: known.as_ref().map(|k| k.model_id.to_string()),
            model: known.as_ref().map(|k| k.model.to_string()),
            weights: known.as_ref().map(|k| k.weights.to_string()),
            repo: known.as_ref().map(|k| k.repo.to_string()),
            known,
        });
    }
    json!({ "dir": dir, "artifacts": artifacts })
}

pub async fn start_download(state: &Arc<State>, body: Value) -> Value {
    let repo = body.get("repo").and_then(|v| v.as_str()).unwrap_or("");
    let file = body.get("file").and_then(|v| v.as_str()).unwrap_or("");
    if repo.is_empty() || file.is_empty() {
        return json!({ "ok": false, "message": "repo and file are required" });
    }
    let cfg = state.config.read().await.clone();
    let dir = body
        .get("localDir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or(cfg.models_dir.clone());
    let cli = cfg.hf_cli.clone();
    let _ = tokio::fs::create_dir_all(&dir).await;
    let total_bytes = fetch_download_size(&cli, &repo, &file, &dir).await;

    let id = format!(
        "dl_{:x}_{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        std::process::id()
    );

    let Ok(mut child) = tokio::process::Command::new(&cli)
        .arg("download")
        .arg(repo)
        .arg(file)
        .arg("--local-dir")
        .arg(&dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    else {
        return json!({ "ok": false, "message": format!("could not spawn {cli}") });
    };
    let pid = child.id();

    {
        let mut d = state.downloads.lock().await;
        d.insert(
            id.clone(),
            DownloadRec {
                id: id.clone(),
                repo: repo.to_string(),
                file: file.to_string(),
                local_dir: dir.clone(),
                pid: pid.map(|p| p as u32),
                out: String::new(),
                exit_code: None,
                done: false,
                failed: false,
                total_bytes,
                downloaded_bytes: 0,
                speed_bps: 0.0,
                started_at: now_ms(),
            },
        );
    }

    // pump output lines into the record (keep last 2000 lines)
    let st = state.clone();
    let id2 = id.clone();
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stdout);
            pump_lines(st, id2, lines).await;
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let st = state.clone();
        let id = id.clone();
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stderr);
            pump_lines(st, id, lines).await;
        });
    }

    // progress monitor: sample the staging blob size on disk every 400ms
    {
        let st = state.clone();
        let idm = id.clone();
        let dir_m = dir.clone();
        tokio::spawn(async move {
            let mut last = 0u64;
            let mut last_t = std::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                let cur = largest_file_size_under(std::path::Path::new(&dir_m));
                let now = std::time::Instant::now();
                let dt = now.duration_since(last_t).as_secs_f64();
                let finished = {
                    let mut d = st.downloads.lock().await;
                    match d.get_mut(&idm) {
                        Some(r) => {
                            if dt > 0.0 && cur >= last {
                                r.speed_bps = (cur - last) as f64 / dt;
                            }
                            r.downloaded_bytes = cur;
                            r.done
                        }
                        None => true,
                    }
                };
                if finished {
                    break;
                }
                last = cur;
                last_t = now;
            }
        });
    }

    // reap exit status
    let st = state.clone();
    let id3 = id.clone();
    tokio::spawn(async move {
        let code = child.wait().await.ok().map(|s| s.code().unwrap_or(-1));
        let (file, ok) = {
            let mut d = st.downloads.lock().await;
            match d.get_mut(&id3) {
                Some(r) => {
                    r.exit_code = code;
                    r.done = true;
                    r.failed = code.map(|c| c != 0).unwrap_or(true);
                    if let Some(t) = r.total_bytes {
                        r.downloaded_bytes = t;
                    }
                    r.speed_bps = 0.0;
                    (r.file.clone(), !r.failed)
                }
                None => (id3.clone(), false),
            }
        };
        st.emit(AppEvent::DownloadFinished { file, ok });
    });

    json!({ "ok": true, "id": id })
}

async fn pump_lines<S>(st: Arc<State>, id: String, mut lines: S)
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
        let mut d = st.downloads.lock().await;
        if let Some(r) = d.get_mut(&id) {
            // keep the most recent 2000 lines
            let mut lines: Vec<&str> = r.out.lines().chain(std::iter::once(line.as_str())).collect();
            if lines.len() > 2000 {
                lines = lines.split_off(lines.len() - 2000);
            }
            r.out = lines.join("\n");
        }
    }
}

/// Parse a human size string like "20.4G" / "512M" / "1024" into bytes.
fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim();
    let (num, unit) = match s.chars().last() {
        Some(c) if c.is_alphabetic() => (s[..s.len() - 1].trim(), c.to_ascii_lowercase().to_string()),
        _ => (s, String::new()),
    };
    let v: f64 = num.parse().ok()?;
    let mult = match unit.as_str() {
        "k" => 1024.0,
        "m" => 1024.0 * 1024.0,
        "g" => 1024.0 * 1024.0 * 1024.0,
        "t" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    Some((v * mult) as u64)
}

/// Largest file size anywhere under `root` — the in-progress staging blob is
/// the largest file during a download, so this yields downloaded bytes.
fn largest_file_size_under(root: &std::path::Path) -> u64 {
    let mut max = 0u64;
    fn walk(dir: &std::path::Path, max: &mut u64) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, max);
                } else if let Ok(m) = e.metadata() {
                    if m.len() > *max {
                        *max = m.len();
                    }
                }
            }
        }
    }
    walk(root, &mut max);
    max
}

/// Resolve the total download size via `hf download --dry-run --json` (no
/// actual network transfer). Returns None if the size can't be determined.
async fn fetch_download_size(cli: &str, repo: &str, file: &str, dir: &str) -> Option<u64> {
    let out = tokio::process::Command::new(cli)
        .arg("download")
        .arg(repo)
        .arg(file)
        .arg("--local-dir")
        .arg(dir)
        .arg("--dry-run")
        .arg("--json")
        .output()
        .await
        .ok()?;
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    let arr = v.as_array()?;
    let first = arr.first()?;
    let size = first.get("size")?.as_str()?;
    parse_size(size)
}

pub async fn downloads_public(state: &State) -> Vec<Value> {
    let d = state.downloads.lock().await;
    d.values()
        .map(|r| {
            json!({
                "id": r.id,
                "repo": r.repo,
                "file": r.file,
                "localDir": r.local_dir,
                "pid": r.pid,
                "out": r.out,
                "exitCode": r.exit_code,
                "done": r.done,
                "failed": r.failed,
                "totalBytes": r.total_bytes,
                "downloadedBytes": r.downloaded_bytes,
                "speedBps": r.speed_bps,
                "startedAt": r.started_at,
            })
        })
        .collect()
}
