//! The agent loop itself — the server port of the webview's `runToolLoop`.
//!
//! One `run()` per run: build the engine request from the run's transcript
//! (compaction-sliced, observation-packed), stream a turn from the engine
//! (same routing + usage tap as the `/v1/*` proxy), recover tool calls the
//! model emitted as markup, dispatch them in-process (see `tools.rs`), and
//! recurse until the model stops calling tools or the step budget is spent.
//!
//! Everything the webview loop did, minus the DOM: deltas are broadcast on
//! the run's event channel instead of patched into message bubbles, and a
//! stop request `select!`s against every engine/tool await so it cancels
//! in-flight reads rather than just the next loop iteration.

use crate::agent::run::{AgentEvent, HookDecision, HookMode, RunShared, RunStatus, now_ms};
use crate::agent::tools;
use crate::engine::S;
use futures_util::{StreamExt, future::join_all};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// Sentinel [`stream_turn`] returns when a stop request won the race against
/// the engine read — the run was already marked terminal by `stop_run`.
const STOP_ERR: &str = "__stopped__";

/// Worker/coder runs that stop at the token limit get a continuation note
/// instead of a silent "done" — the next turn picks up from the truncation.
const CUTOFF_NOTE: &str = "[Your previous reply was cut off at the token limit mid-generation. \
Continue from exactly where it stopped — do not repeat the truncated text, and if you \
were mid-edit, re-read the file first to see what landed.]";

const CHARS_PER_TOKEN: f64 = 4.0;
/// Tool results larger than this participate in packing.
const PACK_THRESHOLD_BYTES: usize = 4 * 1024;
/// Sent in full for this many prior turns before being packed.
const PACK_FULL_SENDS: usize = 2;
/// Placeholder excerpt budget, split evenly between head and tail.
const PACK_EXCERPT_BYTES: usize = 1024;
/// Already bounded/paged results (or the recall path itself) — never pack.
const PACK_EXCLUDED: &[&str] = &["grep", "glob", "repo_search", "obs_recall"];
/// How long a client-hook pause waits for the attached screen before the
/// loop falls back to its default (done on a tool-less turn, continue on a
/// tool turn) — an absent client must never wedge a run.
const HOOK_TIMEOUT: Duration = Duration::from_secs(300);

/// A tool call recovered from markup text (native calls get engine ids).
#[derive(Debug, Clone)]
pub struct Tc {
    id: String,
    name: String,
    /// Raw JSON arguments string, exactly as the model sent them.
    arguments: String,
}

impl Tc {
    fn to_value(&self) -> Value {
        json!({ "id": self.id, "name": self.name, "arguments": self.arguments })
    }
}

/// One streamed assistant turn.
#[derive(Debug, Default)]
pub(crate) struct Turn {
    content: String,
    reasoning: String,
    tool_calls: Vec<Tc>,
    /// Parsed-from-markup calls the run's tool set didn't declare — the loop
    /// tells the model about these instead of silently dropping them.
    dropped: Vec<String>,
    finish_reason: Option<String>,
    prompt_tokens: u64,
    completion_tokens: u64,
    meta: Value,
}

// ---------------------------------------------------------------------------
// Request building (port of the webview's `buildRequest`)
// ---------------------------------------------------------------------------

/// Build the engine chat-completions request for one turn.
///
/// `messages` are the run's transcript in wire format — the same objects the
/// client persists (`role/content/reasoning/tool_calls/tool_call_id/name/
/// attachments`); `system` is prepended (skipped if a system message is
/// already in the transcript); `params` are the run's sampling params
/// (camelCase, as the client's ChatParams); `tools` the offered tool specs.
///
/// Engine contract (mirrors `apps/web/src/lib/api/chat.ts`): `enable_thinking`
/// and `reasoning_effort` are derived from one intent (a contradictory pair
/// is rejected by the engine), `max_completion_tokens` for the cap,
/// snake_case sampling keys, greedy wins over a lingering temperature.
pub fn build_request(
    model: &str,
    system: Option<&str>,
    messages: &[Value],
    params: &Value,
    tools: &Value,
) -> Value {
    let mut msgs: Vec<Value> = Vec::with_capacity(messages.len() + 1);
    if let Some(sys) = system.map(str::trim).filter(|s| !s.is_empty()) {
        msgs.push(json!({ "role": "system", "content": sys }));
    }
    for m in messages {
        let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role == "system" {
            // System is prepended exactly once from the run's meta.
            continue;
        }
        let has_attachments = m
            .get("attachments")
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if has_attachments {
            let mut content: Vec<Value> = Vec::new();
            let text = m.get("content").and_then(|v| v.as_str()).unwrap_or("");
            // Mirrors the client's mapping (api/chat.ts): non-empty prose
            // first, then one part per attachment.
            if !text.trim().is_empty() {
                content.push(json!({ "type": "text", "text": text.to_string() }));
            }
            if let Some(atts) = m.get("attachments").and_then(|v| v.as_array()) {
                for a in atts {
                    match a.get("kind").and_then(|v| v.as_str()).unwrap_or("") {
                        "image" => {
                            if let Some(url) = a.get("dataUrl").and_then(|v| v.as_str()) {
                                content.push(
                                    json!({ "type": "image_url", "image_url": { "url": url } }),
                                );
                            }
                        }
                        "video" => {
                            if let Some(url) = a.get("dataUrl").and_then(|v| v.as_str()) {
                                content.push(
                                    json!({ "type": "video_url", "video_url": { "url": url } }),
                                );
                            }
                        }
                        _ => {
                            let p = a
                                .get("path")
                                .and_then(|v| v.as_str())
                                .or_else(|| a.get("name").and_then(|v| v.as_str()))
                                .unwrap_or_default();
                            let body = a
                                .get("content")
                                .and_then(|v| v.as_str())
                                .or_else(|| a.get("body").and_then(|v| v.as_str()))
                                .unwrap_or_default();
                            // Backtick-run-aware fence, like the client: the
                            // fence must exceed the longest run in the body.
                            let mut run = 0;
                            let mut cur = 0;
                            for ch in body.chars() {
                                if ch == '`' {
                                    cur += 1;
                                    run = run.max(cur);
                                } else {
                                    cur = 0;
                                }
                            }
                            let fence = "`".repeat(run.max(2) + 1);
                            content.push(json!({
                                "type": "text",
                                "text": format!("\n\n[Attached file: {p}]\n{fence}\n{body}\n{fence}\n"),
                            }));
                        }
                    }
                }
            }
            msgs.push(json!({ "role": "user", "content": content }));
            continue;
        }
        let mut out = json!({
            "role": role,
            "content": m.get("content").cloned().unwrap_or(Value::String(String::new())),
        });
        if role == "assistant" {
            if let Some(r) = m.get("reasoning").cloned().filter(|v| !v.is_null()) {
                out["reasoning_content"] = r;
            }
            if let Some(tcs) = m.get("tool_calls").and_then(|v| v.as_array()) {
                let arr: Vec<Value> = tcs
                    .iter()
                    .map(|tc| {
                        json!({
                            "id": tc.get("id").cloned().unwrap_or(Value::Null),
                            "type": "function",
                            "function": {
                                "name": tc.get("name").cloned().unwrap_or(Value::Null),
                                "arguments": tc.get("arguments").cloned().unwrap_or(Value::Null),
                            }
                        })
                    })
                    .collect();
                out["tool_calls"] = Value::Array(arr);
            }
        }
        if let Some(tcid) = m.get("tool_call_id").cloned().filter(|v| !v.is_null()) {
            out["tool_call_id"] = tcid;
        }
        if let Some(name) = m.get("name").cloned().filter(|v| !v.is_null()) {
            out["name"] = name;
        }
        msgs.push(out);
    }

    let mut body = json!({
        "model": model,
        "messages": msgs,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    let mut enable_thinking = params.get("thinking").and_then(|v| v.as_bool());
    let effort: Option<String> = params
        .get("reasoningEffort")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(e) = &effort {
        enable_thinking = if e == "none" { Some(false) } else { Some(true) };
    }
    if let Some(b) = enable_thinking {
        body["enable_thinking"] = json!(b);
    }
    if let Some(e) = &effort {
        body["reasoning_effort"] = json!(e);
    }
    if let Some(p) = params.get("preserveThinking").filter(|v| !v.is_null()) {
        body["preserve_thinking"] = p.clone();
    }
    if let Some(mt) = params.get("maxTokens").and_then(|v| v.as_u64()) {
        body["max_completion_tokens"] = json!(mt);
    }
    if let Some(t) = params.get("temperature").and_then(|v| v.as_f64()) {
        body["temperature"] = json!(t);
    }
    // Order matters: greedy must win over a lingering temperature value, not
    // the other way round, or "deterministic" silently turns into "sampled".
    if params
        .get("greedy")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        body["temperature"] = json!(0);
    }
    for (key, wire) in [
        ("topP", "top_p"),
        ("topK", "top_k"),
        ("minP", "min_p"),
        ("presencePenalty", "presence_penalty"),
        ("frequencyPenalty", "frequency_penalty"),
        ("seed", "seed"),
    ] {
        if let Some(v) = params.get(key).filter(|v| !v.is_null()) {
            body[wire] = v.clone();
        }
    }
    if tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        body["tools"] = tools.clone();
    }
    body
}

// ---------------------------------------------------------------------------
// Compaction (the <compacted-summary> checkpoint convention)
// ---------------------------------------------------------------------------

/// Context for a new turn: the transcript from the most recent compaction
/// checkpoint (a user message containing a `<compacted-summary>` block) to
/// the end — the bytes before it are already folded into that summary.
pub fn compacted_context(messages: &[Value]) -> &[Value] {
    for i in (0..messages.len()).rev() {
        let m = &messages[i];
        if m.get("role").and_then(|v| v.as_str()) == Some("user")
            && m.get("content")
                .and_then(|v| v.as_str())
                .is_some_and(|c| c.contains("<compacted-summary>"))
        {
            return &messages[i..];
        }
    }
    messages
}

// ---------------------------------------------------------------------------
// Markup tool-call recovery (small models paste calls into text)
// ---------------------------------------------------------------------------

static RE_TOOL_CALL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static RE_FENCE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
static RE_TRAILING_COMMA: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();

/// `<tool_call>…</tool_call>` (JSON body, or the XML-ish function form).
fn re_tool_call() -> &'static Regex {
    RE_TOOL_CALL
        .get_or_init(|| Regex::new(r"(?s)<tool_call>(.*?)</tool_call>").expect("static regex"))
}
/// Fenced ```json / ```tool_call / ```tool_call blocks.
fn re_fence() -> &'static Regex {
    RE_FENCE.get_or_init(|| {
        Regex::new(r"(?s)```(?:json|tool_?call)\s*\n?(.*?)\n?```").expect("static regex")
    })
}
/// Trailing commas — a common small-model JSON mistake — stripped before
/// parsing (`,}` → `}`, `,]` → `]`).
fn re_trailing_comma() -> &'static Regex {
    RE_TRAILING_COMMA.get_or_init(|| Regex::new(r"(,(\s*[}\]]))").expect("static regex"))
}

/// Parse a candidate JSON body into an array of item objects.
fn parse_items(s: &str) -> Option<Vec<Value>> {
    let t = s.trim();
    if !t.starts_with('{') && !t.starts_with('[') {
        return None;
    }
    let t = re_trailing_comma().replace_all(t, "$2");
    let v: Value = serde_json::from_str(&t).ok()?;
    if let Some(arr) = v.as_array() {
        Some(arr.clone())
    } else {
        Some(vec![v])
    }
}

/// Coerce a parsed markup item into (name, args). Accepts the shapes models
/// actually emit: `name`/`function.name`/`tool` and `arguments`/
/// `function.arguments`/`args`/`parameters` (JSON string or object).
fn coerce(o: &Value) -> Option<(String, String)> {
    let obj = o.as_object()?;
    let fn_obj = obj.get("function").and_then(|v| v.as_object());
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| fn_obj.and_then(|f| f.get("name")).and_then(|v| v.as_str()))
        .or_else(|| obj.get("tool").and_then(|v| v.as_str()))?
        .trim()
        .to_string();
    if name.is_empty() {
        return None;
    }
    let mut args = obj
        .get("arguments")
        .or_else(|| fn_obj.and_then(|f| f.get("arguments")))
        .or_else(|| obj.get("args"))
        .or_else(|| obj.get("parameters"))
        .cloned()
        .unwrap_or(Value::Null);
    if let Value::String(s) = &args {
        args = serde_json::from_str(s).unwrap_or(Value::Object(Map::new()));
    }
    if !args.is_object() {
        args = Value::Object(Map::new());
    }
    Some((name, args.to_string()))
}

/// Recover tool calls a model emitted as text instead of native tool_calls.
/// Tries, in priority order: `<tool_call>` markup (JSON body or the
/// `<function=name><parameter=k>v</parameter>` XML-ish form), fenced
/// ```json/```tool_call blocks, and — only when the text is essentially
/// nothing but JSON — a bare whole-text JSON object/array. Conservative by
/// design: unrecognized JSON is left alone rather than guessed at, so a
/// normal prose reply never gets misread. Returns the parsed calls and the
/// exact raw substrings consumed, so the caller can strip only those from
/// the stored content.
pub fn parse_markup_tool_calls(text: &str) -> (Vec<Tc>, Vec<String>) {
    let mut calls: Vec<Tc> = Vec::new();
    let mut consumed: Vec<String> = Vec::new();

    // One item may yield a call; push (call, raw) pairs as we find them.
    let push_items =
        |items: &Vec<Value>, raw: &str, calls: &mut Vec<Tc>, consumed: &mut Vec<String>| {
            for o in items {
                if let Some((name, arguments)) = coerce(o) {
                    calls.push(Tc {
                        id: format!("markup_{:x}_{}", now_ms(), calls.len()),
                        name,
                        arguments,
                    });
                    consumed.push(raw.to_string());
                }
            }
        };

    for cap in re_tool_call().captures_iter(text) {
        if let Some(items) = parse_items(cap.get(1).map(|m| m.as_str()).unwrap_or("")) {
            push_items(
                &items,
                cap.get(0).unwrap().as_str(),
                &mut calls,
                &mut consumed,
            );
        }
    }
    if !calls.is_empty() {
        return (calls, consumed);
    }
    for cap in re_fence().captures_iter(text) {
        if let Some(items) = parse_items(cap.get(1).map(|m| m.as_str()).unwrap_or("")) {
            push_items(
                &items,
                cap.get(0).unwrap().as_str(),
                &mut calls,
                &mut consumed,
            );
        }
    }
    if !calls.is_empty() {
        return (calls, consumed);
    }
    // Bare JSON only: the whole (trimmed) text must be one JSON value.
    let bare = text.trim();
    if bare.len() >= 3
        && (bare.starts_with('{') || bare.starts_with('['))
        && (bare.ends_with('}') || bare.ends_with(']'))
        && let Some(items) = parse_items(bare)
    {
        push_items(&items, bare, &mut calls, &mut consumed);
    }
    (calls, consumed)
}

/// Remove the consumed raw substrings from `text` (visible/stored content).
pub fn strip_consumed(text: &str, consumed: &[String]) -> String {
    let mut out = text.to_string();
    for c in consumed {
        out = out.replacen(c, "", usize::MAX);
    }
    out.trim().to_string()
}

// ---------------------------------------------------------------------------
// Observation packing (port of the webview's ObservationPack)
// ---------------------------------------------------------------------------

/// 64-bit FNV-1a — stable per content, no dependency needed; the id only has
/// to be stable and unique enough per result (obs_recall is a store lookup).
fn fnv64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn obs_id(text: &str) -> String {
    format!("obs_{:016x}", fnv64(text))
}

fn count_lines(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    let parts = text.split('\n').count();
    if text.ends_with('\n') {
        parts as u64 - 1
    } else {
        parts as u64
    }
}

/// Up to `budget` bytes of complete lines, from the start or the end.
fn complete_line_excerpt(text: &str, budget: usize, from_end: bool) -> String {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut selected: Vec<&str> = Vec::new();
    let mut selected_bytes = 0usize;
    let mut index = if from_end {
        lines.len().saturating_sub(1)
    } else {
        0
    };
    loop {
        if from_end {
            if index == 0 {
                break;
            }
        } else if index >= lines.len() {
            break;
        }
        let line = lines[index];
        if selected_bytes + line.len() > budget {
            break;
        }
        if from_end {
            selected.insert(0, line);
        } else {
            selected.push(line);
        }
        selected_bytes += line.len();
        index = if from_end {
            index.saturating_sub(1)
        } else {
            index + 1
        };
    }
    selected.concat()
}

fn placeholder_for(id: &str, tool_name: &str, text: &str) -> String {
    let head_budget = PACK_EXCERPT_BYTES / 2;
    let tail_budget = PACK_EXCERPT_BYTES - head_budget;
    let head = complete_line_excerpt(text, head_budget, false);
    let tail = complete_line_excerpt(text, tail_budget, true);
    let bytes = text.len();
    let lines = count_lines(text);
    let tokens = (text.len() as f64 / CHARS_PER_TOKEN).ceil() as u64;
    [
        format!("[large {tool_name} result — sent in full for the last {PACK_FULL_SENDS} turns, now replaced with an excerpt to save context; nothing is lost, page it back in with obs_recall]"),
        format!("id: {id}"),
        format!("original_bytes: {bytes}"),
        format!("original_lines: {lines}"),
        format!("estimated_tokens: {tokens}"),
        format!("retrieve: call obs_recall with {{\"id\":\"{id}\",\"offset\":0}}; continue with the returned next_offset until eof is true"),
        format!("[first complete lines, up to {head_budget} bytes]"),
        head,
        format!("[middle omitted; last complete lines, up to {tail_budget} bytes]"),
        tail,
    ]
    .join("\n")
}

/// The result's text: the bash shape (stdout/stderr) or a top-level
/// `content` string; null when neither.
fn extract_tool_result_text(res: &Map<String, Value>) -> Option<String> {
    let has_std = res.get("stdout").is_some_and(|v| v.is_string())
        || res.get("stderr").is_some_and(|v| v.is_string());
    let has_content = res.get("content").is_some_and(|v| v.is_string());
    if has_std {
        let out = res.get("stdout").and_then(|v| v.as_str()).unwrap_or("");
        let err = res.get("stderr").and_then(|v| v.as_str()).unwrap_or("");
        Some(format!("{out}\n{err}"))
    } else if has_content {
        res.get("content")
            .and_then(|v| v.as_str())
            .map(String::from)
    } else {
        None
    }
}

/// Pack one tool-result message (already passed the age/shape checks).
/// Returns the packed copy, or None to keep the message as-is.
fn pack_one(shared: &RunShared, m: &Value, content: &str) -> Option<Value> {
    let tool_name = m.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
    if PACK_EXCLUDED.contains(&tool_name) || tool_name.is_empty() {
        return None;
    }
    let Ok(mut res) = serde_json::from_str::<Value>(content) else {
        return None;
    };
    let obj = res.as_object_mut()?;
    if obj.get("_summarized").and_then(|v| v.as_bool()) == Some(true) {
        return None; // already a compact receipt
    }
    let text = extract_tool_result_text(obj)?;
    if text.len() <= PACK_THRESHOLD_BYTES {
        return None;
    }
    let id = obs_id(&text);
    {
        // Lossless store for obs_recall (in-run; the client's IndexedDB copy
        // is the webview's own pipeline's concern).
        let mut recall = shared.recall.lock().unwrap_or_else(|p| p.into_inner());
        recall.entry(id.clone()).or_insert_with(|| text.clone());
    }
    let placeholder = placeholder_for(&id, tool_name, &text);
    let has_std = obj.get("stdout").is_some_and(|v| v.is_string())
        || obj.get("stderr").is_some_and(|v| v.is_string());
    if has_std {
        obj.insert("stdout".into(), Value::String(placeholder));
        obj.insert("stderr".into(), Value::String(String::new()));
    } else {
        obj.insert("content".into(), Value::String(placeholder));
    }
    Some(Value::String(res.to_string()))
}

/// Request-bound view of the context: tool results that have been sent in
/// full for the last `PACK_FULL_SENDS` turns and exceed the threshold are
/// replaced with a placeholder (head/tail excerpt + recall handle). The
/// stored transcript is never touched — a copy goes out, the originals stay
/// for display and re-sending.
pub fn pack_transcript(shared: &RunShared, context: &[Value]) -> Vec<Value> {
    // Tool-result indices (the packing window is measured in tool results,
    // not messages — a 20-message prose turn doesn't "age" a result).
    let mut tool_indices: Vec<usize> = Vec::new();
    for (i, m) in context.iter().enumerate() {
        if m.get("role").and_then(|v| v.as_str()) == Some("tool") {
            tool_indices.push(i);
        }
    }
    if tool_indices.len() <= PACK_FULL_SENDS {
        return context.to_vec();
    }

    let n = tool_indices.len();
    let mut out = context.to_vec();
    for (rank, idx) in tool_indices.iter().enumerate() {
        let later_count = n - 1 - rank;
        if later_count < PACK_FULL_SENDS {
            continue; // still within its full-send window
        }
        let idx = *idx;
        let m = &out[idx];
        let content = match m.get("content").and_then(|v| v.as_str()) {
            Some(c) => c.to_string(),
            None => continue,
        };
        // Already packed in an earlier request: reuse the cached placeholder
        // (content strings are immutable, so the mapping never changes).
        if let Some(cached) = shared
            .packed_cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&content)
            .cloned()
        {
            out[idx] = json!({
                "role": "tool",
                "tool_call_id": m.get("tool_call_id").cloned().unwrap_or(Value::Null),
                "name": m.get("name").cloned().unwrap_or(Value::Null),
                "content": cached,
            });
            continue;
        }
        if let Some(packed) = pack_one(shared, m, &content) {
            let packed_str = packed.as_str().unwrap_or_default().to_string();
            shared
                .packed_cache
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(content, packed_str.clone());
            out[idx] = json!({
                "role": "tool",
                "tool_call_id": m.get("tool_call_id").cloned().unwrap_or(Value::Null),
                "name": m.get("name").cloned().unwrap_or(Value::Null),
                "content": packed_str,
            });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Turn streaming
// ---------------------------------------------------------------------------

/// Stream one assistant turn from the engine: accumulate deltas/usage/tool
/// calls over SSE, then fall back to markup recovery when the model emitted
/// calls as text. `Err(STOP_ERR)` when a stop won the race; other errors
/// are the engine's fault (bad status, transport, …).
pub(crate) async fn stream_turn(
    state: &S,
    shared: &Arc<RunShared>,
    raw: &[u8],
) -> Result<Turn, String> {
    let port = crate::proxy::route_port(state, raw).await?;
    let api_key = shared.meta.api_key.clone().unwrap_or_else(|| {
        if let Ok(c) = state.config.try_read() {
            c.api_key.clone()
        } else {
            String::new()
        }
    });
    let url = shared
        .meta
        .base_url
        .clone()
        .map(|u| format!("{}/chat/completions", u.trim_end_matches('/')))
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}/v1/chat/completions"));

    let mut req = shared
        .client
        .post(&url)
        .header("content-type", "application/json")
        .body(raw.to_vec());
    if let Some(ref eh) = shared.meta.extra_headers
        && let Ok(parsed) = serde_json::from_str::<serde_json::Map<String, Value>>(eh)
    {
        for (k, v) in parsed {
            if let Some(s) = v.as_str() {
                let name: Result<reqwest::header::HeaderName, _> = k.parse();
                let value: Result<reqwest::header::HeaderValue, _> = s.parse();
                if let (Ok(name), Ok(value)) = (name, value) {
                    req = req.header(name, value);
                }
            }
        }
    }
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key.as_str());
    }
    let started = Instant::now();
    let resp = req
        .send()
        .await
        .map_err(|e| format!("engine request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "engine error {status}: {}",
            text.chars().take(500).collect::<String>()
        ));
    }
    let stream = resp.bytes_stream();
    let stream = crate::usage::wrap_for_usage_logging(
        state.clone(),
        Some(shared.meta.model.clone()),
        crate::usage::RequestSource::Local,
        true,
        Some(started),
        Box::pin(stream),
    );

    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Vec<Tc> = Vec::new();
    let mut finish_reason: Option<String> = None;
    let mut prompt_tokens = 0u64;
    let mut completion_tokens = 0u64;
    let mut meta = Map::new();
    let mut line_buf = String::new();
    let mut first_chunk: Option<u64> = None;

    let mut stream = stream;
    'stream_loop: loop {
        let next = tokio::select! {
            r = stream.next() => r,
            _ = shared.wait_stop() => return Err(STOP_ERR.to_string()),
        };
        let Some(chunk) = next else { break };
        let bytes = chunk.map_err(|e| e.to_string())?;
        if first_chunk.is_none() {
            first_chunk = Some(started.elapsed().as_millis() as u64);
        }
        line_buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = line_buf.find('\n') {
            let line: String = line_buf.drain(..=pos).collect();
            let line = line.trim_end_matches(['\n', '\r']);
            let Some(payload) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if payload.is_empty() {
                continue;
            }
            if payload == "[DONE]" {
                break 'stream_loop;
            }
            let Ok(chunk_v) = serde_json::from_str::<Value>(payload) else {
                continue;
            };
            // Timings (SGLang-style engine extensions), usage, and deltas.
            if let Some(t) = chunk_v.get("timings").and_then(|v| v.as_object())
                && first_chunk.is_some()
                && meta.get("promptTokPerSec").is_none()
            {
                if let Some(v) = t.get("prompt_per_second").cloned() {
                    meta.insert("promptTokPerSec".into(), v);
                }
                if let Some(v) = t.get("predicted_per_second").cloned() {
                    meta.insert("decodeTokPerSec".into(), v);
                }
                if let Some(v) = t.get("cache_n").cloned() {
                    meta.insert("cachedTokens".into(), v);
                }
                if let Some(v) = t.get("prompt_n").and_then(|p| p.as_u64())
                    && let Some(c) = t.get("cache_n").and_then(|c| c.as_u64())
                {
                    prompt_tokens = c + v;
                    meta.insert("promptTokens".into(), json!(prompt_tokens));
                }
                if let Some(v) = t.get("predicted_n").and_then(|p| p.as_u64()) {
                    completion_tokens = v;
                    meta.insert("completionTokens".into(), json!(completion_tokens));
                }
                if let Some(v) = t.get("draft_n").cloned() {
                    meta.insert("draftN".into(), v);
                }
                if let Some(v) = t.get("draft_n_accepted").cloned() {
                    meta.insert("draftNAccepted".into(), v);
                }
            }
            if let Some(u) = chunk_v.get("usage").and_then(|v| v.as_object()) {
                if let Some(p) = u.get("prompt_tokens").and_then(|v| v.as_u64()) {
                    prompt_tokens = p;
                }
                if let Some(c) = u.get("completion_tokens").and_then(|v| v.as_u64()) {
                    completion_tokens = c;
                }
                if prompt_tokens > 0 || completion_tokens > 0 {
                    meta.insert("promptTokens".into(), json!(prompt_tokens));
                    meta.insert("completionTokens".into(), json!(completion_tokens));
                }
            }
            let Some(choice) = chunk_v.get("choices").and_then(|c| c.get(0)) else {
                continue;
            };
            if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
                finish_reason = Some(fr.to_string());
            }
            let Some(delta) = choice.get("delta") else {
                if finish_reason.is_some() {
                    break 'stream_loop;
                }
                continue;
            };
            if let Some(d) = delta.get("content").and_then(|v| v.as_str())
                && !d.is_empty()
            {
                content.push_str(d);
                let _ = shared.tx.send(AgentEvent::Delta {
                    kind: "content",
                    text: d.to_string(),
                });
            }
            if let Some(d) = delta.get("reasoning_content").and_then(|v| v.as_str())
                && !d.is_empty()
            {
                reasoning.push_str(d);
                let _ = shared.tx.send(AgentEvent::Delta {
                    kind: "reasoning",
                    text: d.to_string(),
                });
            }
            if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                for tc in tcs {
                    let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    while tool_calls.len() <= idx {
                        tool_calls.push(Tc {
                            id: String::new(),
                            name: String::new(),
                            arguments: String::new(),
                        });
                    }
                    let slot = &mut tool_calls[idx];
                    if let Some(v) = tc.get("id").and_then(|v| v.as_str()) {
                        slot.id = v.to_string();
                    }
                    if let Some(f) = tc.get("function") {
                        if let Some(n) = f.get("name").and_then(|v| v.as_str()) {
                            slot.name.push_str(n);
                        }
                        if let Some(a) = f.get("arguments").and_then(|v| v.as_str()) {
                            slot.arguments.push_str(a);
                        }
                    }
                }
            }
            if finish_reason.is_some() {
                break 'stream_loop;
            }
        }
    }

    // Markup recovery: the model pasted calls as text instead of using the
    // engine's structured field. Conservative (see parse_markup_tool_calls).
    let mut dropped: Vec<String> = Vec::new();
    if tool_calls.is_empty() {
        let source = if !content.trim().is_empty() {
            content.as_str()
        } else {
            reasoning.as_str()
        };
        if !source.is_empty() {
            let (parsed, consumed) = parse_markup_tool_calls(source);
            if !parsed.is_empty() {
                let declared: std::collections::HashSet<&str> =
                    shared.meta.tool_names.iter().map(String::as_str).collect();
                dropped = parsed
                    .iter()
                    .map(|t| t.name.clone())
                    .filter(|n| !declared.contains(n.as_str()))
                    .collect();
                let kept: Vec<Tc> = parsed
                    .into_iter()
                    .filter(|tc| declared.contains(tc.name.as_str()))
                    .collect();
                if !consumed.is_empty() {
                    content = strip_consumed(&content, &consumed);
                }
                tool_calls = kept;
            }
        }
    }

    if prompt_tokens == 0 {
        prompt_tokens = (raw.len() as f64 / CHARS_PER_TOKEN).round() as u64;
    }
    if completion_tokens == 0 && !content.is_empty() {
        completion_tokens = (content.len() as f64 / CHARS_PER_TOKEN).round() as u64;
    }
    if meta.get("promptTokens").is_none() && prompt_tokens > 0 {
        meta.insert("promptTokens".into(), json!(prompt_tokens));
    }
    if meta.get("completionTokens").is_none() && completion_tokens > 0 {
        meta.insert("completionTokens".into(), json!(completion_tokens));
    }
    if meta.get("decodeTokPerSec").is_none() && completion_tokens > 0 {
        let elapsed_sec = started.elapsed().as_secs_f64();
        if elapsed_sec > 0.0 {
            let tps = completion_tokens as f64 / elapsed_sec;
            meta.insert("decodeTokPerSec".into(), json!(tps));
        }
    }
    if let Some(first) = first_chunk {
        meta.insert("ttftMs".into(), json!(first));
    }
    Ok(Turn {
        content,
        reasoning,
        tool_calls,
        dropped,
        finish_reason,
        prompt_tokens,
        completion_tokens,
        meta: Value::Object(meta),
    })
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

fn lock_live(shared: &RunShared) -> std::sync::MutexGuard<'_, crate::agent::run::RunLive> {
    shared.live.lock().unwrap_or_else(|p| p.into_inner())
}

fn finish(shared: &Arc<RunShared>, stop: &str) {
    if !shared.status().is_terminal() {
        shared.mark_terminal(RunStatus::Done, Some(stop.to_string()), None);
    }
}

/// The bounded agent loop for one run (see module docs). Spawns nothing and
/// owns no state beyond `shared` — it is the single writer for the run's
/// transcript and status.
pub async fn run(state: S, shared: Arc<RunShared>) {
    let meta = shared.meta.clone();
    let max_steps = meta.max_steps;
    let mut turns = 0usize;

    if meta.plan {
        let task = {
            let live = lock_live(&shared);
            live.messages
                .last()
                .and_then(|m| m.get("content").and_then(|v| v.as_str()))
                .unwrap_or_default()
                .to_string()
        };
        let c = chat_once(
            &shared.client,
            &state,
            &meta.model,
            meta.base_url.as_deref(),
            meta.api_key.as_deref(),
            "You are an IDEATION pass before implementation. Do NOT write any code and do NOT solve the task. Identify the core difficulty, then list 2-4 genuinely distinct candidate approaches (different algorithms/data structures/designs -- not variations of one idea), noting a pitfall for each. Prose only, no code blocks, under 250 words.",
            &task,
            Some(0.4),
            Some(1024),
            Duration::from_secs(30)
        ).await;
        if let Ok(plan_text) = c {
            shared.append(json!({
                "role": "assistant",
                "content": format!("[Ideation / Plan]\n{plan_text}")
            }));
        }
    }

    loop {
        if turns >= max_steps || shared.status().is_terminal() {
            finish(&shared, "steps");
            return;
        }
        // Context for this turn: compaction-sliced + observation-packed copy.
        let context = {
            let live = lock_live(&shared);
            compacted_context(&live.messages).to_vec()
        };
        let context = pack_transcript(&shared, &context);
        // Per-turn system: the run's base system + the live task list (coder
        // runs — the list must survive compaction and reflect user edits made
        // mid-run). Capturing `todo_base_rev` here anchors the stale-write
        // guard: it is the list this response was generated from.
        let system = {
            let mut live = lock_live(&shared);
            live.todo_base_rev = live.todo_rev;
            let mut sys = meta.system.clone().unwrap_or_default();
            if meta.kind == "coder"
                && let Some(t) = live.todo.as_ref().filter(|t| !t.is_null())
            {
                sys.push_str(&todo_system_block(t));
            }
            sys
        };
        let req = build_request(
            &meta.model,
            Some(&system),
            &context,
            &meta.params,
            &meta.tools_spec,
        );
        let raw = serde_json::to_vec(&req).unwrap_or_default();
        // Token estimate of this request for the client's compaction gate.
        let est_tokens = (raw.len() as f64 / CHARS_PER_TOKEN).round() as u64;

        let _ = shared.tx.send(AgentEvent::TurnStarted { turns });
        // Stream the turn, retrying transient engine failures with growing
        // backoff (the webview loop did the same: 3 attempts, 800ms·n).
        let mut turn = None;
        for attempt in 1..=3u32 {
            match stream_turn(&state, &shared, &raw).await {
                Ok(t) => {
                    turn = Some(t);
                    break;
                }
                Err(e) if e == STOP_ERR => {
                    // stop_run already marked the run terminal — just unwind.
                    return;
                }
                Err(e) => {
                    if attempt < 3 {
                        let mut stop_rx = shared.stop_rx.clone();
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_millis(800 * attempt as u64)) => {}
                            _ = stop_rx.changed() => return, // stop won the race
                        };
                        continue;
                    }
                    if !shared.status().is_terminal() {
                        shared.mark_terminal(RunStatus::Error, None, Some(e));
                    }
                    return;
                }
            }
        }
        let turn = turn.expect("Ok branch set it, errors returned");

        // Append the assistant message (raw reasoning; content with any
        // consumed markup stripped) and record the turn's accounting.
        let mut am = json!({ "role": "assistant", "content": turn.content });
        if !turn.reasoning.is_empty() {
            am["reasoning"] = json!(turn.reasoning);
        }
        if !turn.tool_calls.is_empty() {
            am["tool_calls"] = Value::Array(turn.tool_calls.iter().map(Tc::to_value).collect());
        }
        if !turn.meta.is_null() && turn.meta.as_object().is_some_and(|o| !o.is_empty()) {
            am["meta"] = turn.meta.clone();
        }
        shared.append(am);
        {
            let mut live = lock_live(&shared);
            live.usage.prompt_tokens += turn.prompt_tokens;
            live.usage.completion_tokens += turn.completion_tokens;
            live.usage.total_tokens += turn.prompt_tokens + turn.completion_tokens;
            live.finish_reason = turn.finish_reason.clone();
            live.last_meta = Some(turn.meta.clone());
        }

        if turn.tool_calls.is_empty() {
            if turn.finish_reason.as_deref() == Some("length")
                && !turn.content.trim().is_empty()
                && matches!(meta.kind.as_str(), "worker" | "coder")
            {
                let snippet = turn.content.clone();
                let sum = chat_once(
                    &shared.client,
                    &state,
                    &shared.meta.model,
                    shared.meta.base_url.as_deref(),
                    shared.meta.api_key.as_deref(),
                    "A worker's reply was CUT OFF by the token limit mid-generation. Summarize its partial attempt in 3-5 sentences: which approach it was pursuing, what it established, how far it got, and what remains unfinished. Do not try to finish the work yourself.",
                    &snippet,
                    None,
                    Some(512),
                    Duration::from_secs(30)
                ).await.unwrap_or_else(|e| format!("(summarization failed: {e})"));
                shared.append(json!({
                    "role": "user",
                    "content": format!("[Worker partial summary: {sum}]")
                }));
                // Token limit mid-turn: hand the next step a continuation
                // note (the partial reply above stays in the transcript).
                shared.append(json!({ "role": "user", "content": CUTOFF_NOTE }));
                turns += 1;
                continue;
            }
            if turn.content.trim().is_empty() && turn.reasoning.trim().is_empty() {
                finish_err(
                    &shared,
                    "engine returned an empty reply (no content, no tool calls)",
                );
                return;
            }
            match await_turn_hook(&shared, &turn, turns, est_tokens).await {
                HookOutcome::Finish => {
                    finish(&shared, "done");
                    return;
                }
                HookOutcome::Continue => {
                    turns += 1;
                    continue;
                }
                HookOutcome::Aborted => return, // already marked Stopped
            }
        }

        for tc in &turn.tool_calls {
            let _ = shared.tx.send(AgentEvent::ToolCall {
                id: tc.id.clone(),
                name: tc.name.clone(),
                args: tc.arguments.clone(),
            });
        }

        // Dispatch in parallel (the client's Promise.all), each leg racing
        // the stop flag so a stop cancels in-flight tools, not just the
        // next loop pass.
        let legs: Vec<_> = turn
            .tool_calls
            .iter()
            .map(|tc| {
                let state = state.clone();
                let run = shared.clone();
                let (name, args) = (tc.name.clone(), tc.arguments.clone());
                async move {
                    let parsed: Value =
                        serde_json::from_str(&args).unwrap_or(Value::Object(Map::new()));
                    tokio::select! {
                        r = tools::dispatch(&state, &run, &name, &parsed) => r,
                        _ = run.wait_stop() => json!({ "error": "run stopped" }),
                    }
                }
            })
            .collect();
        let results = join_all(legs).await;

        for (tc, result) in turn.tool_calls.iter().zip(results) {
            let text = result.to_string();
            let is_error = result.get("error").is_some();
            let preview: String = text.chars().take(400).collect();
            let _ = shared.tx.send(AgentEvent::ToolResult {
                id: tc.id.clone(),
                name: tc.name.clone(),
                preview,
                error: is_error,
            });
            shared.append(json!({
                "role": "tool",
                "tool_call_id": tc.id,
                "name": tc.name,
                "content": text,
            }));
        }

        // Tell the model about calls it made with names its tool set doesn't
        // declare (instead of silently dropping them).
        if !turn.dropped.is_empty() {
            let names = turn.dropped.join(", ");
            shared.append(json!({
                "role": "system",
                "content": format!(
                    "You called tools that are not available in this session: {names}. \
            Use only the tools listed above."
                ),
            }));
        }

        if let Some(ref critic_model) = meta.critic {
            let turn_input = format!("Turn {} completed. Content: {}", turns, turn.content);
            let critic_sys = "You are a CRITIC reviewing the agent's progress. Evaluate whether the agent is making progress toward the goal or going in circles.";
            let c = chat_once(
                &shared.client,
                &state,
                critic_model.as_str().unwrap_or_default(),
                shared.meta.base_url.as_deref(),
                shared.meta.api_key.as_deref(),
                critic_sys,
                &turn_input,
                Some(0.4),
                Some(2048),
                Duration::from_secs(45),
            )
            .await;
            if let Ok(critique) = c {
                shared.append(json!({
                    "role": "system",
                    "content": format!("[Critic Review]\n{critique}")
                }));
            }
        }

        // Tool-call turn end: a client-hook screen may still want its gate
        // (e.g. the compaction pass before the next engine call).
        match await_turn_hook(&shared, &turn, turns, est_tokens).await {
            HookOutcome::Finish => {
                finish(&shared, "done");
                return;
            }
            HookOutcome::Aborted => return,
            HookOutcome::Continue => {}
        }
        turns += 1;
    }
}

fn finish_err(shared: &Arc<RunShared>, message: &str) {
    if !shared.status().is_terminal() {
        shared.mark_terminal(RunStatus::Error, None, Some(message.to_string()));
    }
}

// ---------------------------------------------------------------------------
// Turn hooks + one-shot passes
// ---------------------------------------------------------------------------

/// How the loop proceeds after a turn-hook decision.
enum HookOutcome {
    /// The turn stands; the run ends.
    Finish,
    /// Keep looping (client asked for another turn, or timeout default on a
    /// tool turn).
    Continue,
    /// Run aborted — already marked terminal by `stop_run`.
    Aborted,
}

/// Turn-end hook. `auto` mode never pauses (tool-less turn ends the run).
/// `client` mode pauses at every turn end: the attached screen runs its
/// per-turn passes (humanize rewrite, compaction gate, …) and POSTs a
/// decision to `/runs/{id}/hooks/{hid}`. A client that never answers gets
/// the webview default after [`HOOK_TIMEOUT`]: done on a tool-less turn,
/// continue on a tool turn.
async fn await_turn_hook(
    shared: &Arc<RunShared>,
    turn: &Turn,
    turns: usize,
    est_tokens: u64,
) -> HookOutcome {
    let had_tool_calls = !turn.tool_calls.is_empty();
    if *shared.hook_mode.lock().unwrap_or_else(|p| p.into_inner()) != HookMode::Client {
        return if had_tool_calls {
            HookOutcome::Continue
        } else {
            HookOutcome::Finish
        };
    }
    let hid = format!("hk_{:x}_{turns}", now_ms());
    let (tx, rx) = oneshot::channel();
    {
        let mut live = lock_live(shared);
        live.pending_hook = Some(hid.clone());
        *shared.hook_wait.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);
    }
    shared.set_status(RunStatus::AwaitingHook);
    let _ = shared.tx.send(AgentEvent::HookRequested {
        id: hid.clone(),
        turns,
        finish_reason: turn.finish_reason.clone(),
        had_tool_calls,
        est_tokens,
    });

    let mut stop_rx = shared.stop_rx.clone();
    let decision = tokio::select! {
        d = rx => match d {
            Ok(d) => d,
            // Delivery failed (the run stopped mid-pause).
            Err(_) => HookDecision::Abort,
        },
        _ = stop_rx.changed() => HookDecision::Abort,
        _ = tokio::time::sleep(HOOK_TIMEOUT) => {
            if had_tool_calls {
                HookDecision::Continue { content: None, note: None, transcript: None }
            } else {
                HookDecision::Done
            }
        }
    };
    shared
        .hook_wait
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take();
    lock_live(shared).pending_hook = None;
    let _ = shared.tx.send(AgentEvent::HookResolved {
        id: hid,
        action: decision.action_name().to_string(),
    });

    match decision {
        HookDecision::Done => {
            shared.set_status(RunStatus::Running);
            HookOutcome::Finish
        }
        HookDecision::Replace { content } => {
            replace_last_assistant_content(shared, &content);
            shared.set_status(RunStatus::Running);
            HookOutcome::Finish
        }
        HookDecision::Continue {
            content,
            note,
            transcript,
        } => {
            if let Some(t) = transcript {
                lock_live(shared).messages = t;
            }
            if let Some(c) = content {
                replace_last_assistant_content(shared, &c);
            }
            if let Some(n) = note {
                shared.append(json!({ "role": "user", "content": n }));
            }
            shared.set_status(RunStatus::Running);
            HookOutcome::Continue
        }
        HookDecision::Abort => {
            shared.stop_run();
            HookOutcome::Aborted
        }
    }
}

/// Swap the content of the run's most recent assistant message (the
/// humanize-rewrite decision).
fn replace_last_assistant_content(shared: &Arc<RunShared>, content: &str) {
    let mut live = lock_live(shared);
    if let Some(m) = live
        .messages
        .iter_mut()
        .rev()
        .find(|m| m.get("role").and_then(|v| v.as_str()) == Some("assistant"))
    {
        m["content"] = json!(content);
    }
    live.updated_at = now_ms();
}

/// Render the run's live task list as a system-prompt block (the client's
/// `todoSystemBlock`, ported). An empty list still gets a block — the
/// transcript may carry an older non-empty plan, and without the marker the
/// next turn could resume stale work.
pub(crate) fn todo_system_block(todos: &Value) -> String {
    let items = todos.as_array().cloned().unwrap_or_default();
    let lines: Vec<String> = if items.is_empty() {
        vec!["(no active tasks — the task list was cleared; do not resume work from an earlier plan unless the user asks or re-adds a task)".into()]
    } else {
        items
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let content = t
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let mark = match t.get("status").and_then(|v| v.as_str()) {
                    Some("completed") => "x",
                    Some("in_progress") => "~",
                    _ => " ",
                };
                format!("{}. [{mark}] {content}", i + 1)
            })
            .collect()
    };
    format!(
        "\n\n# Current task list (live — kept in sync via the todo_write tool; the user can edit it — treat it as the source of truth for progress)\n{}\n",
        lines.join("\n")
    )
}

/// One-shot engine chat for the auxiliary passes (worker ideation, critic
/// review): stream `/v1/chat/completions` and return the final content. No
/// usage tap, no events — these are best-effort helper calls.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn chat_once(
    client: &reqwest::Client,
    state: &S,
    model: &str,
    base_url: Option<&str>,
    api_key_override: Option<&str>,
    system: &str,
    user: &str,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    timeout: Duration,
) -> Result<String, String> {
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "stream": true,
    });
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = max_tokens {
        body["max_completion_tokens"] = json!(m);
    }
    let raw = serde_json::to_vec(&body).unwrap_or_default();
    let port = crate::proxy::route_port(state, &raw).await?;
    let api_key = api_key_override.map(|s| s.to_string()).unwrap_or_else(|| {
        if let Ok(c) = state.config.try_read() {
            c.api_key.clone()
        } else {
            String::new()
        }
    });
    let url = base_url
        .map(|u| format!("{}/chat/completions", u.trim_end_matches('/')))
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}/v1/chat/completions"));

    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .body(raw);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key.as_str());
    }
    let resp = req
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("engine request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("engine returned HTTP {}", resp.status()));
    }

    let mut content = String::new();
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(content);
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            let Some(d) = v["choices"]
                .get(0)
                .and_then(|c| c["delta"].get("content"))
                .and_then(|x| x.as_str())
            else {
                continue;
            };
            content.push_str(d);
        }
    }
    Ok(content)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::State;

    fn fresh_state(data: std::path::PathBuf, ws: std::path::PathBuf) -> S {
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&ws).unwrap();
        Arc::new(State::new(data, ws, None))
    }

    fn tool_msg(name: &str, id: &str, content: &str) -> Value {
        json!({ "role": "tool", "tool_call_id": id, "name": name, "content": content })
    }

    #[test]
    fn build_request_maps_engine_contract() {
        let params = json!({
            "thinking": false,
            "reasoningEffort": "high",
            "maxTokens": 1024,
            "temperature": 0.7,
            "topK": 40,
            "greedy": true,
        });
        let tools = json!([{ "type": "function", "function": { "name": "read" } }]);
        let msgs = vec![
            json!({ "role": "user", "content": "hi" }),
            json!({ "role": "assistant", "content": "ok", "reasoning": "hmm" }),
        ];
        let req = build_request("m", Some("SYS"), &msgs, &params, &tools);
        assert_eq!(req["model"], "m");
        assert_eq!(req["stream"], true);
        // effort wins the thinking switch (one intent, no contradictory pair)
        assert_eq!(req["enable_thinking"], true);
        assert_eq!(req["reasoning_effort"], "high");
        assert_eq!(req["max_completion_tokens"], 1024);
        // greedy wins the lingering temperature
        assert_eq!(req["temperature"], 0);
        assert_eq!(req["top_k"], 40);
        assert_eq!(req["tools"][0]["function"]["name"], "read");
        // system prepended + transcript wired (reasoning_content on assistant)
        assert_eq!(req["messages"][0]["role"], "system");
        assert_eq!(req["messages"][0]["content"], "SYS");
        assert_eq!(req["messages"][2]["role"], "assistant");
        assert_eq!(req["messages"][2]["reasoning_content"], "hmm");
        // system messages inside the transcript are skipped
        let msgs2 = vec![
            json!({ "role": "system", "content": "OLD" }),
            json!({ "role": "user", "content": "x" }),
        ];
        let req2 = build_request("m", None, &msgs2, &json!({}), &json!([]));
        assert_eq!(req2["messages"].as_array().unwrap().len(), 1);
        assert!(req2.get("tools").is_none());
    }
    #[test]
    fn build_request_att_becomes_content_parts() {
        let m = json!({
            "role": "user",
            "content": "look",
            "attachments": [{ "path": "/tmp/a.txt", "body": "abc" }],
        });
        let req = build_request("m", None, std::slice::from_ref(&m), &json!({}), &json!([]));
        let content = req["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[0]["text"], "look");
        assert!(
            content[1]["text"]
                .as_str()
                .unwrap()
                .contains("[Attached file: /tmp/a.txt]")
        );
        assert_eq!(req["messages"][0]["role"], "user");
        // The client's ChatAttachment shape (kind/dataUrl/content keys).
        let m2 = json!({
            "role": "user",
            "content": "",
            "attachments": [
                { "kind": "file", "name": "b.md", "content": "hi ```x```" },
                { "kind": "image", "name": "p.png", "dataUrl": "data:image/png;base64,AAA" },
            ],
        });
        let req2 = build_request("m", None, std::slice::from_ref(&m2), &json!({}), &json!([]));
        let c2 = req2["messages"][0]["content"].as_array().unwrap();
        assert_eq!(c2.len(), 2);
        assert!(c2[0]["text"].as_str().unwrap().contains("````\n"));
        assert_eq!(c2[1]["image_url"]["url"], "data:image/png;base64,AAA");
    }

    #[test]
    fn markup_recovery_tool_call_and_strip() {
        let text = "Sure, I'll read it:\n<tool_call>{\"function\":{\"name\":\"read\",\"arguments\":{\"path\":\"a.txt\"}}}</tool_call>\ndone";
        let (calls, consumed) = parse_markup_tool_calls(text);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read");
        let args: Value = serde_json::from_str(&calls[0].arguments).unwrap();
        assert_eq!(args["path"], "a.txt");
        let stripped = strip_consumed(text, &consumed);
        assert!(!stripped.contains("<tool_call>"));
        assert!(stripped.contains("Sure, I'll read it:"));
        assert!(stripped.contains("done"));
    }

    #[test]
    fn markup_recovery_fence_and_bare_json() {
        let fenced = "result:\n```json\n[{\"name\": \"grep\", \"arguments\": {\"pattern\": \"foo\"}}]\n```\nbye";
        let (calls, consumed) = parse_markup_tool_calls(fenced);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "grep");
        assert!(strip_consumed(fenced, &consumed).contains("result:"));

        // bare JSON only: the whole text is one JSON value
        let bare = "{\"name\":\"glob\",\"args\":{\"pattern\":\"*.rs\"}}";
        let (calls, _) = parse_markup_tool_calls(bare);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "glob");
        let args: Value = serde_json::from_str(&calls[0].arguments).unwrap();
        assert_eq!(args["pattern"], "*.rs");

        // trailing-comma tolerance
        let tc = "<tool_call>{\"name\": \"write\", \"arguments\": {\"path\": \"b\", \"content\": \"x\",},}</tool_call>";
        let (calls, _) = parse_markup_tool_calls(tc);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "write");
    }

    #[test]
    fn markup_recovery_conservative_on_prose() {
        // Normal prose that mentions braces must NOT be misread.
        let prose = "The function `f(x) { return x; }` is fine. Use {curly} braces carefully.";
        let (calls, consumed) = parse_markup_tool_calls(prose);
        assert!(calls.is_empty());
        assert!(consumed.is_empty());
        // A JSON snippet inside prose is left alone (fence/bare rules fail).
        let mixed = "Here is config: {\"a\": 1} hope that helps";
        let (calls, _) = parse_markup_tool_calls(mixed);
        assert!(calls.is_empty());
    }

    #[test]
    fn compaction_slices_from_last_checkpoint() {
        let msgs = vec![
            json!({ "role": "user", "content": "old" }),
            json!({ "role": "user", "content": "<compacted-summary>\nold summary\n</compacted-summary>" }),
            json!({ "role": "user", "content": "new" }),
        ];
        let ctx = compacted_context(&msgs);
        assert_eq!(ctx.len(), 2);
        assert!(
            ctx[0]["content"]
                .as_str()
                .unwrap()
                .contains("compacted-summary")
        );
        let msgs2 = vec![json!({ "role": "user", "content": "no checkpoint" })];
        assert_eq!(compacted_context(&msgs2).len(), 1);
    }

    #[tokio::test]
    async fn packing_replaces_old_large_tool_results_only() {
        let tmp = std::env::temp_dir().join(format!("ninfier-packtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let _state = fresh_state(tmp.clone(), tmp.join("ws"));
        let (tx, _rx) = tokio::sync::broadcast::channel(8);
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let shared = Arc::new(crate::agent::run::RunShared {
            meta: crate::agent::run::RunMeta {
                id: "run_packtest".into(),
                kind: "coder".into(),
                label: "t".into(),
                model: "m".into(),
                system: None,
                max_steps: 4,
                created_at: now_ms(),
                tool_set: "coder".into(),
                tool_names: vec!["bash".into()],
                tools_spec: Value::Array(vec![]),
                params: Value::Null,
                parent: None,
                plan: false,
                api_key: None,
                base_url: None,
                extra_headers: None,
                allow_fallback: true,
                critic: None,
            },
            live: std::sync::Mutex::new(crate::agent::run::RunLive {
                status: RunStatus::Running,
                messages: Vec::new(),
                turns: 0,
                updated_at: now_ms(),
                finish_reason: None,
                error: None,
                stop: None,
                pending_approvals: vec![],
                user_question: None,
                pending_hook: None,
                todo: None,
                scope: Some(tmp.join("ws").to_string_lossy().into_owned()),
                usage: Default::default(),
                last_meta: None,
                todo_rev: 0,
                todo_base_rev: 0,
            }),
            tx,
            approvals: std::sync::Mutex::new(std::collections::HashMap::new()),
            question_tx: std::sync::Mutex::new(None),
            recall: std::sync::Mutex::new(std::collections::HashMap::new()),
            packed_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            stop_tx,
            stop_rx,
            hook_mode: std::sync::Mutex::new(crate::agent::run::HookMode::Auto),
            hook_wait: std::sync::Mutex::new(None),
            gate_state: Default::default(),
            client: reqwest::Client::new(),
        });

        // Three bash results: two old (packed), one fresh (kept). The old
        // one must be large enough to pack and JSON-object-shaped.
        let big = "line\n".repeat(3000); // ~15KB
        let old = json!({ "stdout": big.clone(), "stderr": "", "exitCode": 0 });
        let msgs = vec![
            tool_msg("bash", "1", &old.to_string()),
            json!({ "role": "assistant", "content": "…" }),
            tool_msg(
                "grep",
                "2",
                &format!("{{\"results\": \"{}\"}}", "x".repeat(9000)),
            ),
            json!({ "role": "assistant", "content": "…" }),
            tool_msg(
                "bash",
                "3",
                &format!("{{\"stdout\": \"{}\", \"stderr\": \"\"}}", "y".repeat(9000)),
            ),
        ];
        let packed = pack_transcript(&shared, &msgs);
        // old bash packed: placeholder + recall handle, stderr cleared
        let p1: Value = serde_json::from_str(packed[0]["content"].as_str().unwrap()).unwrap();
        assert!(
            p1["stdout"]
                .as_str()
                .unwrap()
                .starts_with("[large bash result")
        );
        assert!(p1["stdout"].as_str().unwrap().contains("obs_recall"));
        assert_eq!(p1["stderr"], "");
        let id = p1["stdout"]
            .as_str()
            .unwrap()
            .split("id: ")
            .nth(1)
            .unwrap()
            .split('\n')
            .next()
            .unwrap()
            .trim()
            .to_string();
        // recall store has the full text under that id
        let recall = shared.recall.lock().unwrap();
        assert_eq!(recall.get(&id).map(String::len), Some(big.len() + 1)); // stdout + "\n" + stderr
        // grep result: excluded tool — untouched
        assert_eq!(packed[2]["content"], msgs[2]["content"]);
        // fresh bash result: within the full-send window — untouched
        assert_eq!(packed[4]["content"], msgs[4]["content"]);
        // the stored transcript itself is never touched
        assert!(packed[0] != msgs[0]);

        // stable across requests: a second pack of the packed view reuses
        // the cached placeholder for the same original content
        let again = pack_transcript(&shared, &msgs);
        assert_eq!(again[0]["content"], packed[0]["content"]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// End-to-end: a fake engine (raw TCP, SSE) drives a full run — turn 1
    /// is a markup tool call the loop recovers + dispatches in-process,
    /// turn 2 is a plain reply that ends the run.
    #[tokio::test]
    async fn e2e_mock_engine_run_with_markup_tool_call() {
        let tmp = std::env::temp_dir().join(format!("ninfier-agent-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let state = fresh_state(tmp.clone(), tmp.join("ws"));
        std::fs::write(tmp.join("ws").join("a.txt"), "hello").unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        {
            let mut eng = state.engine.write().await;
            eng.port = Some(port);
            eng.model_id = Some("mock-model".to_string());
            eng.state = crate::types::EngineState::Running;
        }

        let srv = listener;
        tokio::spawn(async move {
            let sse = "data: {\"choices\":[{\"delta\":{}}]}\n\n";
            let done = "data: [DONE]\n\n";
            loop {
                let Ok((mut sock, _)) = srv.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
                    let mut buf = vec![0u8; 65536];
                    let mut body = String::new();
                    loop {
                        match sock.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                body.push_str(&String::from_utf8_lossy(&buf[..n]));
                                if body.contains("\r\n\r\n") {
                                    break;
                                }
                            }
                        }
                    }
                    let has_tool_result = body.contains("\"role\":\"tool\"");
                    let payload = if !has_tool_result {
                        format!(
                            "{sse}data: {{\"choices\":[{{\"delta\":{{\"content\":\"<tool_call>{{\\\"name\\\":\\\"read\\\",\\\"arguments\\\":{{\\\"path\\\":\\\"a.txt\\\"}}}}</tool_call>\"}}}}]}}\n\n{done}"
                        )
                    } else {
                        format!(
                            "{sse}data: {{\"choices\":[{{\"delta\":{{\"content\":\"The file contains: hello.\"}},\"finish_reason\":\"stop\"}}]}}\n\n{done}"
                        )
                    };
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });

        let (tx, _rx) = tokio::sync::broadcast::channel(64);
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let meta = crate::agent::run::RunMeta {
            id: "run_e2e_test".into(),
            kind: "coder".into(),
            label: "e2e".into(),
            model: "mock-model".into(),
            system: None,
            max_steps: 4,
            created_at: now_ms(),
            tool_set: "coder".into(),
            tool_names: vec!["read".into()],
            tools_spec: Value::Array(vec![]),
            params: Value::Null,
            parent: None,
            plan: false,
            api_key: None,
            base_url: None,
            extra_headers: None,
            allow_fallback: true,
            critic: None,
        };
        let live = crate::agent::run::RunLive {
            status: RunStatus::Running,
            messages: vec![json!({ "role": "user", "content": "read a.txt" })],
            turns: 0,
            updated_at: now_ms(),
            finish_reason: None,
            error: None,
            stop: None,
            pending_approvals: vec![],
            user_question: None,
            pending_hook: None,
            todo: None,
            scope: Some(tmp.join("ws").to_string_lossy().into_owned()),
            usage: Default::default(),
            last_meta: None,
            todo_rev: 0,
            todo_base_rev: 0,
        };
        let shared = Arc::new(crate::agent::run::RunShared {
            meta,
            live: std::sync::Mutex::new(live),
            tx,
            approvals: std::sync::Mutex::new(std::collections::HashMap::new()),
            question_tx: std::sync::Mutex::new(None),
            recall: std::sync::Mutex::new(std::collections::HashMap::new()),
            packed_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            stop_tx,
            stop_rx,
            hook_mode: std::sync::Mutex::new(crate::agent::run::HookMode::Auto),
            hook_wait: std::sync::Mutex::new(None),
            gate_state: Default::default(),
            client: reqwest::Client::new(),
        });
        state
            .agent_runs
            .lock()
            .unwrap()
            .insert(shared.meta.id.clone(), shared.clone());

        run(state, shared.clone()).await;

        let snap = shared.snapshot();
        assert!(
            snap.status.is_terminal(),
            "run must end terminal, got {:?} (error: {:?})",
            snap.status,
            snap.error
        );
        assert_eq!(snap.stop.as_deref(), Some("done"), "snap: {snap:?}");
        // transcript: user, assistant(markup stripped), tool(read result), assistant(final)
        assert_eq!(snap.messages.len(), 4, "{:?}", snap.messages);
        assert_eq!(snap.messages[1]["role"], "assistant");
        assert!(
            !snap.messages[1]["content"]
                .as_str()
                .unwrap()
                .contains("<tool_call>")
        );
        assert_eq!(snap.messages[2]["role"], "tool");
        let tool_content: Value =
            serde_json::from_str(snap.messages[2]["content"].as_str().unwrap()).unwrap();
        assert_eq!(tool_content["content"], "hello");
        assert_eq!(snap.messages[3]["content"], "The file contains: hello.");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// A stop request mid-stream ends the run as stopped/aborted.
    #[tokio::test]
    async fn stop_cancels_in_flight_stream() {
        let tmp = std::env::temp_dir().join(format!("ninfier-agent-stop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let state = fresh_state(tmp.clone(), tmp.join("ws"));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        {
            let mut eng = state.engine.write().await;
            eng.port = Some(port);
            eng.state = crate::types::EngineState::Running;
        }
        let srv = listener;
        tokio::spawn(async move {
            let Ok((mut sock, _)) = srv.accept().await else {
                return;
            };
            // Send one header, then stall forever — the stop must win.
            let _ = tokio::io::AsyncWriteExt::write_all(
                &mut sock,
                b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n",
            )
            .await;
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        });

        let (tx, _rx) = tokio::sync::broadcast::channel(8);
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let meta = crate::agent::run::RunMeta {
            id: "run_stop_test".into(),
            kind: "chat".into(),
            label: "stop".into(),
            model: "mock-model".into(),
            system: None,
            max_steps: 2,
            created_at: now_ms(),
            tool_set: "chat".into(),
            tool_names: vec!["web_search".into()],
            tools_spec: Value::Array(vec![]),
            params: Value::Null,
            parent: None,
            plan: false,
            api_key: None,
            base_url: None,
            extra_headers: None,
            allow_fallback: true,
            critic: None,
        };
        let shared = Arc::new(crate::agent::run::RunShared {
            meta,
            live: std::sync::Mutex::new(crate::agent::run::RunLive {
                status: RunStatus::Running,
                messages: vec![json!({ "role": "user", "content": "go" })],
                turns: 0,
                updated_at: now_ms(),
                finish_reason: None,
                error: None,
                stop: None,
                pending_approvals: vec![],
                user_question: None,
                pending_hook: None,
                todo: None,
                scope: None,
                usage: Default::default(),
                last_meta: None,
                todo_rev: 0,
                todo_base_rev: 0,
            }),
            tx,
            approvals: std::sync::Mutex::new(std::collections::HashMap::new()),
            question_tx: std::sync::Mutex::new(None),
            recall: std::sync::Mutex::new(std::collections::HashMap::new()),
            packed_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            stop_tx,
            stop_rx,
            hook_mode: std::sync::Mutex::new(crate::agent::run::HookMode::Auto),
            hook_wait: std::sync::Mutex::new(None),
            gate_state: Default::default(),
            client: reqwest::Client::new(),
        });

        let handle = tokio::spawn(run(state, shared.clone()));
        // Give the loop time to connect, then stop it.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        shared.stop_run();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), handle).await;
        let snap = shared.snapshot();
        assert_eq!(snap.status, RunStatus::Stopped);
        assert_eq!(snap.stop.as_deref(), Some("aborted"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
