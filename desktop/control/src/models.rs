//! Models directory scanning + Hugging Face download supervision.

// Rust guideline compliant 2026-07-28

use crate::clear_appimage_env;
use crate::types::{ARTIFACTS, AppEvent, JobRec, ModelArtifact, State, now_ms};
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// Path containment helper: ensures user_input joined to base_dir sits safely
/// inside base_dir, rejecting absolute paths and parent-directory ('..') traversal.
fn safe_model_path(base_dir: &Path, user_input: &str) -> Option<PathBuf> {
    let raw = user_input.trim();
    if raw.is_empty() {
        return None;
    }
    let p = Path::new(raw);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    let joined = base_dir.join(p);
    let Ok(norm_base) = base_dir.canonicalize() else {
        // `base_dir` itself doesn't exist on disk yet — there's no real
        // filesystem entity `joined` could alias via a symlink, so the
        // lexical join (already verified `..`/absolute-free above) is safe.
        return Some(joined);
    };
    // Once the base is real, containment must be verified against the
    // canonicalized (symlink-resolved) path. A lexical `starts_with` check
    // here would be a tautology — `joined` always starts with `base_dir`
    // lexically for a relative, `..`-free `p` — and would accept a request
    // through a symlink planted anywhere under `base_dir` that points
    // outside it.
    if let Ok(real) = joined.canonicalize() {
        return if real.starts_with(&norm_base) {
            Some(joined)
        } else {
            None
        };
    }
    // The leaf doesn't exist yet (a fresh download/convert/upgrade output
    // path) — walk up to the nearest existing ancestor and verify that
    // instead, so a symlinked ancestor directory is still caught. This
    // always terminates: `base_dir` (already confirmed to exist above) is
    // itself an ancestor of `joined` for any relative, `..`-free `p`.
    let mut dir = joined.parent();
    while let Some(d) = dir {
        if let Ok(real_dir) = d.canonicalize() {
            return if real_dir.starts_with(&norm_base) {
                Some(joined)
            } else {
                None
            };
        }
        dir = d.parent();
    }
    None
}

pub async fn list_models(state: &State) -> Value {
    let dir = state.config.read().await.models_dir.clone();
    let dir_path = Path::new(&dir);
    let mut artifacts: Vec<ModelArtifact> = Vec::new();
    let Ok(entries) = tokio::fs::read_dir(dir_path).await else {
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
        let full_path = dir_path.join(&name);
        let full = full_path.to_string_lossy().into_owned();
        let Ok(md) = tokio::fs::metadata(&full_path).await else {
            continue;
        };
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let mut version = 0;
        if let Ok(mut f) = tokio::fs::File::open(&full_path).await {
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

    let cfg = state.config.read().await.clone();
    let models_dir = PathBuf::from(cfg.models_dir.clone());
    let dir_path = match body
        .get("localDir")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(ld) => {
            let p = Path::new(ld);
            if p.is_absolute() && !p.components().any(|c| matches!(c, Component::ParentDir)) {
                p.to_path_buf()
            } else if let Some(safe_p) = safe_model_path(&models_dir, ld) {
                safe_p
            } else {
                return json!({ "ok": false, "message": "invalid or unsafe localDir path" });
            }
        }
        None => models_dir,
    };
    if safe_model_path(&dir_path, file).is_none() {
        return json!({ "ok": false, "message": "invalid or unsafe file path" });
    }

    let dir = dir_path.to_string_lossy().into_owned();

    // TOCTOU duplicate download check & reservation under lock
    let id = format!("dl_{}_{}", now_ms(), crate::memstore::mem_rand_suffix());
    {
        let mut downloads = state.downloads.lock().await;
        let already_running = downloads
            .values()
            .any(|r| !r.done && r.repo.as_deref() == Some(repo) && r.file.as_deref() == Some(file));
        if already_running {
            return json!({ "ok": false, "message": format!("a download for {repo}/{file} is already running") });
        }
        downloads.insert(
            id.clone(),
            JobRec {
                id: id.clone(),
                action: None,
                cmd: None,
                repo: Some(repo.to_string()),
                file: Some(file.to_string()),
                local_dir: Some(dir.clone()),
                pid: None,
                out: String::new(),
                exit_code: None,
                done: false,
                failed: false,
                total_bytes: None,
                downloaded_bytes: Some(0),
                speed_bps: Some(0.0),
                started_at: now_ms(),
            },
        );
    }

    let cli = cfg.hf_cli.clone();
    let hf_token = state.config.read().await.hf_token.clone();
    let _ = tokio::fs::create_dir_all(&dir_path).await;
    let total_bytes = fetch_download_size(&cli, repo, file, &dir, &hf_token).await;

    let mut cmd = tokio::process::Command::new(&cli);
    cmd.arg("download")
        .arg(repo)
        .arg(file)
        .arg("--local-dir")
        .arg(&dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    clear_appimage_env(&mut cmd);
    if !hf_token.is_empty() {
        cmd.env("HF_TOKEN", hf_token);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let mut d = state.downloads.lock().await;
            if let Some(r) = d.get_mut(&id) {
                r.done = true;
                r.failed = true;
                r.exit_code = Some(-1);
            }
            return json!({ "ok": false, "message": format!("could not spawn {cli}: {e}") });
        }
    };
    let pid = child.id();

    {
        let mut d = state.downloads.lock().await;
        if let Some(r) = d.get_mut(&id) {
            r.pid = pid;
            r.total_bytes = total_bytes;
        }
    }

    // Pump stdout
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

    // Pump stderr
    let st_err = state.clone();
    let id_err = id.clone();
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stderr);
            crate::pump_log_lines(lines, |line| {
                let (st, id) = (st_err.clone(), id_err.clone());
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

    // Progress monitor
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
                let cur = download_progress_bytes(&dir_m, &file_m).await;
                let now = std::time::Instant::now();
                let dt = now.duration_since(last_t).as_secs_f64();
                let finished = {
                    let mut d = st.downloads.lock().await;
                    match d.get_mut(&idm) {
                        Some(r) => {
                            if r.done {
                                true
                            } else {
                                if dt > 0.0 && cur >= last {
                                    r.speed_bps = Some((cur - last) as f64 / dt);
                                }
                                r.downloaded_bytes = Some(cur);
                                false
                            }
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

    // Reaper
    let st = state.clone();
    let id3 = id.clone();
    tokio::spawn(async move {
        let code = child.wait().await.ok().map(|s| s.code().unwrap_or(-1));
        let (file_res, ok) = {
            let mut d = st.downloads.lock().await;
            match d.get_mut(&id3) {
                Some(r) => {
                    r.exit_code = code;
                    r.done = true;
                    r.failed = code.map(|c| c != 0).unwrap_or(true);
                    if !r.failed {
                        if let Some(t) = r.total_bytes {
                            r.downloaded_bytes = Some(t);
                        }
                    }
                    r.speed_bps = Some(0.0);
                    (r.file.clone().unwrap_or_default(), !r.failed)
                }
                None => (id3.clone(), false),
            }
        };
        st.emit(AppEvent::DownloadFinished { file: file_res, ok });
    });

    json!({ "ok": true, "id": id })
}

/// Parse a human size string like "20.4G" / "20.4 GiB" / "512M" / "1024" into bytes.
fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim();
    let num_part = s
        .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c.is_whitespace())
        .trim();
    if num_part.is_empty() {
        return None;
    }
    let unit_part = s[num_part.len()..].trim().to_ascii_lowercase();
    if !unit_part.is_empty() && !unit_part.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let v: f64 = num_part.parse().ok()?;
    let mult = match unit_part.as_str() {
        "k" | "kb" | "kib" => 1024.0,
        "m" | "mb" | "mib" => 1024.0 * 1024.0,
        "g" | "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        "t" | "tb" | "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        "" => 1.0,
        _ => return None,
    };
    Some((v * mult) as u64)
}

/// Bytes downloaded so far for `file` under `dir`.
async fn download_progress_bytes(dir: &str, file: &str) -> u64 {
    let root = std::path::Path::new(dir);
    if let Ok(m) = tokio::fs::metadata(root.join(file)).await {
        return m.len();
    }
    let staging = root
        .join(".cache/huggingface/download")
        .join(format!("{file}.incomplete"));
    tokio::fs::metadata(staging).await.map(|m| m.len()).unwrap_or(0)
}

/// Resolve total download size via `hf download --dry-run --json`.
async fn fetch_download_size(
    cli: &str,
    repo: &str,
    file: &str,
    dir: &str,
    hf_token: &str,
) -> Option<u64> {
    let mut cmd = tokio::process::Command::new(cli);
    cmd.arg("download")
        .arg(repo)
        .arg(file)
        .arg("--local-dir")
        .arg(dir)
        .arg("--dry-run")
        .arg("--json");
    clear_appimage_env(&mut cmd);
    if !hf_token.is_empty() {
        cmd.env("HF_TOKEN", hf_token);
    }
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
    let models_dir = PathBuf::from(cfg.models_dir.clone());
    let target = match safe_model_path(&models_dir, file) {
        Some(p) => p,
        None => return json!({ "ok": false, "message": "invalid or unsafe file path" }),
    };
    if !target.exists() || !target.is_file() {
        return json!({ "ok": false, "message": "target file does not exist" });
    }

    let ninfer_path = PathBuf::from(&cfg.ninfer_path);
    let upgrade_script = ninfer_path.join("tools").join("upgrade_ninfer_v2_to_v3.py");
    if !upgrade_script.exists() {
        return json!({ "ok": false, "message": "upgrade script not found in ninfer path" });
    }
    let out_file = target.with_extension("v3.ninfer");
    let file_name = target.file_name().unwrap_or_default().to_string_lossy().to_string();

    let id = format!("upg_{}_{}", now_ms(), crate::memstore::mem_rand_suffix());

    {
        let mut downloads = state.downloads.lock().await;
        let already_running = downloads
            .values()
            .any(|r| !r.done && r.file.as_deref() == Some(&file_name) && r.action.as_deref() == Some("upgrade"));
        if already_running {
            return json!({ "ok": false, "message": format!("an upgrade for {file_name} is already running") });
        }
        downloads.insert(
            id.clone(),
            JobRec {
                id: id.clone(),
                action: Some("upgrade".to_string()),
                cmd: Some(format!("python3 upgrade_ninfer_v2_to_v3.py {}", file_name)),
                repo: None,
                file: Some(file_name.clone()),
                local_dir: Some(cfg.models_dir.clone()),
                pid: None,
                out: String::new(),
                exit_code: None,
                done: false,
                failed: false,
                total_bytes: None,
                downloaded_bytes: None,
                speed_bps: None,
                started_at: now_ms(),
            },
        );
    }

    let mut cmd = tokio::process::Command::new("python3");
    cmd.arg(&upgrade_script)
        .arg(&target)
        .arg(&out_file)
        .current_dir(&ninfer_path);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::clear_appimage_env(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let mut d = state.downloads.lock().await;
            if let Some(r) = d.get_mut(&id) {
                r.done = true;
                r.failed = true;
                r.exit_code = Some(-1);
            }
            return json!({ "ok": false, "message": format!("could not spawn upgrade script: {e}") });
        }
    };
    let pid = child.id();

    {
        let mut d = state.downloads.lock().await;
        if let Some(r) = d.get_mut(&id) {
            r.pid = pid;
        }
    }

    let st_out = state.clone();
    let id_out = id.clone();
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stdout);
            crate::pump_log_lines(lines, |line| {
                let (st, id) = (st_out.clone(), id_out.clone());
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

    let st_err = state.clone();
    let id_err = id.clone();
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stderr);
            crate::pump_log_lines(lines, |line| {
                let (st, id) = (st_err.clone(), id_err.clone());
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

    let st_proc = state.clone();
    let id_proc = id.clone();
    let target_clone = target.clone();
    let out_file_clone = out_file.clone();
    let file_name_clone = file_name.clone();

    tokio::spawn(async move {
        let status = child.wait().await.ok();
        let code = status.and_then(|s| s.code());
        let success = status.map(|s| s.success()).unwrap_or(false);

        if success {
            let bak = target_clone.with_extension("ninfer.bak");
            let backup_ok = tokio::fs::rename(&target_clone, &bak).await.is_ok();
            if let Err(e) = tokio::fs::rename(&out_file_clone, &target_clone).await {
                if backup_ok {
                    let _ = tokio::fs::rename(&bak, &target_clone).await;
                }
                let mut d = st_proc.downloads.lock().await;
                if let Some(j) = d.get_mut(&id_proc) {
                    crate::append_log_line(&mut j.out, &format!("rename output failed: {e}"), crate::LOG_TAIL_LINES);
                }
            } else if backup_ok {
                let _ = tokio::fs::remove_file(&bak).await;
            }
        } else {
            let _ = tokio::fs::remove_file(&out_file_clone).await;
        }

        let mut d = st_proc.downloads.lock().await;
        if let Some(j) = d.get_mut(&id_proc) {
            j.done = true;
            j.failed = !success;
            j.exit_code = code;
        }
        st_proc.emit(AppEvent::DownloadFinished { file: file_name_clone, ok: success });
    });

    json!({ "ok": true, "id": id })
}

pub async fn start_conversion(state: &Arc<State>, body: Value) -> Value {
    let model_path_input = body.get("modelPath").and_then(|v| v.as_str()).unwrap_or("");
    let recipe = body.get("recipe").and_then(|v| v.as_str()).unwrap_or("");
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let out_name_input = body.get("outName").and_then(|v| v.as_str()).unwrap_or("");
    let extra_args = body.get("extraArgs").and_then(|v| v.as_str()).unwrap_or("");

    if model_path_input.is_empty() || recipe.is_empty() || name.is_empty() || out_name_input.is_empty() {
        return json!({ "ok": false, "message": "modelPath, recipe, name, and outName are required" });
    }

    let cfg = state.config.read().await.clone();
    let models_dir = PathBuf::from(cfg.models_dir.clone());
    let _ = tokio::fs::create_dir_all(&models_dir).await;

    let out_path = match safe_model_path(&models_dir, out_name_input) {
        Some(p) => p,
        None => return json!({ "ok": false, "message": "invalid or unsafe outName path" }),
    };

    let model_path = match safe_model_path(&models_dir, model_path_input) {
        Some(p) => p,
        None => {
            let p = Path::new(model_path_input);
            if p.is_absolute() && !p.components().any(|c| matches!(c, Component::ParentDir)) {
                // Canonicalize-only containment check: `p.starts_with(&models_dir)`
                // on the raw paths would be a lexical-prefix tautology a symlink
                // planted under `models_dir` (e.g. `models_dir/evil -> /etc`)
                // trivially satisfies without ever resolving inside it for real.
                let real_check = p
                    .canonicalize()
                    .ok()
                    .zip(models_dir.canonicalize().ok())
                    .is_some_and(|(real_p, real_m)| real_p.starts_with(&real_m));
                if real_check {
                    p.to_path_buf()
                } else {
                    return json!({ "ok": false, "message": "invalid or unsafe modelPath" });
                }
            } else {
                return json!({ "ok": false, "message": "invalid or unsafe modelPath" });
            }
        }
    };

    let ninfer_path = PathBuf::from(&cfg.ninfer_path);
    let out_file_name = out_path.file_name().unwrap_or_default().to_string_lossy().to_string();

    let id = format!("conv_{}_{}", now_ms(), crate::memstore::mem_rand_suffix());

    {
        let mut downloads = state.downloads.lock().await;
        let already_running = downloads
            .values()
            .any(|r| !r.done && r.file.as_deref() == Some(&out_file_name) && r.action.as_deref() == Some("convert"));
        if already_running {
            return json!({ "ok": false, "message": format!("a conversion for {out_file_name} is already running") });
        }
        downloads.insert(
            id.clone(),
            JobRec {
                id: id.clone(),
                action: Some("convert".to_string()),
                cmd: Some(format!("python3 -m tools.convert --model {}", model_path.display())),
                repo: None,
                file: Some(out_file_name.clone()),
                local_dir: Some(cfg.models_dir.clone()),
                pid: None,
                out: String::new(),
                exit_code: None,
                done: false,
                failed: false,
                total_bytes: None,
                downloaded_bytes: None,
                speed_bps: None,
                started_at: now_ms(),
            },
        );
    }

    let mut cmd = tokio::process::Command::new("python3");
    cmd.arg("-m")
        .arg("tools.convert")
        .arg("--model")
        .arg(&model_path)
        .arg("--recipe")
        .arg(recipe)
        .arg("--name")
        .arg(name)
        .arg("--out")
        .arg(&out_path)
        .current_dir(&ninfer_path);

    if !extra_args.trim().is_empty() {
        for arg in extra_args.split_whitespace() {
            let lower = arg.to_ascii_lowercase();
            if lower.starts_with("--out")
                || lower.starts_with("-o")
                || lower.starts_with("--model")
                || lower.starts_with("--recipe")
                || lower.starts_with("--name")
            {
                continue;
            }
            cmd.arg(arg);
        }
    }

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::clear_appimage_env(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let mut d = state.downloads.lock().await;
            if let Some(r) = d.get_mut(&id) {
                r.done = true;
                r.failed = true;
                r.exit_code = Some(-1);
            }
            return json!({ "ok": false, "message": format!("could not spawn python3 tools.convert: {e}") });
        }
    };
    let pid = child.id();

    {
        let mut d = state.downloads.lock().await;
        if let Some(r) = d.get_mut(&id) {
            r.pid = pid;
        }
    }

    let st_out = state.clone();
    let id_out = id.clone();
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stdout);
            crate::pump_log_lines(lines, |line| {
                let (st, id) = (st_out.clone(), id_out.clone());
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

    let st_err = state.clone();
    let id_err = id.clone();
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let lines = tokio::io::BufReader::new(stderr);
            crate::pump_log_lines(lines, |line| {
                let (st, id) = (st_err.clone(), id_err.clone());
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

    let st_proc = state.clone();
    let id_proc = id.clone();
    let out_file_name_clone = out_file_name.clone();

    tokio::spawn(async move {
        let status = child.wait().await.ok();
        let code = status.and_then(|s| s.code());
        let success = status.map(|s| s.success()).unwrap_or(false);

        let mut d = st_proc.downloads.lock().await;
        if let Some(j) = d.get_mut(&id_proc) {
            j.done = true;
            j.exit_code = code;
            j.failed = !success;
        }
        st_proc.emit(AppEvent::DownloadFinished { file: out_file_name_clone, ok: success });
    });

    json!({ "ok": true, "id": id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_size_handles_human_units_and_utf8() {
        assert_eq!(parse_size("1024"), Some(1024));
        assert_eq!(parse_size("512M"), Some(512 * 1024 * 1024));
        assert_eq!(parse_size("20.4 GiB"), Some((20.4 * 1024.0 * 1024.0 * 1024.0) as u64));
        assert_eq!(parse_size("1.5 GB"), Some((1.5 * 1024.0 * 1024.0 * 1024.0) as u64));
        // Multi-byte non-ASCII unit suffix doesn't panic
        assert_eq!(parse_size("5é"), None);
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_size("abc"), None);
    }

    #[test]
    fn safe_model_path_rejects_traversal_and_absolute_paths() {
        let base = Path::new("/models");
        assert_eq!(safe_model_path(base, "llama.ninfer"), Some(PathBuf::from("/models/llama.ninfer")));
        assert_eq!(safe_model_path(base, "sub/model.ninfer"), Some(PathBuf::from("/models/sub/model.ninfer")));
        assert_eq!(safe_model_path(base, "../etc/passwd"), None);
        assert_eq!(safe_model_path(base, "/etc/passwd"), None);
        assert_eq!(safe_model_path(base, "  "), None);
    }

    #[test]
    #[cfg(unix)]
    fn safe_model_path_rejects_symlink_escape() {
        let tmp = std::env::temp_dir().join(format!("ninfier-safepath-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let models_dir = tmp.join("models");
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&models_dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), b"top secret").unwrap();

        // A symlink planted *inside* models_dir pointing outside it — the
        // lexical join always starts with `models_dir`, so only a real
        // canonicalize-based check catches this.
        std::os::unix::fs::symlink(&outside, models_dir.join("escape")).unwrap();
        assert_eq!(safe_model_path(&models_dir, "escape/secret.txt"), None);

        // A file genuinely inside models_dir is still accepted.
        std::fs::write(models_dir.join("real.ninfer"), b"model bytes").unwrap();
        assert_eq!(
            safe_model_path(&models_dir, "real.ninfer"),
            Some(models_dir.join("real.ninfer"))
        );

        // A not-yet-created output path (download/convert destination) is
        // still accepted when its existing ancestor is genuinely contained.
        assert_eq!(
            safe_model_path(&models_dir, "fresh/new-model.ninfer"),
            Some(models_dir.join("fresh/new-model.ninfer"))
        );

        // ...but not when that ancestor is itself the symlinked escape.
        assert_eq!(
            safe_model_path(&models_dir, "escape/nested/new-model.ninfer"),
            None
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
