//! Config / profile-state / conversations route handlers.

// Rust guideline compliant 2026-07-28

use crate::engine::S;
use crate::read_json;
use crate::types::{AppSettings, EngineProfile, McpServerSpec, ProfileState, SavedProfile};
use axum::Json;
use axum::body::Body;
use axum::extract::{Request, State as AxumState};
use axum::http::StatusCode;
use serde_json::{Value, json};

/// Truncate a string to at most `max_chars` Unicode characters safely without
/// panicking on multi-byte UTF-8 character boundaries.
pub(crate) fn truncate_str(s: &str, max_chars: usize) -> &str {
    if let Some((idx, _)) = s.char_indices().nth(max_chars) {
        &s[..idx]
    } else {
        s
    }
}

pub(crate) async fn get_config(AxumState(state): AxumState<S>) -> Json<Value> {
    let mut c = state.config.read().await.clone();
    // An empty `chat_computer_use_dir` means "never customized" — not
    // "deliberately blank" (there's no UI action that clears it back to "").
    // Resolve it to the live OS temp dir on every read rather than only at
    // `AppSettings::default()` time, since a config.json saved before this
    // field existed (or saved while the toggle was off) already persists an
    // explicit "" that a load-time default can never see past.
    if c.chat_computer_use_dir.is_empty() {
        c.chat_computer_use_dir = std::env::temp_dir().to_string_lossy().into_owned();
    }
    Json(redact_config(serde_json::to_value(&c).unwrap()))
}

/// The shape a secret field takes in every client-facing response. The real
/// value is never sent back over the API; the UI echoes this mask (or "")
/// for untouched fields and set_config preserves the stored secret on seeing
/// it unchanged.
pub(crate) const SECRET_MASK: &str = "********";

/// Resolve a client-supplied secret against its stored value: an empty
/// string or the redaction mask both mean "unchanged, use what's saved" —
/// the client only ever holds [`SECRET_MASK`] for a field it didn't type
/// into, never the real value (see `redact_config`). Any other string is
/// the user's own typed override. Shared by every call site that accepts a
/// client-supplied cloud API key (`cloud_test`, the agent-run starter, the
/// `/v1/*` proxy) so a saved key can't silently be replaced by the literal
/// mask text on the wire to the real provider.
pub(crate) fn resolve_secret(raw: Option<&str>, stored: &str) -> String {
    match raw.map(str::trim) {
        Some(v) if !v.is_empty() && v != SECRET_MASK && v != "***" => v.to_string(),
        _ => stored.to_string(),
    }
}

/// Redact every secret field (`hfToken`, `apiKey`, `cloudProviderApiKey`, and
/// `mcpServers` secrets) before a config value reaches a client — see [`SECRET_MASK`].
pub(crate) fn redact_config(mut v: Value) -> Value {
    let is_set = |field: &str| {
        v.get(field)
            .and_then(|t| t.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false)
    };
    let hf_set = is_set("hfToken");
    let api_set = is_set("apiKey");
    let cloud_api_set = is_set("cloudProviderApiKey");
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "hfToken".into(),
            json!(if hf_set { SECRET_MASK } else { "" }),
        );
        obj.insert(
            "apiKey".into(),
            json!(if api_set { SECRET_MASK } else { "" }),
        );
        obj.insert(
            "cloudProviderApiKey".into(),
            json!(if cloud_api_set { SECRET_MASK } else { "" }),
        );
        if let Some(mcp_servers) = obj.get_mut("mcpServers").and_then(|m| m.as_array_mut()) {
            for server in mcp_servers {
                if let Some(sobj) = server.as_object_mut() {
                    if let Some(auth) = sobj.get("authorization").and_then(|a| a.as_str()) {
                        if !auth.is_empty() {
                            sobj.insert("authorization".into(), json!(SECRET_MASK));
                        }
                    }
                    if let Some(headers) = sobj.get_mut("headers").and_then(|h| h.as_object_mut()) {
                        for (_k, val) in headers.iter_mut() {
                            if let Some(s) = val.as_str() {
                                if !s.is_empty() {
                                    *val = json!(SECRET_MASK);
                                }
                            }
                        }
                    }
                    if let Some(env) = sobj.get_mut("env").and_then(|e| e.as_object_mut()) {
                        for (_k, val) in env.iter_mut() {
                            if let Some(s) = val.as_str() {
                                if !s.is_empty() {
                                    *val = json!(SECRET_MASK);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    v
}

pub(crate) async fn set_config(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let mut merged: AppSettings = state.config.read().await.clone();
    // Snapshot the pre-request port values: `enginePort`/`remoteAccessPort`
    // are validated against *each other* below, and doing that against the
    // in-flight `merged` fields (mutated as this function runs) means a
    // same-request swap (e.g. 8080<->1337) reads the *other* field's
    // already-updated new value on one side and its stale old value on the
    // other, so each side's collision check spuriously fires against the
    // other and the whole swap is silently dropped.
    let orig_engine_port = merged.engine_port;
    let orig_remote_access_port = merged.remote_access_port;
    // Fields whose new value failed validation (out of range, or colliding
    // with the other port) and were left at their previous stored value —
    // surfaced to the caller instead of only silently keeping the old value,
    // since a caller has no other way to tell "ignored" apart from "applied".
    let mut rejected: Vec<&'static str> = Vec::new();
    if let Some(v) = body.get("ninferPath").and_then(|v| v.as_str()) {
        merged.ninfer_path = crate::strip_extended_prefix(v).into();
    }
    if let Some(v) = body.get("modelsDir").and_then(|v| v.as_str()) {
        merged.models_dir = crate::strip_extended_prefix(v).into();
    }
    // Range-checked only here; the cross-field collision check (each new
    // port against the *other* port's final value) happens once both sides
    // have been parsed, alongside `remoteAccessPort` below — see the note
    // above `orig_engine_port`.
    let mut new_engine_port: Option<u16> = None;
    if let Some(v) = body.get("enginePort").and_then(|v| v.as_u64()) {
        if (1024..=65535).contains(&v) {
            new_engine_port = Some(v as u16);
        } else {
            rejected.push("enginePort");
        }
    }
    if let Some(v) = body.get("apiKey").and_then(|v| v.as_str()) {
        // "********" = untouched field (the UI only ever has the mask) — keep
        // the stored secret. Any other value, including "", replaces it.
        if v != SECRET_MASK && v != "***" {
            merged.api_key = v.into();
        }
    }
    if let Some(v) = body.get("hfCli").and_then(|v| v.as_str()) {
        merged.hf_cli = v.into();
    }
    if let Some(v) = body.get("hfToken").and_then(|v| v.as_str()) {
        // "********" = untouched field (the UI only ever has the mask) — keep
        // the stored secret. Any other value, including "", replaces it.
        if v != SECRET_MASK && v != "***" {
            merged.hf_token = v.into();
        }
    }
    if let Some(v) = body.get("buildCommand").and_then(|v| v.as_str()) {
        merged.build_command = v.into();
    }
    if let Some(v) = body.get("lintCommand").and_then(|v| v.as_str()) {
        merged.lint_command = v.into();
    }
    if let Some(v) = body.get("testCommand").and_then(|v| v.as_str()) {
        merged.test_command = v.into();
    }
    if let Some(v) = body.get("defaultRequestParams").and_then(|v| v.as_str()) {
        merged.default_request_params = v.into();
    }
    if let Some(v) = body.get("reasoningEffort").and_then(|v| v.as_str()) {
        merged.reasoning_effort = v.into();
    }
    if let Some(v) = body.get("coderWorkspace").and_then(|v| v.as_str()) {
        merged.coder_workspace = crate::strip_extended_prefix(v).into();
    }
    if let Some(v) = body.get("coderSandbox").and_then(|v| v.as_bool()) {
        merged.coder_sandbox = v;
    }
    if let Some(v) = body.get("sandboxBinds").and_then(|v| v.as_array()) {
        merged.sandbox_binds = v
            .iter()
            .filter_map(|x| x.as_str().map(|s| crate::strip_extended_prefix(s).to_string()))
            .collect();
    }
    if let Some(v) = body.get("coderSafeMode").and_then(|v| v.as_bool()) {
        merged.coder_safe_mode = v;
    }
    if let Some(v) = body.get("coderCommitApproval").and_then(|v| v.as_bool()) {
        merged.coder_commit_approval = v;
    }
    if let Some(v) = body.get("coderUdiffEditEnabled").and_then(|v| v.as_bool()) {
        merged.coder_udiff_edit_enabled = v;
    }
    if let Some(v) = body.get("coderRepoMapEnabled").and_then(|v| v.as_bool()) {
        merged.coder_repo_map_enabled = v;
    }
    if let Some(v) = body.get("chatAgentResearch").and_then(|v| v.as_bool()) {
        merged.chat_agent_research = v;
    }
    if let Some(v) = body.get("chatMemoryEnabled").and_then(|v| v.as_bool()) {
        merged.chat_memory_enabled = v;
    }
    if let Some(v) = body.get("chatReflectionEnabled").and_then(|v| v.as_bool()) {
        merged.chat_reflection_enabled = v;
    }
    if let Some(v) = body.get("chatDeepResearchEnabled").and_then(|v| v.as_bool()) {
        merged.chat_deep_research_enabled = v;
    }
    if let Some(v) = body.get("chatReflectionModel").and_then(|v| v.as_str()) {
        merged.chat_reflection_model = v.into();
    }
    if let Some(v) = body.get("chatBrowserTier").and_then(|v| v.as_str())
        && matches!(v, "allow" | "ask" | "deny")
    {
        merged.chat_browser_tier = v.into();
    }
    if let Some(v) = body.get("chatMemoryToolTier").and_then(|v| v.as_str())
        && matches!(v, "allow" | "ask" | "deny")
    {
        merged.chat_memory_tool_tier = v.into();
    }
    if let Some(v) = body
        .get("chatDeepResearchMaxAngles")
        .and_then(|v| v.as_u64())
        && (1..=10).contains(&v)
    {
        merged.chat_deep_research_max_angles = v as u32;
    }
    if let Some(v) = body
        .get("chatDeepResearchMaxSteps")
        .and_then(|v| v.as_u64())
        && (1..=30).contains(&v)
    {
        merged.chat_deep_research_max_steps = v as u32;
    }
    if let Some(v) = body
        .get("chatReflectionCritiqueMaxTokens")
        .and_then(|v| v.as_u64())
        && (50..=4000).contains(&v)
    {
        merged.chat_reflection_critique_max_tokens = v as u32;
    }
    if let Some(v) = body.get("remoteAccessEnabled").and_then(|v| v.as_bool()) {
        merged.remote_access_enabled = v;
    }
    let mut new_remote_access_port: Option<u16> = None;
    if let Some(v) = body.get("remoteAccessPort").and_then(|v| v.as_u64()) {
        if (1024..=65535).contains(&v) {
            new_remote_access_port = Some(v as u16);
        } else {
            rejected.push("remoteAccessPort");
        }
    }
    // Resolve both ports' *final* values together (a value the caller isn't
    // touching keeps its original) before checking them against each other,
    // so a same-request swap (e.g. 8080<->1337) is recognized as collision-
    // free instead of each side spuriously colliding with the other's
    // not-yet-applied old or new value.
    let final_engine_port = new_engine_port.unwrap_or(orig_engine_port);
    let final_remote_access_port = new_remote_access_port.unwrap_or(orig_remote_access_port);
    if final_engine_port == final_remote_access_port {
        if new_engine_port.is_some() {
            rejected.push("enginePort");
        }
        if new_remote_access_port.is_some() {
            rejected.push("remoteAccessPort");
        }
    } else {
        if let Some(p) = new_engine_port {
            merged.engine_port = p;
        }
        if let Some(p) = new_remote_access_port {
            merged.remote_access_port = p;
        }
    }
    if let Some(v) = body.get("chatComputerUseEnabled").and_then(|v| v.as_bool()) {
        merged.chat_computer_use_enabled = v;
    }
    if let Some(v) = body.get("chatComputerUseDir").and_then(|v| v.as_str()) {
        merged.chat_computer_use_dir = v.into();
    }
    if let Some(v) = body.get("chatComputerUsePerms").and_then(|v| v.as_str())
        && matches!(v, "allow" | "ask" | "deny")
    {
        merged.chat_computer_use_perms = v.into();
    }
    if let Some(v) = body.get("currencySymbol").and_then(|v| v.as_str()) {
        merged.currency_symbol = v.into();
    }
    if let Some(v) = body.get("costPerKwh").and_then(|v| v.as_f64()) {
        if v.is_finite() && (0.0..=1000.0).contains(&v) {
            merged.cost_per_kwh = v;
        } else {
            rejected.push("costPerKwh");
        }
    }
    if let Some(mcp_val) = body.get("mcpServers").and_then(|v| v.as_array()) {
        let mut new_specs = Vec::new();
        for item in mcp_val {
            if let Ok(mut spec) = serde_json::from_value::<McpServerSpec>(item.clone()) {
                if let Some(existing) = merged.mcp_servers.iter().find(|s| s.name == spec.name) {
                    if matches!(spec.authorization.as_deref(), Some(SECRET_MASK) | Some("***")) {
                        spec.authorization = existing.authorization.clone();
                    }
                    for (k, v) in &mut spec.headers {
                        if v == SECRET_MASK || v == "***" {
                            if let Some(old_v) = existing.headers.get(k) {
                                *v = old_v.clone();
                            }
                        }
                    }
                    for (k, v) in &mut spec.env {
                        if v == SECRET_MASK || v == "***" {
                            if let Some(old_v) = existing.env.get(k) {
                                *v = old_v.clone();
                            }
                        }
                    }
                }
                new_specs.push(spec);
            }
        }
        merged.mcp_servers = new_specs;
    }
    if let Some(v) = body.get("cloudProviderEnabled").and_then(|v| v.as_bool()) {
        merged.cloud_provider_enabled = v;
    }
    if let Some(v) = body.get("cloudProviderBaseUrl").and_then(|v| v.as_str()) {
        merged.cloud_provider_base_url = v.into();
    }
    if let Some(v) = body.get("cloudProviderApiKey").and_then(|v| v.as_str())
        && v != SECRET_MASK
        && v != "***"
    {
        merged.cloud_provider_api_key = v.into();
    }
    if let Some(v) = body
        .get("cloudProviderDefaultModel")
        .and_then(|v| v.as_str())
    {
        merged.cloud_provider_default_model = v.into();
    }
    if let Some(v) = body
        .get("cloudProviderPrimaryModel")
        .and_then(|v| v.as_str())
    {
        merged.cloud_provider_primary_model = v.into();
    }
    if let Some(v) = body
        .get("cloudProviderSubagentModel")
        .and_then(|v| v.as_str())
    {
        merged.cloud_provider_subagent_model = v.into();
    }
    if let Some(v) = body
        .get("cloudProviderExtraHeaders")
        .and_then(|v| v.as_str())
    {
        merged.cloud_provider_extra_headers = v.into();
    }
    if let Some(v) = body.get("cloudFallbackToLocal").and_then(|v| v.as_bool()) {
        merged.cloud_fallback_to_local = v;
    }
    if let Some(v) = body.get("cloudSmartTiering").and_then(|v| v.as_bool()) {
        merged.cloud_smart_tiering = v;
    }
    if let Some(v) = body.get("cloudPruneContext").and_then(|v| v.as_bool()) {
        merged.cloud_prune_context = v;
    }
    if let Some(v) = body.get("cloudUseLocalCompactor").and_then(|v| v.as_bool()) {
        merged.cloud_use_local_compactor = v;
    }
    if let Some(v) = body.get("cloudUseForPrimary").and_then(|v| v.as_bool()) {
        merged.cloud_use_for_primary = v;
    }
    if let Some(v) = body.get("cloudUseForSubagent").and_then(|v| v.as_bool()) {
        merged.cloud_use_for_subagent = v;
    }
    persist_config(&state, &merged).await?;
    let mut out = redact_config(serde_json::to_value(&merged).unwrap());
    if !rejected.is_empty() {
        // Additive, backward-compatible: existing callers ignoring unknown
        // response fields are unaffected. Without this, a caller has no way
        // to tell "the value you sent was applied" apart from "it was
        // silently kept at its old value because it failed validation" —
        // e.g. an out-of-range `enginePort`/`costPerKwh` or a port collision.
        if let Some(obj) = out.as_object_mut() {
            obj.insert("rejected".into(), json!(rejected));
        }
    }
    Ok(Json(out))
}

pub(crate) async fn cloud_test(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body: Value = read_json(req).await?;
    let base_url = body
        .get("baseUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("https://api.openai.com/v1");
    let api_key_raw = body.get("apiKey").and_then(|v| v.as_str());
    let api_key = resolve_secret(
        api_key_raw,
        &state.config.read().await.cloud_provider_api_key,
    );
    let extra_headers = body
        .get("extraHeaders")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let base = base_url.trim().trim_end_matches('/');
    let url = if base.ends_with("/models") {
        base.to_string()
    } else {
        format!("{base}/models")
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("failed to build HTTP client: {e}")))?;

    let mut req_builder = client.get(&url);
    if !api_key.trim().is_empty() {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", api_key.trim()));
    }
    if !extra_headers.trim().is_empty()
        && let Ok(parsed) = serde_json::from_str::<serde_json::Map<String, Value>>(extra_headers)
    {
        for (k, v) in parsed {
            if let Some(s) = v.as_str() {
                // Skip invalid header names/values instead of panicking
                // inside reqwest's `TryFrom` conversion.
                let name: Result<axum::http::HeaderName, _> = k.parse();
                let value: Result<axum::http::HeaderValue, _> = s.parse();
                if let (Ok(name), Ok(value)) = (name, value) {
                    req_builder = req_builder.header(name, value);
                }
            }
        }
    }
    let t0 = std::time::Instant::now();
    match req_builder.send().await {
        Ok(res) => {
            let latency_ms = t0.elapsed().as_millis() as u64;
            let status = res.status();
            if !status.is_success() {
                let text = res.text().await.unwrap_or_default();
                let err_msg = truncate_str(&text, 200);
                return Ok(Json(json!({
                    "ok": false,
                    "latencyMs": latency_ms,
                    "models": [],
                    "error": format!("HTTP {status}: {}", if err_msg.is_empty() { "request failed" } else { err_msg })
                })));
            }
            let data: Value = match res.json().await {
                Ok(v) => v,
                Err(e) => {
                    return Ok(Json(json!({
                        "ok": false,
                        "latencyMs": latency_ms,
                        "models": [],
                        "error": format!("response from provider was not valid JSON: {e}")
                    })));
                }
            };
            let mut models = Vec::new();
            let mut model_info = Vec::new();
            // Pricing/context-length keyed by model id, merged into the
            // stored config below so usage_stats can price cloud requests
            // later — most providers (OpenAI, Groq, DeepSeek, Together)
            // don't report this on /models, OpenRouter does
            // (`pricing.prompt`/`pricing.completion` in $/token,
            // `context_length` in tokens); parsed defensively so a provider
            // that omits or reshapes these fields just yields no entry.
            let mut pricing: std::collections::HashMap<String, crate::types::ModelPricing> =
                std::collections::HashMap::new();
            if let Some(arr) = data.get("data").and_then(|v| v.as_array()) {
                for item in arr {
                    let Some(id) = item
                        .as_str()
                        .or_else(|| item.get("id").and_then(|v| v.as_str()))
                        .filter(|id| !id.is_empty())
                    else {
                        continue;
                    };
                    models.push(id.to_string());
                    let context_length = item.get("context_length").and_then(Value::as_u64);
                    let parse_price = |v: Option<&Value>| -> Option<f64> {
                        v.and_then(|v| {
                            v.as_str()
                                .and_then(|s| s.parse::<f64>().ok())
                                .or_else(|| v.as_f64())
                        })
                    };
                    let prompt_price =
                        parse_price(item.get("pricing").and_then(|p| p.get("prompt")));
                    let completion_price =
                        parse_price(item.get("pricing").and_then(|p| p.get("completion")));
                    if prompt_price.is_some()
                        || completion_price.is_some()
                        || context_length.is_some()
                    {
                        model_info.push(json!({
                            "id": id,
                            "contextLength": context_length,
                            "pricePromptPerM": prompt_price.map(|p| p * 1_000_000.0),
                            "priceCompletionPerM": completion_price.map(|p| p * 1_000_000.0),
                        }));
                    }
                    if prompt_price.is_some() || completion_price.is_some() {
                        pricing.insert(
                            id.to_string(),
                            crate::types::ModelPricing {
                                prompt_per_token: prompt_price.unwrap_or(0.0),
                                completion_per_token: completion_price.unwrap_or(0.0),
                                context_length,
                            },
                        );
                    }
                }
            }
            models.sort();
            if !pricing.is_empty() {
                let mut merged = state.config.read().await.clone();
                merged.cloud_model_pricing.extend(pricing);
                if let Err(e) = persist_config(&state, &merged).await {
                    tracing::event!(
                        name: "cloud_test.pricing_persist.failed",
                        tracing::Level::WARN,
                        error = %e.1,
                        "failed to persist cloud model pricing",
                    );
                }
            }
            Ok(Json(json!({
                "ok": true,
                "latencyMs": latency_ms,
                "models": models,
                "modelInfo": model_info,
            })))
        }
        Err(e) => {
            let latency_ms = t0.elapsed().as_millis() as u64;
            Ok(Json(json!({
                "ok": false,
                "latencyMs": latency_ms,
                "models": [],
                "error": e.to_string()
            })))
        }
    }
}

/// Write `cfg` to `<data>/config.json` and install it as the live config.
/// Shared by [`set_config`] and any other handler that mutates settings with
/// a side effect beyond a plain field edit (e.g. `remote::start`/`stop`).
pub(crate) async fn persist_config(
    state: &S,
    cfg: &AppSettings,
) -> Result<(), (StatusCode, String)> {
    let path = state.data_dir.join("config.json");
    if let Err(e) = tokio::fs::create_dir_all(&state.data_dir).await {
        tracing::event!(
            name: "config.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            data_dir = ?state.data_dir,
            "could not create data dir {{data_dir}}: {{error}}",
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not create data dir: {e}"),
        ));
    }
    if let Err(e) =
        crate::atomic_write_secret(&path, serde_json::to_string_pretty(cfg).unwrap()).await
    {
        tracing::event!(
            name: "config.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            path = ?path,
            "could not write config to {{path}}: {{error}}",
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not save config: {e}"),
        ));
    }
    *state.config.write().await = cfg.clone();
    Ok(())
}

// ---------------------------------------------------------------------------
// Per-user profile state (engine profile + artifact + saved named profiles).
// Persisted to <data>/profile.json so it survives a restart; mirrors the web
// app's former browser-localStorage blob.
// ---------------------------------------------------------------------------
pub(crate) async fn profile_state_get(
    AxumState(state): AxumState<S>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let p = state.data_dir.join("profile.json");
    match tokio::fs::read_to_string(&p).await {
        Ok(raw) => match serde_json::from_str::<ProfileState>(&raw) {
            Ok(ps) => Ok(Json(serde_json::to_value(&ps).unwrap_or_else(|_| json!({})))),
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("corrupt profile.json file: {e}"),
            )),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(Json(json!({ "profile": null, "artifact": "", "saved": [] })))
        }
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not read profile.json: {e}"),
        )),
    }
}

pub(crate) async fn profile_state_set(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body = read_json(req).await?;
    let p = state.data_dir.join("profile.json");
    let mut current: ProfileState = match tokio::fs::read_to_string(&p).await {
        Ok(raw) => serde_json::from_str::<ProfileState>(&raw).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("corrupt profile.json file: {e}"),
            )
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ProfileState::default(),
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not read profile.json: {e}"),
            ));
        }
    };
    if let Some(v) = body.get("profile")
        && let Ok(p) = serde_json::from_value::<EngineProfile>(v.clone())
    {
        current.profile = Some(p);
    }
    if let Some(v) = body.get("artifact")
        && let Some(s) = v.as_str()
    {
        current.artifact = s.to_string();
    }
    if let Some(v) = body.get("saved")
        && let Ok(s) = serde_json::from_value::<Vec<SavedProfile>>(v.clone())
    {
        current.saved = s;
    }
    if let Err(e) = tokio::fs::create_dir_all(&state.data_dir).await {
        tracing::event!(
            name: "profile_state.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            data_dir = ?state.data_dir,
            "could not create data dir {{data_dir}}: {{error}}",
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not create data dir: {e}"),
        ));
    }
    if let Err(e) = crate::atomic_write(&p, serde_json::to_string_pretty(&current).unwrap()).await {
        tracing::event!(
            name: "profile_state.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            path = ?p,
            "could not write profile state to {{path}}: {{error}}",
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not save profile state: {e}"),
        ));
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Conversations + chat params. Persisted to <data>/chats.json (web-only shapes
// stored as raw JSON) so chat history survives a fresh install / AppImage run —
// previously it lived in the webview localStorage, which is origin-bound.
// ---------------------------------------------------------------------------
pub(crate) async fn conversations_get(
    AxumState(state): AxumState<S>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let p = state.data_dir.join("chats.json");
    match tokio::fs::read_to_string(&p).await {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(v) => Ok(Json(v)),
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("corrupt chats.json file: {e}"),
            )),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(Json(json!({ "conversations": [], "params": null, "presets": [] })))
        }
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not read chats.json: {e}"),
        )),
    }
}

pub(crate) async fn conversations_set(
    AxumState(state): AxumState<S>,
    req: Request<Body>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let body = read_json(req).await?;
    let p = state.data_dir.join("chats.json");
    let mut current: Value = match tokio::fs::read_to_string(&p).await {
        Ok(raw) => serde_json::from_str::<Value>(&raw).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("corrupt chats.json file: {e}"),
            )
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not read chats.json: {e}"),
            ));
        }
    };
    if let Some(v) = body.get("conversations")
        && v.is_array()
    {
        current["conversations"] = v.clone();
    }
    if body.get("params").is_some() {
        current["params"] = body["params"].clone();
    }
    if let Some(v) = body.get("presets")
        && v.is_array()
    {
        current["presets"] = v.clone();
    }
    if let Err(e) = tokio::fs::create_dir_all(&state.data_dir).await {
        tracing::event!(
            name: "conversations.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            data_dir = ?state.data_dir,
            "could not create data dir {{data_dir}}: {{error}}",
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not create data dir: {e}"),
        ));
    }
    if let Err(e) = crate::atomic_write(&p, serde_json::to_string_pretty(&current).unwrap()).await {
        tracing::event!(
            name: "conversations.persist.failed",
            tracing::Level::ERROR,
            error = %e,
            path = ?p,
            "could not write conversations to {{path}}: {{error}}",
        );
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("could not save conversations: {e}"),
        ));
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{State, now_ms};
    use std::sync::Arc;

    fn test_state() -> S {
        let dir = std::env::temp_dir().join(format!("ninfer_config_test_{}", now_ms()));
        Arc::new(State::new(dir.clone(), dir, None))
    }

    #[test]
    fn test_truncate_str_utf8() {
        let ascii = "hello world";
        assert_eq!(truncate_str(ascii, 5), "hello");

        let unicode = "données_personnelles_fr";
        assert_eq!(truncate_str(unicode, 7), "données");

        let short = "abc";
        assert_eq!(truncate_str(short, 10), "abc");
    }

    #[test]
    fn test_resolve_secret_and_redact_config() {
        assert_eq!(resolve_secret(Some("********"), "stored_key"), "stored_key");
        assert_eq!(resolve_secret(Some("***"), "stored_key"), "stored_key");
        assert_eq!(resolve_secret(Some(""), "stored_key"), "stored_key");
        assert_eq!(resolve_secret(Some("new_key"), "stored_key"), "new_key");

        let cfg = json!({
            "apiKey": "real_api_key",
            "hfToken": "real_hf_token",
            "cloudProviderApiKey": "real_cloud_key",
            "mcpServers": [
                {
                    "name": "srv1",
                    "authorization": "Bearer secret",
                    "headers": { "X-Key": "secret_header" },
                    "env": { "FOO": "secret_env" }
                }
            ]
        });
        let redacted = redact_config(cfg);
        assert_eq!(redacted["apiKey"], SECRET_MASK);
        assert_eq!(redacted["hfToken"], SECRET_MASK);
        assert_eq!(redacted["cloudProviderApiKey"], SECRET_MASK);
        assert_eq!(redacted["mcpServers"][0]["authorization"], SECRET_MASK);
        assert_eq!(redacted["mcpServers"][0]["headers"]["X-Key"], SECRET_MASK);
        assert_eq!(redacted["mcpServers"][0]["env"]["FOO"], SECRET_MASK);
    }

    #[tokio::test]
    async fn test_conversations_corrupt_file_handling() {
        let state = test_state();
        std::fs::create_dir_all(&state.data_dir).unwrap();

        // 1. Missing file returns default empty conversations
        let get_res = conversations_get(AxumState(state.clone())).await.unwrap();
        assert_eq!(get_res.0["conversations"], json!([]));

        // 2. Corrupt file returns 500 error instead of silently returning []
        let chats_file = state.data_dir.join("chats.json");
        std::fs::write(&chats_file, "{ invalid json ...").unwrap();

        let get_err = conversations_get(AxumState(state.clone())).await;
        assert!(get_err.is_err());
        assert_eq!(get_err.unwrap_err().0, StatusCode::INTERNAL_SERVER_ERROR);

        // 3. conversations_set on corrupt file returns 500 without overwriting
        let req = Request::builder()
            .body(Body::from(json!({ "conversations": [{"id": "1"}] }).to_string()))
            .unwrap();
        let set_err = conversations_set(AxumState(state.clone()), req).await;
        assert!(set_err.is_err());
        assert_eq!(set_err.unwrap_err().0, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn test_profile_state_corrupt_file_handling() {
        let state = test_state();
        std::fs::create_dir_all(&state.data_dir).unwrap();

        // 1. Missing file returns default empty profile state
        let get_res = profile_state_get(AxumState(state.clone())).await.unwrap();
        assert_eq!(get_res.0["artifact"], "");

        // 2. Corrupt file returns 500 error
        let profile_file = state.data_dir.join("profile.json");
        std::fs::write(&profile_file, "corrupt content").unwrap();

        let get_err = profile_state_get(AxumState(state.clone())).await;
        assert!(get_err.is_err());
        assert_eq!(get_err.unwrap_err().0, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn test_set_config_port_swap_and_rejection_reporting() {
        let state = test_state();
        std::fs::create_dir_all(&state.data_dir).unwrap();
        // Defaults: engine_port=8080, remote_access_port=1337.
        assert_eq!(state.config.read().await.engine_port, 8080);
        assert_eq!(state.config.read().await.remote_access_port, 1337);

        // Swapping both ports in one request must succeed: neither side's
        // collision check should fire against the other's stale/in-flight
        // value mid-request.
        let req = Request::builder()
            .body(Body::from(json!({ "enginePort": 1337, "remoteAccessPort": 8080 }).to_string()))
            .unwrap();
        let res = set_config(AxumState(state.clone()), req).await.unwrap();
        assert!(res.0.get("rejected").is_none(), "a real swap must not be rejected: {:?}", res.0.get("rejected"));
        assert_eq!(state.config.read().await.engine_port, 1337);
        assert_eq!(state.config.read().await.remote_access_port, 8080);

        // A genuine collision (engine_port set to the *unchanged* remote
        // access port) is rejected, reported, and leaves the stored value
        // untouched — not just silently kept with no way to tell.
        let req = Request::builder()
            .body(Body::from(json!({ "enginePort": 8080 }).to_string()))
            .unwrap();
        let res = set_config(AxumState(state.clone()), req).await.unwrap();
        assert_eq!(res.0["rejected"], json!(["enginePort"]));
        assert_eq!(state.config.read().await.engine_port, 1337, "colliding value must not be applied");

        // Out-of-range costPerKwh is likewise reported, not silently dropped.
        let req = Request::builder()
            .body(Body::from(json!({ "costPerKwh": -5.0 }).to_string()))
            .unwrap();
        let res = set_config(AxumState(state.clone()), req).await.unwrap();
        assert_eq!(res.0["rejected"], json!(["costPerKwh"]));
    }
}

