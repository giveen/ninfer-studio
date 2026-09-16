//! Usage tracking for the Engine → Usage tab: every proxied chat-completion
//! request is logged (best-effort) as one JSON line under the data dir, then
//! aggregated on read. Mirrors `coder::memory`'s `learnings.jsonl` shape (see
//! `memstore.rs`) rather than introducing a database — this app's request
//! volume is small enough that folding the whole log on each `/api/usage`
//! call is simpler and cheap.

use crate::engine::S;
use crate::memstore::{day_string, mem_lock};
use axum::Json;
use axum::body::Bytes;
use axum::extract::{Query, State as AxumState};
use futures_util::stream::BoxStream;
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::AsyncWriteExt;

/// Which listener accepted the proxied request — the loopback control plane
/// (Chat UI, Coder, any local tool talking to the engine port) or the LAN
/// Remote Access listener (`remote.rs`). Tagged once per router via an axum
/// `Extension` layer in `lib.rs::build_router`, read back in `proxy::proxy`.
#[derive(Clone, Copy, Debug)]
pub enum RequestSource {
    Local,
    Remote,
}

impl RequestSource {
    fn as_str(self) -> &'static str {
        match self {
            RequestSource::Local => "local",
            RequestSource::Remote => "remote",
        }
    }
}

struct UsageEvent {
    ts_ms: u64,
    model: String,
    source: RequestSource,
    prompt_tokens: u64,
    completion_tokens: u64,
    cached_tokens: u64,
    /// Streaming-request timing, in ms, when the response was streamed:
    /// `prefill_ms` is request-forwarded → first chunk, `total_ms` is
    /// request-forwarded → stream end. Kept for display/debugging, but NOT
    /// used for the average prefill/generation speed stats — see
    /// `prompt_tok_per_sec`/`decode_tok_per_sec` for why. `None` for
    /// non-streaming responses and older log lines.
    prefill_ms: Option<u64>,
    total_ms: Option<u64>,
    /// The engine's own self-reported per-request speeds, from the
    /// SGLang-style `timings.prompt_per_second` / `predicted_per_second`
    /// extension (see `log_from_response_bytes`). Far more accurate than
    /// deriving speed from `prefill_ms`: most OpenAI-compatible engines
    /// (this one included — see the mock SSE fixtures in engine_loop.rs)
    /// send an empty leading delta chunk (role announcement, no content)
    /// before prefill has actually finished, so "time to first chunk"
    /// measures near-zero connection/framing latency, not prefill compute —
    /// which is what made the Usage tab's old "avg prefill" read in the
    /// millions of tok/s. `None` for cloud providers (no `timings` object).
    prompt_tok_per_sec: Option<f64>,
    decode_tok_per_sec: Option<f64>,
}

/// Artifact filenames carry a format extension ("qwen3_8_27b_nvfp4.ninfer")
/// that is meaningless in the Usage tab and overflows its stat box — drop it
/// when reading events so the tab shows "qwen3_8_27b_nvfp4". Applied at read
/// time (not log time) so pre-existing log lines get the short name too.
fn display_model_name(raw: &str) -> String {
    raw.strip_suffix(".ninfer").unwrap_or(raw).to_string()
}

fn usage_log_path(state: &S) -> PathBuf {
    state.data_dir.join("usage-log.jsonl")
}

/// Append one usage event as a JSON line. Serialized with the same per-store
/// lock map `coder::memory`/`chat::memory` use (keyed "usage" here) so
/// concurrent requests can't interleave partial lines.
async fn log_usage_event(state: &S, evt: UsageEvent) -> std::io::Result<()> {
    let mut obj = serde_json::Map::new();
    obj.insert("ts".into(), json!(evt.ts_ms));
    obj.insert("day".into(), json!(day_string(evt.ts_ms)));
    obj.insert("model".into(), json!(evt.model));
    obj.insert("source".into(), json!(evt.source.as_str()));
    obj.insert("promptTokens".into(), json!(evt.prompt_tokens));
    obj.insert("completionTokens".into(), json!(evt.completion_tokens));
    obj.insert("cachedTokens".into(), json!(evt.cached_tokens));
    // Timing is optional and only present for streamed responses — omit the
    // keys entirely when absent so the log line shape stays clean.
    if let (Some(prefill), Some(total)) = (evt.prefill_ms, evt.total_ms) {
        obj.insert("prefillMs".into(), json!(prefill));
        obj.insert("totalMs".into(), json!(total));
    }
    if let Some(v) = evt.prompt_tok_per_sec {
        obj.insert("promptTokPerSec".into(), json!(v));
    }
    if let Some(v) = evt.decode_tok_per_sec {
        obj.insert("decodeTokPerSec".into(), json!(v));
    }
    let line = Value::Object(obj).to_string();
    let lock = mem_lock(state, "usage");
    let _guard = lock.lock().await;
    let _ = tokio::fs::create_dir_all(&state.data_dir).await;
    let mut f = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(usage_log_path(state))
        .await?;
    f.write_all(line.as_bytes()).await?;
    f.write_all(b"\n").await
}

/// `POST /api/usage/reset` — delete the usage log outright so the Usage tab
/// starts from a clean slate (e.g. after a change expected to shift the
/// numbers, like a cache-hit-rate fix, where old and new behavior mixed
/// together in one average would hide whether it actually helped).
/// Irreversible; takes the same per-store lock `log_usage_event` does so a
/// write in flight can't interleave with the delete.
pub(crate) async fn usage_reset(AxumState(state): AxumState<S>) -> Json<Value> {
    let lock = mem_lock(&state, "usage");
    let _guard = lock.lock().await;
    match tokio::fs::remove_file(usage_log_path(&state)).await {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Json(json!({ "ok": true })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}

async fn read_usage_events(state: &S) -> Vec<Value> {
    let Ok(raw) = tokio::fs::read_to_string(usage_log_path(state)).await else {
        return Vec::new();
    };
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect()
}

/// Per-day fold accumulator: totals plus the token split by model that lets
/// the daily trend chart stack bars per model.
#[derive(Default)]
struct DayAgg {
    tokens: u64,
    requests: u64,
    prompt_tokens: u64,
    cached_tokens: u64,
    tokens_by_model: HashMap<String, u64>,
    /// USD cost for events this day whose model has known pricing (see
    /// `AppSettings::cloud_model_pricing`) — 0.0 when none of the day's
    /// events matched a priced model, same as `cost_known` below.
    cost_usd: f64,
}

#[derive(Deserialize)]
pub(crate) struct UsageQuery {
    /// Lookback window in days (7/14/30/90 in the UI). Defaults to 30.
    days: Option<u32>,
    /// "all" | "local" | "remote". Defaults to "all".
    source: Option<String>,
}

/// `GET /api/usage` — fold the usage log into the totals, daily series (also
/// doubles as the heatmap's per-day request counts), and model breakdown the
/// Usage tab renders.
pub(crate) async fn usage_stats(
    AxumState(state): AxumState<S>,
    Query(q): Query<UsageQuery>,
) -> Json<Value> {
    let days = q.days.unwrap_or(30).max(1) as u64;
    let source = q.source.unwrap_or_else(|| "all".to_string());
    let now_ms = now_ms();
    let cutoff_ms = now_ms.saturating_sub(days * 86_400_000);

    // Energy isn't attributable to a traffic source (board power, not
    // per-request), so it's always the full-window total regardless of the
    // `source` filter above.
    let energy_by_day = crate::power::energy_kwh_by_day(&state, &day_string(cutoff_ms)).await;
    let energy_total_kwh: f64 = energy_by_day.values().sum();

    // Cloud $ pricing, keyed by model id exactly as logged (see
    // AppSettings::cloud_model_pricing / cloud_test). Computed at read time
    // (not log time) so a later price refresh re-prices old log lines too —
    // same reasoning as `display_model_name` above.
    let pricing = state.config.read().await.cloud_model_pricing.clone();
    let price_event = |model: &str, prompt: u64, completion: u64| -> Option<f64> {
        let p = pricing.get(model)?;
        Some(prompt as f64 * p.prompt_per_token + completion as f64 * p.completion_per_token)
    };

    let events: Vec<Value> = read_usage_events(&state)
        .await
        .into_iter()
        .filter(|e| {
            e.get("ts")
                .and_then(Value::as_u64)
                .is_some_and(|ts| ts >= cutoff_ms)
        })
        .filter(|e| {
            source == "all" || e.get("source").and_then(Value::as_str) == Some(source.as_str())
        })
        .collect();

    let mut prompt_total = 0u64;
    let mut completion_total = 0u64;
    let mut cached_total = 0u64;
    let mut requests = 0u64;
    // Weighted speed accumulators (streamed requests only): avg speed is
    // total tokens / total time across events, so long responses dominate
    // instead of short 1-token streams skewing a plain per-request mean.
    let mut speed_prompt_tokens = 0u64;
    let mut speed_prefill_secs = 0.0f64;
    let mut speed_completion_tokens = 0u64;
    let mut speed_decode_secs = 0.0f64;
    let mut days_seen: BTreeSet<String> = BTreeSet::new();
    let mut by_day: BTreeMap<String, DayAgg> = BTreeMap::new();
    let mut by_model: HashMap<String, u64> = HashMap::new(); // model -> tokens
    let mut cost_by_model: HashMap<String, f64> = HashMap::new();
    let mut cost_total = 0.0f64;
    // Whether ANY event this window matched a priced model — lets the
    // response send `null` (no pricing data at all) instead of a
    // misleading "$0.00" when nothing here is actually free.
    let mut cost_known = false;

    for e in &events {
        let prompt = e.get("promptTokens").and_then(Value::as_u64).unwrap_or(0);
        let completion = e
            .get("completionTokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let cached = e.get("cachedTokens").and_then(Value::as_u64).unwrap_or(0);
        let day = e
            .get("day")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let raw_model = e.get("model").and_then(Value::as_str).unwrap_or("unknown");
        let model = display_model_name(raw_model);
        let tokens = prompt + completion;
        let event_cost = price_event(raw_model, prompt, completion);
        if let Some(c) = event_cost {
            cost_known = true;
            cost_total += c;
            *cost_by_model.entry(model.clone()).or_insert(0.0) += c;
        }

        // Speed is derived from the engine's own self-reported
        // `prompt_per_second` / `predicted_per_second` (SGLang-style
        // `timings` extension — see log_from_response_bytes), not from
        // wall-clock request timing: most OpenAI-compatible engines send an
        // empty leading delta chunk (role announcement) before prefill
        // finishes, so "time to first chunk" measures connection/framing
        // latency rather than actual prefill compute — that used to produce
        // tok/s figures in the millions. `prompt`/`completion` here are the
        // FULL counts (prompt includes cached tokens); weight by the tokens
        // actually processed this request (uncached prefill, full decode).
        let uncached_prompt = prompt.saturating_sub(cached);
        if let Some(pps) = e.get("promptTokPerSec").and_then(Value::as_f64)
            && pps > 0.0
            && uncached_prompt > 0
        {
            speed_prompt_tokens += uncached_prompt;
            speed_prefill_secs += uncached_prompt as f64 / pps;
        }
        if let Some(dps) = e.get("decodeTokPerSec").and_then(Value::as_f64)
            && dps > 0.0
            && completion > 0
        {
            speed_completion_tokens += completion;
            speed_decode_secs += completion as f64 / dps;
        }

        prompt_total += prompt;
        completion_total += completion;
        cached_total += cached;
        requests += 1;
        if !day.is_empty() {
            days_seen.insert(day.clone());
            let agg = by_day.entry(day).or_default();
            agg.tokens += tokens;
            agg.requests += 1;
            agg.prompt_tokens += prompt;
            agg.cached_tokens += cached;
            *agg.tokens_by_model.entry(model.clone()).or_insert(0) += tokens;
            if let Some(c) = event_cost {
                agg.cost_usd += c;
            }
        }
        *by_model.entry(model).or_insert(0) += tokens;
    }

    let most_used_model = by_model
        .iter()
        .max_by_key(|(_, tok)| **tok)
        .map(|(m, _)| m.clone());
    let cache_hit_rate = if prompt_total > 0 {
        cached_total as f64 / prompt_total as f64
    } else {
        0.0
    };
    let avg_prefill_tps = if speed_prefill_secs > 0.0 {
        Some(speed_prompt_tokens as f64 / speed_prefill_secs)
    } else {
        None
    };
    let avg_generation_tps = if speed_decode_secs > 0.0 {
        Some(speed_completion_tokens as f64 / speed_decode_secs)
    } else {
        None
    };

    let daily_series: Vec<Value> = by_day
        .iter()
        .map(|(day, agg)| {
            let day_hit_rate = if agg.prompt_tokens > 0 {
                agg.cached_tokens as f64 / agg.prompt_tokens as f64
            } else {
                0.0
            };
            json!({
                "day": day,
                "tokens": agg.tokens,
                "requests": agg.requests,
                "cacheHitRate": day_hit_rate,
                // per-model split so the daily trend chart can stack bars by
                // model, colored the same way as the model-usage donut.
                "models": agg.tokens_by_model,
                "kwh": energy_by_day.get(day).copied().unwrap_or(0.0),
                "cloudCostUsd": agg.cost_usd,
            })
        })
        .collect();
    let mut model_breakdown: Vec<Value> = by_model
        .into_iter()
        .map(|(model, tokens)| {
            json!({ "model": &model, "tokens": tokens, "cloudCostUsd": cost_by_model.get(&model).copied() })
        })
        .collect();
    model_breakdown.sort_by(|a, b| b["tokens"].as_u64().cmp(&a["tokens"].as_u64()));

    Json(json!({
        "totals": {
            "tokenUsage": prompt_total + completion_total,
            "requests": requests,
            "cloudCostUsd": if cost_known { Some(cost_total) } else { None },
            "activeDays": days_seen.len(),
            "avgCacheHitRate": cache_hit_rate,
            "mostUsedModel": most_used_model,
            "avgPrefillTps": avg_prefill_tps,
            "avgGenerationTps": avg_generation_tps,
            "energyKwh": energy_total_kwh,
        },
        "dailySeries": daily_series,
        "modelBreakdown": model_breakdown,
    }))
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Response tap: forwards the proxied stream to the client unchanged while
// accumulating it to parse the trailing `usage` object once it ends.
// ---------------------------------------------------------------------------

/// Cap on how much of a proxied response is buffered for parsing — generous
/// for any chat/completions JSON tail. Endpoints this is never wrapped around
/// (models list, health, embeddings, …) never pay this cost at all.
const MAX_USAGE_TAP_BYTES: usize = 2 * 1024 * 1024;

struct UsageLogCtx {
    state: S,
    model: Option<String>,
    source: RequestSource,
    /// True when the client requested a streamed response (`"stream": true`)
    /// — only those give a meaningful prefill/decode split to measure.
    streaming: bool,
}

struct UsageTapStream {
    inner: BoxStream<'static, reqwest::Result<Bytes>>,
    buf: Vec<u8>,
    ctx: Option<UsageLogCtx>,
    /// When `proxy::proxy` handed the request to the engine, captured just
    /// before `send()`; `None` disables timing entirely.
    started: Option<std::time::Instant>,
    /// When the first response chunk arrived ≈ end of prefill.
    first_chunk: Option<std::time::Instant>,
}

impl Stream for UsageTapStream {
    type Item = reqwest::Result<Bytes>;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        match this.inner.poll_next_unpin(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                if this.buf.len() < MAX_USAGE_TAP_BYTES {
                    this.buf.extend_from_slice(&chunk);
                }
                if this.first_chunk.is_none() {
                    this.first_chunk = Some(std::time::Instant::now());
                }
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(None) => {
                if let Some(ctx) = this.ctx.take() {
                    let buf = std::mem::take(&mut this.buf);
                    // Pre-fill/decode timing is only meaningful for streamed
                    // responses (a single blob has no prefill/decode split).
                    let (prefill_ms, total_ms) = if ctx.streaming {
                        match (this.started, this.first_chunk) {
                            (Some(started), Some(first)) => (
                                Some(first.saturating_duration_since(started).as_millis() as u64),
                                Some(
                                    std::time::Instant::now()
                                        .saturating_duration_since(started)
                                        .as_millis() as u64,
                                ),
                            ),
                            _ => (None, None),
                        }
                    } else {
                        (None, None)
                    };
                    tokio::spawn(async move {
                        log_from_response_bytes(ctx, &buf, prefill_ms, total_ms).await
                    });
                }
                Poll::Ready(None)
            }
            other => other,
        }
    }
}

/// Wrap a proxied engine response stream so it is tapped for usage logging
/// as it passes through. Every chunk is still forwarded to the client the
/// instant it arrives (streaming behavior/latency unchanged) — the tap only
/// adds an in-memory copy consumed after the stream ends. Best-effort: a
/// parse failure or disk error just skips the log line, never the response.
pub(crate) fn wrap_for_usage_logging(
    state: S,
    model: Option<String>,
    source: RequestSource,
    streaming: bool,
    started: Option<std::time::Instant>,
    inner: BoxStream<'static, reqwest::Result<Bytes>>,
) -> BoxStream<'static, reqwest::Result<Bytes>> {
    UsageTapStream {
        inner,
        buf: Vec::new(),
        ctx: Some(UsageLogCtx {
            state,
            model,
            source,
            streaming,
        }),
        started,
        first_chunk: None,
    }
    .boxed()
}

/// Best-effort: find the OpenAI-style `usage` object in a completed proxied
/// response — the last `data: {...}` SSE line that carries one for streaming
/// responses, or the whole body for a plain JSON completion — and log it.
/// Silently does nothing when no `usage` object is found (e.g. the engine
/// doesn't report usage for this call, or the request failed).
async fn log_from_response_bytes(
    ctx: UsageLogCtx,
    buf: &[u8],
    prefill_ms: Option<u64>,
    total_ms: Option<u64>,
) {
    let text = String::from_utf8_lossy(buf);
    let mut usage_obj: Option<Value> = None;
    let mut timings_obj: Option<Value> = None;
    let mut resp_model: Option<String> = None;
    for raw_line in text.lines() {
        let line = raw_line.trim();
        let payload = line.strip_prefix("data:").map(str::trim).unwrap_or(line);
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        if let Some(m) = v.get("model").and_then(Value::as_str) {
            resp_model = Some(m.to_string());
        }
        if let Some(u) = v.get("usage") {
            usage_obj = Some(u.clone());
        }
        if let Some(t) = v.get("timings") {
            timings_obj = Some(t.clone());
        }
    }
    // `ctx.model` (set by `proxy::proxy`) is the actual artifact filename when
    // known — preferred over `resp_model`, which is just the engine's own
    // response echoing back the OpenAI-facing public alias, not the file
    // that was loaded. Falls back to the response's alias when the artifact
    // wasn't resolvable (e.g. a discovered/external engine — see proxy.rs).
    let model = ctx
        .model
        .or(resp_model)
        .unwrap_or_else(|| "unknown".to_string());
    let mut prompt_tokens = 0;
    let mut completion_tokens = 0;
    let mut cached_tokens = 0;
    let mut found = false;
    let mut prompt_tok_per_sec = None;
    let mut decode_tok_per_sec = None;

    if let Some(usage) = usage_obj {
        prompt_tokens = usage
            .get("prompt_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        completion_tokens = usage
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        cached_tokens = usage
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        found = true;
    }

    if let Some(timings) = timings_obj {
        let cache_n = timings.get("cache_n").and_then(Value::as_u64).unwrap_or(0);
        let prompt_n = timings.get("prompt_n").and_then(Value::as_u64).unwrap_or(0);
        let predicted_n = timings
            .get("predicted_n")
            .and_then(Value::as_u64)
            .unwrap_or(0);

        if !found {
            prompt_tokens = cache_n + prompt_n;
            completion_tokens = predicted_n;
            cached_tokens = cache_n;
            found = true;
        } else if cached_tokens == 0 && cache_n > 0 {
            cached_tokens = cache_n;
        }
        prompt_tok_per_sec = timings.get("prompt_per_second").and_then(Value::as_f64);
        decode_tok_per_sec = timings.get("predicted_per_second").and_then(Value::as_f64);
    }

    if !found {
        return;
    }
    let _ = log_usage_event(
        &ctx.state,
        UsageEvent {
            ts_ms: now_ms(),
            model,
            source: ctx.source,
            prompt_tokens,
            completion_tokens,
            cached_tokens,
            prefill_ms,
            total_ms,
            prompt_tok_per_sec,
            decode_tok_per_sec,
        },
    )
    .await;
}

/// True for the completion-shaped endpoints this taps — the models list,
/// health probe, and any other `/v1/*` path are proxied untouched.
pub(crate) fn is_loggable_completion_path(path: &str) -> bool {
    path.ends_with("/chat/completions")
        || path.ends_with("/completions")
        || path.ends_with("/responses")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::State;
    use std::sync::Arc;

    fn temp_state() -> S {
        let dir = std::env::temp_dir().join(format!(
            "ninfier-usage-test-{}",
            crate::memstore::mem_rand_suffix()
        ));
        Arc::new(State::new(dir, PathBuf::from("."), None))
    }

    #[tokio::test]
    async fn logs_and_aggregates_across_days_models_and_sources() {
        let state = temp_state();
        let day_ms = 86_400_000u64;
        // A comfortable margin (not bare day boundaries) so the days=1 filter
        // below can't flip on ms-resolution `now_ms()` jitter between here
        // and its own internal "now" read.
        let now = now_ms();
        let margin_ms = 5_000u64;
        let two_days_ago = now - 2 * day_ms - margin_ms;
        let one_day_ago = now - day_ms - margin_ms;
        let recent = now - margin_ms;
        log_usage_event(
            &state,
            UsageEvent {
                ts_ms: two_days_ago,
                model: "model-a".into(),
                source: RequestSource::Local,
                prompt_tokens: 100,
                completion_tokens: 50,
                cached_tokens: 20,
                prefill_ms: None,
                total_ms: None,
                prompt_tok_per_sec: None,
                decode_tok_per_sec: None,
            },
        )
        .await
        .unwrap();
        log_usage_event(
            &state,
            UsageEvent {
                ts_ms: one_day_ago,
                model: "model-b".into(),
                source: RequestSource::Remote,
                prompt_tokens: 200,
                completion_tokens: 100,
                cached_tokens: 0,
                prefill_ms: None,
                total_ms: None,
                prompt_tok_per_sec: None,
                decode_tok_per_sec: None,
            },
        )
        .await
        .unwrap();
        log_usage_event(
            &state,
            UsageEvent {
                ts_ms: recent,
                model: "model-a".into(),
                source: RequestSource::Local,
                prompt_tokens: 300,
                completion_tokens: 150,
                cached_tokens: 300,
                prefill_ms: None,
                total_ms: None,
                prompt_tok_per_sec: None,
                decode_tok_per_sec: None,
            },
        )
        .await
        .unwrap();

        let Json(all) = usage_stats(
            AxumState(state.clone()),
            Query(UsageQuery {
                days: Some(30),
                source: None,
            }),
        )
        .await;
        assert_eq!(all["totals"]["requests"], 3);
        assert_eq!(all["totals"]["activeDays"], 3);
        assert_eq!(
            all["totals"]["tokenUsage"],
            100 + 50 + 200 + 100 + 300 + 150
        );
        assert_eq!(all["totals"]["mostUsedModel"], "model-a");
        assert_eq!(all["modelBreakdown"].as_array().unwrap().len(), 2);
        // No streamed events logged (no timing) → speed stats are null.
        assert_eq!(all["totals"]["avgPrefillTps"], Value::Null);
        assert_eq!(all["totals"]["avgGenerationTps"], Value::Null);

        let Json(local_only) = usage_stats(
            AxumState(state.clone()),
            Query(UsageQuery {
                days: Some(30),
                source: Some("local".into()),
            }),
        )
        .await;
        assert_eq!(local_only["totals"]["requests"], 2);

        let Json(narrow) = usage_stats(
            AxumState(state),
            Query(UsageQuery {
                days: Some(1),
                source: None,
            }),
        )
        .await;
        assert_eq!(narrow["totals"]["requests"], 1);
    }

    /// `ctx.model` (the artifact filename resolved by `proxy::proxy` when the
    /// request hit this control plane's own managed engine) must win over
    /// whatever alias the engine's response itself echoes back in its
    /// `model` field — otherwise Usage always shows the OpenAI-facing public
    /// alias (e.g. "qwen3.8-27b") instead of the actual loaded artifact
    /// (e.g. "qwen3_8_27b_nvfp4.ninfer").
    #[tokio::test]
    async fn logged_model_prefers_known_artifact_over_response_alias() {
        let state = temp_state();
        let body = br#"{"model":"qwen3.8-27b","usage":{"prompt_tokens":10,"completion_tokens":5}}"#;
        log_from_response_bytes(
            UsageLogCtx {
                state: state.clone(),
                model: Some("qwen3_8_27b_nvfp4.ninfer".into()),
                source: RequestSource::Local,
                streaming: false,
            },
            body,
            None,
            None,
        )
        .await;
        let events = read_usage_events(&state).await;
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0]["model"].as_str(),
            Some("qwen3_8_27b_nvfp4.ninfer")
        );
    }

    /// When the artifact isn't known (e.g. a discovered/external engine —
    /// see proxy.rs), the response's own alias is still logged rather than
    /// dropping the event entirely.
    #[tokio::test]
    async fn logged_model_falls_back_to_response_alias_when_artifact_unknown() {
        let state = temp_state();
        let body = br#"{"model":"qwen3.8-27b","usage":{"prompt_tokens":10,"completion_tokens":5}}"#;
        log_from_response_bytes(
            UsageLogCtx {
                state: state.clone(),
                model: None,
                source: RequestSource::Local,
                streaming: false,
            },
            body,
            None,
            None,
        )
        .await;
        let events = read_usage_events(&state).await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["model"].as_str(), Some("qwen3.8-27b"));
    }

    #[tokio::test]
    async fn energy_from_power_log_is_included_regardless_of_source_filter() {
        let state = temp_state();
        let today = day_string(now_ms());
        let mut by_day = BTreeMap::new();
        by_day.insert(today, 1.5);
        crate::power::write_power_log(&state, &by_day).await;
        log_usage_event(
            &state,
            UsageEvent {
                ts_ms: now_ms(),
                model: "model-a".into(),
                source: RequestSource::Remote,
                prompt_tokens: 10,
                completion_tokens: 5,
                cached_tokens: 0,
                prefill_ms: None,
                total_ms: None,
                prompt_tok_per_sec: None,
                decode_tok_per_sec: None,
            },
        )
        .await
        .unwrap();

        let Json(all) = usage_stats(
            AxumState(state.clone()),
            Query(UsageQuery {
                days: Some(7),
                source: None,
            }),
        )
        .await;
        assert!((all["totals"]["energyKwh"].as_f64().unwrap() - 1.5).abs() < 1e-9);

        // "local" excludes the only (remote) request but still reports the
        // full energy total — energy isn't attributable to traffic source.
        let Json(local_only) = usage_stats(
            AxumState(state),
            Query(UsageQuery {
                days: Some(7),
                source: Some("local".into()),
            }),
        )
        .await;
        assert_eq!(local_only["totals"]["requests"], 0);
        assert!((local_only["totals"]["energyKwh"].as_f64().unwrap() - 1.5).abs() < 1e-9);
    }

    #[test]
    fn display_model_name_strips_artifact_extension() {
        assert_eq!(
            display_model_name("qwen3_8_27b_nvfp4.ninfer"),
            "qwen3_8_27b_nvfp4"
        );
        // OpenAI-facing aliases may contain dots — only the exact artifact
        // extension is stripped.
        assert_eq!(display_model_name("qwen3.8-27b"), "qwen3.8-27b");
        assert_eq!(display_model_name("unknown"), "unknown");
    }

    /// Events carrying the engine's own `promptTokPerSec`/`decodeTokPerSec`
    /// (from the SGLang-style `timings` extension) contribute to the average
    /// prefill / generation speeds (weighted: total tokens / total time
    /// across events), events without them don't, and the artifact
    /// extension is stripped from the model name everywhere it surfaces.
    #[tokio::test]
    async fn stream_timing_feeds_average_speeds_and_model_extension_is_stripped() {
        let state = temp_state();
        // 100 prompt tokens prefilled at 200 tok/s (0.5s) + 50 at 100 tok/s
        // (0.5s): avgPrefillTps = (100 + 50) / (0.5 + 0.5) = 150.
        // 200 completion tokens decoded at 100 tok/s (2.0s) + 100 at 100 tok/s
        // (1.0s): avgGenerationTps = (200 + 100) / (2.0 + 1.0) = 100.
        log_usage_event(
            &state,
            UsageEvent {
                ts_ms: now_ms(),
                model: "qwen3_8_27b_nvfp4.ninfer".into(),
                source: RequestSource::Local,
                prompt_tokens: 100,
                completion_tokens: 200,
                cached_tokens: 0,
                prefill_ms: None,
                total_ms: None,
                prompt_tok_per_sec: Some(200.0),
                decode_tok_per_sec: Some(100.0),
            },
        )
        .await
        .unwrap();
        log_usage_event(
            &state,
            UsageEvent {
                ts_ms: now_ms(),
                model: "qwen3_8_27b_nvfp4.ninfer".into(),
                source: RequestSource::Local,
                prompt_tokens: 50,
                completion_tokens: 100,
                cached_tokens: 0,
                prefill_ms: None,
                total_ms: None,
                prompt_tok_per_sec: Some(100.0),
                decode_tok_per_sec: Some(100.0),
            },
        )
        .await
        .unwrap();
        // No engine-reported speed → counts toward tokens/requests but not
        // the speed averages.
        log_usage_event(
            &state,
            UsageEvent {
                ts_ms: now_ms(),
                model: "model-b".into(),
                source: RequestSource::Local,
                prompt_tokens: 1,
                completion_tokens: 1,
                cached_tokens: 0,
                prefill_ms: None,
                total_ms: None,
                prompt_tok_per_sec: None,
                decode_tok_per_sec: None,
            },
        )
        .await
        .unwrap();

        let Json(all) = usage_stats(
            AxumState(state),
            Query(UsageQuery {
                days: Some(1),
                source: None,
            }),
        )
        .await;
        assert_eq!(all["totals"]["mostUsedModel"], "qwen3_8_27b_nvfp4");
        assert!((all["totals"]["avgPrefillTps"].as_f64().unwrap() - 150.0).abs() < 1e-9);
        assert!((all["totals"]["avgGenerationTps"].as_f64().unwrap() - 100.0).abs() < 1e-9);
        let models: Vec<&str> = all["modelBreakdown"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["model"].as_str().unwrap())
            .collect();
        assert!(models.contains(&"qwen3_8_27b_nvfp4"));
        assert!(models.iter().all(|m| !m.ends_with(".ninfer")));
    }
}
