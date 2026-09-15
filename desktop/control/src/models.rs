//! Models directory scanning + Hugging Face download supervision.

// Rust guideline compliant 2026-07-28

use crate::clear_appimage_env;
use crate::types::{ARTIFACTS, AppEvent, JobRec, ModelArtifact, State, now_ms};
use serde_json::{Value, json};
use std::sync::Arc;

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
        let mut version = 0;
        if let Ok(mut f) = tokio::fs::File::open(&full).await {
            use tokio::io::AsyncReadExt;
            let mut magic = [0u8; 8];
            if f.read_exact(&mut magic).await.is_ok()
                && (magic.starts_with(b"NINFER\0") || magic.starts_with(b"NINPRT\0"))
            {
                version = magic[7] as u32;
            }
        }
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
            version,
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
    {
        let downloads = state.downloads.lock().await;
        let already_running = downloads
            .values()
            .any(|r| !r.done && r.repo.as_deref() == Some(repo) && r.file.as_deref() == Some(file));
        if already_running {
            return json!({ "ok": false, "message": format!("a download for {repo}/{file} is already running") });
        }
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
    let total_bytes = fetch_download_size(&cli, repo, file, &dir).await;

    let id = format!(
        "dl_{:x}_{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        std::process::id()
    );

    let hf_token = state.config.read().await.hf_token.clone();
    let mut cmd = tokio::process::Command::new(&cli);
    cmd.arg("download")
        .arg(repo)
        .arg(file)
        .arg("--local-dir")
        .arg(&dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    clear_appimage_env(&mut cmd);
    // Token goes via env, never argv — argv is world-readable in /proc.
    if !hf_token.is_empty() {
        cmd.env("HF_TOKEN", hf_token);
    }
    let Ok(mut child) = cmd.spawn() else {
        return json!({ "ok": false, "message": format!("could not spawn {cli}") });
    };
    let pid = child.id();

    {
        let mut d = state.downloads.lock().await;
        d.insert(
            id.clone(),
            JobRec {
                id: id.clone(),
                action: None,
                cmd: None,
                repo: Some(repo.to_string()),
                file: Some(file.to_string()),
                local_dir: Some(dir.clone()),
                pid,
                out: String::new(),
                exit_code: None,
                done: false,
                failed: false,
                total_bytes,
                downloaded_bytes: Some(0),
                speed_bps: Some(0.0),
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
            crate::pump_log_lines(lines, |line| {
                let (st, id) = (st.clone(), id2.clone());
                async move {
                    let mut d = st.downloads.lock().await;
                    if let Some(r) = d.get_mut(&id) {
                        crate::append_log_line(&mut r.out, &line, crate::LOG_TAIL_LINES);
                    }
                }
            })
            .await;
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let st = state.clone();
        let id = id.clone();
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stderr);
            crate::pump_log_lines(lines, |line| {
                let (st, id) = (st.clone(), id.clone());
                async move {
                    let mut d = st.downloads.lock().await;
                    if let Some(r) = d.get_mut(&id) {
                        crate::append_log_line(&mut r.out, &line, crate::LOG_TAIL_LINES);
                    }
                }
            })
            .await;
        });
    }

    // progress monitor: sample the staging blob size on disk every 400ms
    {
        let st = state.clone();
        let idm = id.clone();
        let dir_m = dir.clone();
        let file_m = file.to_string();
        tokio::spawn(async move {
            let mut last = 0u64;
            let mut last_t = std::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                let cur = download_progress_bytes(&dir_m, &file_m);
                let now = std::time::Instant::now();
                let dt = now.duration_since(last_t).as_secs_f64();
                let finished = {
                    let mut d = st.downloads.lock().await;
                    match d.get_mut(&idm) {
                        Some(r) => {
                            if dt > 0.0 && cur >= last {
                                r.speed_bps = Some((cur - last) as f64 / dt);
                            }
                            r.downloaded_bytes = Some(cur);
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
                        r.downloaded_bytes = Some(t);
                    }
                    r.speed_bps = Some(0.0);
                    (r.file.clone().unwrap_or_default(), !r.failed)
                }
                None => (id3.clone(), false),
            }
        };
        st.emit(AppEvent::DownloadFinished { file, ok });
    });

    json!({ "ok": true, "id": id })
}

/// Parse a human size string like "20.4G" / "512M" / "1024" into bytes.
fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim();
    let (num, unit) = match s.chars().last() {
        Some(c) if c.is_alphabetic() => {
            (s[..s.len() - 1].trim(), c.to_ascii_lowercase().to_string())
        }
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

/// Bytes downloaded so far for `file` under `dir` — stats only the two paths
/// `hf download --local-dir` can actually be writing to (the in-progress
/// staging blob under its `.cache/huggingface/download/` scratch dir, or the
/// finished file once moved into place) instead of walking the whole
/// directory tree, which would also pick up unrelated multi-GB sibling
/// artifacts already downloaded there.
fn download_progress_bytes(dir: &str, file: &str) -> u64 {
    let root = std::path::Path::new(dir);
    if let Ok(m) = std::fs::metadata(root.join(file)) {
        return m.len();
    }
    let staging = root
        .join(".cache/huggingface/download")
        .join(format!("{file}.incomplete"));
    std::fs::metadata(staging).map(|m| m.len()).unwrap_or(0)
}

/// Resolve the total download size via `hf download --dry-run --json` (no
/// actual network transfer). Returns None if the size can't be determined.
async fn fetch_download_size(cli: &str, repo: &str, file: &str, dir: &str) -> Option<u64> {
    let mut cmd = tokio::process::Command::new(cli);
    cmd.arg("download")
        .arg(repo)
        .arg(file)
        .arg("--local-dir")
        .arg(dir)
        .arg("--dry-run")
        .arg("--json");
    clear_appimage_env(&mut cmd);
    // A hung `hf` (bad network, stuck auth prompt) must not hang the whole
    // download request forever.
    let out = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output())
        .await
        .ok()?
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
        .filter_map(|r| serde_json::to_value(r).ok())
        .collect()
}

pub async fn upgrade_model(state: &Arc<State>, body: Value) -> Value {
    let file = body.get("file").and_then(|v| v.as_str()).unwrap_or("");
    if file.is_empty() {
        return json!({ "ok": false, "message": "file is required" });
    }
    let cfg = state.config.read().await.clone();
    let ninfer_path = std::path::Path::new(&cfg.ninfer_path);
    let upgrade_script = ninfer_path.join("tools").join("upgrade_ninfer_v2_to_v3.py");
    if !upgrade_script.exists() {
        return json!({ "ok": false, "message": "upgrade script not found in ninfer path" });
    }
    let target = std::path::Path::new(&file);
    if !target.exists() || !target.is_file() {
        return json!({ "ok": false, "message": "target file does not exist" });
    }
    let out_file = target.with_extension("v3.ninfer");

    let mut cmd = tokio::process::Command::new("python3");
    cmd.arg(&upgrade_script)
        .arg(target)
        .arg(&out_file)
        .current_dir(ninfer_path);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::clear_appimage_env(&mut cmd);

    let Ok(mut child) = cmd.spawn() else {
        return json!({ "ok": false, "message": "could not spawn upgrade script" });
    };
    let pid = child.id();

    let id = format!(
        "upg_{:x}_{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        std::process::id()
    );

    let file_name = target.file_name().unwrap().to_string_lossy().to_string();
    let out_file_clone = out_file.clone();
    let target_clone = target.to_path_buf();

    {
        let mut d = state.downloads.lock().await;
        d.insert(
            id.clone(),
            JobRec {
                id: id.clone(),
                action: Some("upgrade".to_string()),
                cmd: Some(format!("python3 upgrade_ninfer_v2_to_v3.py {}", file_name)),
                repo: None,
                file: Some(file_name),
                local_dir: Some(cfg.models_dir.clone()),
                pid,
                out: String::new(),
                exit_code: None,
                done: false,
                failed: false,
                total_bytes: None,
                downloaded_bytes: None,
                speed_bps: None,
                started_at: crate::types::now_ms(),
            },
        );
    }

    let state_c = state.clone();
    let id_c = id.clone();

    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let mut buf_out = [0; 4096];
        let mut buf_err = [0; 4096];

        loop {
            tokio::select! {
                Ok(n) = stdout.read(&mut buf_out) => {
                    if n == 0 { break; }
                    let s = String::from_utf8_lossy(&buf_out[..n]);
                    let mut d = state_c.downloads.lock().await;
                    if let Some(j) = d.get_mut(&id_c) {
                        j.out.push_str(&s);
                        if j.out.len() > 8192 { j.out.replace_range(..j.out.len()-4096, ""); }
                    }
                }
                Ok(n) = stderr.read(&mut buf_err) => {
                    if n == 0 { break; }
                    let s = String::from_utf8_lossy(&buf_err[..n]);
                    let mut d = state_c.downloads.lock().await;
                    if let Some(j) = d.get_mut(&id_c) {
                        j.out.push_str(&s);
                        if j.out.len() > 8192 { j.out.replace_range(..j.out.len()-4096, ""); }
                    }
                }
            }
        }

        let status = child.wait().await.ok();
        let success = status.map(|s| s.success()).unwrap_or(false);

        if success {
            // Delete the old file first to ensure rename succeeds
            let _ = tokio::fs::remove_file(&target_clone).await;
            let _ = tokio::fs::rename(&out_file_clone, &target_clone).await;
        }

        let mut d = state_c.downloads.lock().await;
        if let Some(j) = d.get_mut(&id_c) {
            j.done = true;
            j.failed = !success;
            j.exit_code = status.and_then(|s| s.code());
        }
    });

    json!({ "ok": true })
}

pub async fn start_conversion(state: &Arc<State>, body: Value) -> Value {
    let model_path = body.get("modelPath").and_then(|v| v.as_str()).unwrap_or("");
    let recipe = body.get("recipe").and_then(|v| v.as_str()).unwrap_or("");
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let out_name = body.get("outName").and_then(|v| v.as_str()).unwrap_or("");
    let extra_args = body.get("extraArgs").and_then(|v| v.as_str()).unwrap_or("");

    if model_path.is_empty() || recipe.is_empty() || name.is_empty() || out_name.is_empty() {
        return json!({ "ok": false, "message": "modelPath, recipe, name, and outName are required" });
    }

    let cfg = state.config.read().await.clone();
    let models_dir = cfg.models_dir.clone();
    let _ = tokio::fs::create_dir_all(&models_dir).await;
    let out_path = std::path::Path::new(&models_dir).join(out_name);

    let ninfer_path = std::path::Path::new(&cfg.ninfer_path);

    let id = format!(
        "conv_{:x}_{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        std::process::id()
    );

    let mut cmd = tokio::process::Command::new("python3");
    cmd.arg("-m")
        .arg("tools.convert")
        .arg("--model")
        .arg(model_path)
        .arg("--recipe")
        .arg(recipe)
        .arg("--name")
        .arg(name)
        .arg("--out")
        .arg(&out_path)
        .current_dir(ninfer_path);

    // Parse extra_args simply by splitting by whitespace (ignoring quotes for simplicity in this PoC)
    if !extra_args.trim().is_empty() {
        for arg in extra_args.split_whitespace() {
            cmd.arg(arg);
        }
    }

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::clear_appimage_env(&mut cmd);

    let Ok(mut child) = cmd.spawn() else {
        return json!({ "ok": false, "message": "could not spawn python3 tools.convert" });
    };
    let pid = child.id();

    {
        let mut d = state.downloads.lock().await;
        d.insert(
            id.clone(),
            JobRec {
                id: id.clone(),
                action: Some("convert".to_string()),
                cmd: Some(format!(
                    "python3 -m tools.convert --model {} ...",
                    model_path
                )),
                repo: None,
                file: Some(out_name.to_string()),
                local_dir: Some(models_dir),
                pid,
                out: String::new(),
                exit_code: None,
                done: false,
                failed: false,
                total_bytes: None,
                downloaded_bytes: None,
                speed_bps: None,
                started_at: crate::types::now_ms(),
            },
        );
    }

    let state_c = state.clone();
    let id_c = id.clone();
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let mut buf_out = [0; 4096];
        let mut buf_err = [0; 4096];

        // Read output dynamically
        loop {
            tokio::select! {
                Ok(n) = stdout.read(&mut buf_out) => {
                    if n == 0 { break; }
                    let chunk = String::from_utf8_lossy(&buf_out[..n]).to_string();
                    let mut d = state_c.downloads.lock().await;
                    if let Some(j) = d.get_mut(&id_c) {
                        j.out.push_str(&chunk);
                    }
                }
                Ok(n) = stderr.read(&mut buf_err) => {
                    if n == 0 { break; }
                    let chunk = String::from_utf8_lossy(&buf_err[..n]).to_string();
                    let mut d = state_c.downloads.lock().await;
                    if let Some(j) = d.get_mut(&id_c) {
                        j.out.push_str(&chunk);
                    }
                }
            }
        }

        let status = child.wait().await.ok();
        let code = status.and_then(|s| s.code());
        let success = status.map(|s| s.success()).unwrap_or(false);
        let mut d = state_c.downloads.lock().await;
        if let Some(j) = d.get_mut(&id_c) {
            j.done = true;
            j.exit_code = code;
            j.failed = !success;
        }
    });

    json!({ "ok": true, "id": id })
}
