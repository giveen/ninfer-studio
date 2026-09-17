//! Logs / models / gpu route handlers.

// Rust guideline compliant 2026-07-28

use crate::LOG_TAIL_WINDOW_BYTES;
use crate::engine::S;
use crate::gpu::{gpu_stats, gpu_value};
use crate::models::list_models;
use crate::read_json;
use crate::types::ARTIFACTS;
use axum::Json;
use axum::body::Body;
use axum::extract::{Query, Request, State as AxumState};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::VecDeque;

#[derive(Deserialize)]
pub(crate) struct LogsQuery {
    n: Option<usize>,
}

/// Helper to collect the last `n` lines from `text` efficiently using a VecDeque.
fn last_n_lines(text: &str, n: usize) -> Vec<String> {
    if n == 0 {
        return Vec::new();
    }
    let mut deque = VecDeque::with_capacity(n.min(2000));
    for line in text.lines() {
        if deque.len() == n {
            deque.pop_front();
        }
        deque.push_back(line.to_string());
    }
    deque.into()
}

/// `GET /api/logs` — Reads the managed engine's log file (set via boot_adopt or start_engine).
pub(crate) async fn logs(
    AxumState(state): AxumState<S>,
    Query(q): Query<LogsQuery>,
) -> Json<Value> {
    let n = q.n.unwrap_or(400).clamp(1, crate::LOG_TAIL_LINES);
    let log_path = state.engine.read().await.log_path.clone();
    let Some(path) = log_path else {
        return Json(json!({ "lines": [], "size": 0 }));
    };
    let tail = tail_file(&path, n).await;
    Json(json!({ "lines": tail.0, "size": tail.1 }))
}

pub(crate) async fn tail_file(path: &str, lines: usize) -> (Vec<String>, u64) {
    let Ok(md) = tokio::fs::metadata(path).await else {
        return (vec![], 0);
    };
    let size = md.len();
    if size == 0 {
        return (vec![], 0);
    }
    if size <= LOG_TAIL_WINDOW_BYTES as u64 {
        // Read full small file as bytes and convert using lossy UTF-8
        let Ok(bytes) = tokio::fs::read(path).await else {
            return (vec![], size);
        };
        let text = String::from_utf8_lossy(&bytes);
        return (last_n_lines(&text, lines), size);
    }

    let mut buf = vec![0u8; LOG_TAIL_WINDOW_BYTES];
    let Ok(mut f) = tokio::fs::File::open(path).await else {
        return (vec![], size);
    };
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    if f.seek(std::io::SeekFrom::End(-(LOG_TAIL_WINDOW_BYTES as i64))).await.is_err() {
        return (vec![], size);
    }
    let n_bytes = match f.read(&mut buf).await {
        Ok(n) => n,
        Err(_) => return (vec![], size),
    };
    let text = String::from_utf8_lossy(&buf[..n_bytes]);

    // Seeking into the middle of a log window lands on a mid-line fragment.
    // Skip to the first newline so the first returned line is complete.
    let window_text = if let Some(idx) = text.find('\n') {
        &text[idx + 1..]
    } else {
        &text
    };

    (last_n_lines(window_text, lines), size)
}

pub(crate) async fn api_models(AxumState(state): AxumState<S>) -> Json<Value> {
    let mut v = list_models(&state).await;
    if let Some(obj) = v.as_object_mut() {
        obj.insert("catalog".to_string(), json!(ARTIFACTS));
    }
    Json(v)
}

pub(crate) async fn models_download(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body = read_json(req).await?;
    let res = crate::models::start_download(&state, body).await;
    if res.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let msg = res.get("message").and_then(|v| v.as_str()).unwrap_or("download failed");
        return Err((StatusCode::BAD_REQUEST, msg.to_string()));
    }
    Ok(Json(res))
}

pub(crate) async fn models_upgrade(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body = read_json(req).await?;
    let res = crate::models::upgrade_model(&state, body).await;
    if res.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let msg = res.get("message").and_then(|v| v.as_str()).unwrap_or("upgrade failed");
        return Err((StatusCode::BAD_REQUEST, msg.to_string()));
    }
    Ok(Json(res))
}

pub(crate) async fn models_convert(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body = read_json(req).await?;
    let res = crate::models::start_conversion(&state, body).await;
    if res.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        let msg = res.get("message").and_then(|v| v.as_str()).unwrap_or("conversion failed");
        return Err((StatusCode::BAD_REQUEST, msg.to_string()));
    }
    Ok(Json(res))
}

pub(crate) async fn gpu(AxumState(_state): AxumState<S>) -> Json<Value> {
    Json(gpu_value(&gpu_stats().await))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_tail_file_small_and_large() {
        let dir = std::env::temp_dir().join(format!("ninfer_logs_test_{}", crate::types::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();

        // 1. Non-existent file returns ([], 0)
        let (lines, size) = tail_file(dir.join("nonexistent.log").to_str().unwrap(), 10).await;
        assert_eq!(lines, Vec::<String>::new());
        assert_eq!(size, 0);

        // 2. Small file with non-UTF-8 bytes renders lossy replacement instead of returning empty
        let small_path = dir.join("small.log");
        let content_bytes = b"line 1\nline 2 \xFF invalid utf8\nline 3\n";
        std::fs::write(&small_path, content_bytes).unwrap();

        let (lines, size) = tail_file(small_path.to_str().unwrap(), 10).await;
        assert_eq!(size, content_bytes.len() as u64);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "line 1");
        assert!(lines[1].contains("line 2"));

        // 3. Large file > 512KB skips initial partial line fragment after seek
        let large_path = dir.join("large.log");
        let mut large_file = std::fs::File::create(&large_path).unwrap();
        use std::io::Write;
        let padding = "A".repeat(600_000);
        write!(large_file, "{padding}\nline 999\nline 1000\n").unwrap();

        let (lines, size) = tail_file(large_path.to_str().unwrap(), 5).await;
        assert!(size > LOG_TAIL_WINDOW_BYTES as u64);
        assert_eq!(lines, vec!["line 999".to_string(), "line 1000".to_string()]);
    }
}

