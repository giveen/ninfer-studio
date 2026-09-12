//! Logs / models / gpu route handlers.

// Rust guideline compliant 2026-07-28

use axum::body::Body;
use axum::extract::{Query, Request, State as AxumState};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use crate::engine::S;
use crate::gpu::{gpu_stats, gpu_value};
use crate::models::{list_models, start_download};
use crate::read_json;
use crate::types::ARTIFACTS;
use crate::LOG_TAIL_WINDOW_BYTES;

#[derive(Deserialize)]
pub(crate) struct LogsQuery {
    n: Option<usize>,
}

pub(crate) async fn logs(AxumState(state): AxumState<S>, Query(q): Query<LogsQuery>) -> Json<Value> {
    let n = q.n.unwrap_or(400);
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
    if size <= LOG_TAIL_WINDOW_BYTES as u64 {
        let Ok(text) = tokio::fs::read_to_string(path).await else {
            return (vec![], size);
        };
        let lines: Vec<String> = text.lines().rev().take(lines).collect::<Vec<_>>().into_iter().rev().map(|l| l.to_string()).collect();
        return (lines, size);
    }
    let mut buf = vec![0u8; LOG_TAIL_WINDOW_BYTES];
    let Ok(mut f) = tokio::fs::File::open(path).await else {
        return (vec![], size);
    };
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let Ok(_pos) = f.seek(std::io::SeekFrom::End(-(buf.len() as i64))).await else {
        return (vec![], size);
    };
    let _ = f.read_exact(&mut buf).await;
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<String> = text.lines().rev().take(lines).collect::<Vec<_>>().into_iter().rev().map(|l| l.to_string()).collect();
    (lines, size)
}

pub(crate) async fn api_models(AxumState(state): AxumState<S>) -> Json<Value> {
    let mut v = list_models(&state).await;
    v["catalog"] = json!(ARTIFACTS);
    Json(v)
}

pub(crate) async fn models_download(AxumState(state): AxumState<S>, req: Request<Body>) -> Result<Json<Value>, (StatusCode, String)> {
    let body = read_json(req).await?;
    Ok(Json(start_download(&state, body).await))
}

pub(crate) async fn gpu(AxumState(state): AxumState<S>) -> Json<Value> {
    let _ = state;
    Json(gpu_value(&gpu_stats().await))
}

