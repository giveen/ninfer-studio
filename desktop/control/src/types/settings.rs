//! Studio settings + engine profiles (persisted config surface).
use serde::{Deserialize, Serialize};
use std::fmt;

/// Redact secrets while still showing whether one is set, without leaking the
/// value itself into a log line or panic message.
fn redacted(s: &str) -> &'static str {
    if s.is_empty() { "" } else { "***" }
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    /// Root of the NInfer checkout/build. The ninfer-serve binary
    /// (`build/apps/ninfer-serve`), the ninfer CLI, and the git source for
    /// pull/build are all derived from this single path.
    pub ninfer_path: String,
    pub models_dir: String,
    pub engine_port: u16,
    pub api_key: String,
    pub hf_cli: String,
    /// Optional HuggingFace token, passed to `hf download` as HF_TOKEN to
    /// unlock faster (non-rate-limited) downloads. Redacted in API responses —
    /// the UI only ever sees the mask or "".
    pub hf_token: String,
    pub build_command: String,
    /// Command run in the Coder workspace after agent edits (lint/typecheck).
    /// Empty = unset. Falls back to `build_command` when empty.
    pub lint_command: String,
    /// Command run in the Coder workspace after the lint check passes (tests).
    /// Empty = unset (no test step).
    pub test_command: String,
    /// JSON object merged (as defaults) into every proxied /v1 request body, so
    /// external clients (e.g. other coding harnesses) inherit these params without
    /// configuring each tool. Client-supplied fields win over these defaults.
    pub default_request_params: String,
    /// Global default reasoning effort injected into the top-level
    /// `reasoning_effort` field for every proxied request (client fields
    /// win). The dedicated UI control overrides the generic default for
    /// this single key. Empty = unset.
    pub reasoning_effort: String,
    /// Coding harness: the directory the "Code" mode is allowed to read/write/execute
    /// within. Every coder filesystem tool is confined to this root (path traversal
    /// rejected). Empty => no workspace configured. Serializes as `coderWorkspace`.
    pub coder_workspace: String,
    /// Coding harness: wrap the agent's shell in bubblewrap (bwrap) so it can
    /// write only inside the workspace (rest of the host read-only). Mirrors the
    /// sidecar's `coderSandbox`. Ignored when bwrap is not installed (exec then
    /// runs unsandboxed, like the sidecar). Defaults on: an agent running
    /// arbitrary shell commands should be contained unless a user opts out.
    /// Serializes as `coderSandbox`.
    pub coder_sandbox: bool,
    /// Extra read-write bind mounts passed to bwrap alongside the workspace
    /// (e.g. shared model dirs a build step needs to write to). Serializes as
    /// `sandboxBinds`.
    pub sandbox_binds: Vec<String>,
    /// Coding harness: refuse a fixed set of clearly destructive shell
    /// command patterns before spawning (not a security boundary — see
    /// SECURITY.md). Serializes as `coderSafeMode`.
    pub coder_safe_mode: bool,
    /// Coding harness: require explicit human sign-off on the working-tree
    /// diff before the agent may commit. Serializes as `coderCommitApproval`.
    pub coder_commit_approval: bool,
    #[serde(default = "default_true")]
    pub coder_udiff_edit_enabled: bool,
    #[serde(default = "default_true")]
    pub coder_repo_map_enabled: bool,
    /// Chat's Agent Mode tier: off (web_fetch/web_search only, the original
    /// default) or on (adds the workspace-independent `browser` tool).
    /// Serializes as `chatAgentResearch`.
    pub chat_agent_research: bool,
    /// Persistent cross-conversation Chat memory (global bank + learnings,
    /// distinct from Coder's per-workspace one — see `chat::memory`).
    /// Serializes as `chatMemoryEnabled`.
    pub chat_memory_enabled: bool,
    /// Optional self-review pass on Chat's final replies (Generate → Reflect
    /// → Refine, bounded to one retry). Serializes as `chatReflectionEnabled`.
    pub chat_reflection_enabled: bool,
    /// Concurrency-gated parallel research fan-out for Chat (only usable
    /// when the running engine's maxConcurrency > 1). Serializes as
    /// `chatDeepResearchEnabled`.
    pub chat_deep_research_enabled: bool,
    /// Optional model id the Reflection pass critiques/regenerates with,
    /// instead of the conversation's own model — lets a stronger model
    /// review a weaker one's replies, avoiding the same-model
    /// self-agreement-bias risk of a model critiquing its own output.
    /// Empty = use the active chat model (today's behavior). Mirrors
    /// Coder's `criticModel` param. Serializes as `chatReflectionModel`.
    pub chat_reflection_model: String,
    /// Permission tier ("allow"/"ask"/"deny") for Chat's `browser` tool —
    /// mirrors Coder's per-tool `PermTier`, simplified to no denyPaths/
    /// server-side enforcement since Chat's tools are workspace-independent.
    /// Serializes as `chatBrowserTier`.
    pub chat_browser_tier: String,
    /// Permission tier for Chat's `memory_update` tool. Serializes as
    /// `chatMemoryToolTier`.
    pub chat_memory_tool_tier: String,
    /// Cap on how many parallel research angles Deep Research fans out to
    /// (still bounded by the running engine's maxConcurrency at call time).
    /// Serializes as `chatDeepResearchMaxAngles`.
    pub chat_deep_research_max_angles: u32,
    /// Tool-call step budget for each individual Deep Research angle.
    /// Serializes as `chatDeepResearchMaxSteps`.
    pub chat_deep_research_max_steps: u32,
    /// Token budget for the Reflection pass's critique call (the verdict/
    /// critique text itself, not the regenerated reply). Serializes as
    /// `chatReflectionCritiqueMaxTokens`.
    pub chat_reflection_critique_max_tokens: u32,
    /// Remote Access: serve the full app (SPA + API) on `0.0.0.0` instead of
    /// loopback-only, so another device on the network can open it. See
    /// SECURITY.md — there is deliberately NO authentication on this listener;
    /// anyone who can reach the port gets full agent control (shell, file
    /// writes, git). Persisted so it resumes across a restart if left on.
    /// Serializes as `remoteAccessEnabled`.
    pub remote_access_enabled: bool,
    /// Port the remote listener binds on `0.0.0.0` when enabled. Serializes
    /// as `remoteAccessPort`.
    pub remote_access_port: u16,
    /// Chat's Computer Use: when on, adds the same file/shell/search/basic-git
    /// tools the Coding harness exposes (read/write/edit/apply_patch/bash/
    /// bash_poll/grep/glob/git_commit/git_diff), scoped to `chat_computer_use_dir`
    /// rather than Coder's workspace — for general "use my computer" tasks, not
    /// the coding-specific harness features (subagents, todo tracking, etc.)
    /// that stay Coder-exclusive. Serializes as `chatComputerUseEnabled`.
    pub chat_computer_use_enabled: bool,
    /// Directory Chat's Computer Use tools are confined to (independent of
    /// Coder's workspace — same path-traversal confinement via `within_ws`).
    /// Defaults to the OS temp dir (see `Default for AppSettings`) so the
    /// feature works the instant it's switched on; the model can redirect it
    /// elsewhere mid-conversation with the `set_directory` tool, or the user
    /// can point it somewhere permanent in Settings. Empty => inert. Serializes
    /// as `chatComputerUseDir`.
    pub chat_computer_use_dir: String,
    /// Chat's Computer Use tool tiers + denied path prefixes, JSON-serialized
    /// (`{"tools":{...},"denyPaths":[...]}`, same shape as Coder's `PermConfig`)
    /// rather than individual typed fields since the tool set is open-ended.
    /// Mirrored to the control plane's scoped perms map (keyed by
    /// `chat_computer_use_dir`) exactly like Coder mirrors its own — see
    /// `coder::common::enforce_perm`. Serializes as `chatComputerUsePerms`.
    pub chat_computer_use_perms: String,
    /// Currency symbol/code prefixed onto estimated cost figures in the
    /// Usage tab (e.g. "$", "€", "£") — free text, no locale or
    /// exchange-rate handling. Serializes as `currencySymbol`.
    pub currency_symbol: String,
    /// User-entered electricity price per kWh, in `currency_symbol` units.
    /// `0.0` means "not configured" — the Usage tab hides cost figures
    /// rather than showing a misleading $0. Serializes as `costPerKwh`.
    pub cost_per_kwh: f64,
    /// Configured MCP (Model Context Protocol) servers — external tool
    /// servers the control plane talks to (stdio child process or
    /// streamable-HTTP endpoint). Their tools are exposed to the agent loop
    /// as `mcp__<server>__<tool>` and pass through the same allow/ask/deny
    /// permission tiers as the built-in coder tools (see `mcp.rs`).
    /// Serializes as `mcpServers`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<McpServerSpec>,
    /// Whether the external cloud AI provider is enabled in the UI.
    #[serde(default)]
    pub cloud_provider_enabled: bool,
    /// Base URL for the cloud provider.
    #[serde(default)]
    pub cloud_provider_base_url: String,
    /// API Key for the cloud provider.
    #[serde(default)]
    pub cloud_provider_api_key: String,
    /// Default cloud model selected by the user.
    #[serde(default)]
    pub cloud_provider_default_model: String,
    /// Default model for primary agent turns.
    #[serde(default)]
    pub cloud_provider_primary_model: String,
    /// Default model for subagent worker turns.
    #[serde(default)]
    pub cloud_provider_subagent_model: String,
    /// JSON string of extra headers (e.g. for OpenRouter or custom proxies).
    #[serde(default)]
    pub cloud_provider_extra_headers: String,
    /// Fallback to local engine on cloud rate limits (429) or server errors (5xx).
    #[serde(default)]
    pub cloud_fallback_to_local: bool,
    /// Smart task-based model tiering: route light utility tasks to local/fast subagent models.
    #[serde(default)]
    pub cloud_smart_tiering: bool,
    /// Prune bloated historical tool outputs before shipping prompts to cloud APIs to save tokens.
    #[serde(default = "default_true")]
    pub cloud_prune_context: bool,
    /// Use local NInfer model to summarize long conversation history before sending slimmed context to cloud models.
    #[serde(default = "default_true")]
    pub cloud_use_local_compactor: bool,
    /// Automatically use cloud provider for primary main agent turns.
    #[serde(default)]
    pub cloud_use_for_primary: bool,
    /// Automatically use cloud provider for subagent worker turns.
    #[serde(default)]
    pub cloud_use_for_subagent: bool,
    /// Per-model USD pricing + context length, discovered from a cloud
    /// provider's `/models` response (OpenRouter reports `pricing.prompt`/
    /// `pricing.completion` in $/token and `context_length` per model) and
    /// refreshed whenever "Retrieve Models"/"Test Connection" succeeds.
    /// Keyed by the exact model id string, matching what's sent as the
    /// request's `model` field and logged in usage events — so
    /// `usage::usage_stats` can price a cloud request without guessing.
    /// Providers that don't report pricing (Groq, DeepSeek, Together, plain
    /// OpenAI) simply never get an entry; their usage stays priced as
    /// unknown rather than 0.
    #[serde(default)]
    pub cloud_model_pricing: std::collections::HashMap<String, ModelPricing>,
}

/// One model's discovered cost + context window (see `AppSettings::cloud_model_pricing`).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelPricing {
    /// USD per prompt (input) token.
    pub prompt_per_token: f64,
    /// USD per completion (output) token.
    pub completion_per_token: f64,
    /// Context window in tokens, when the provider reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
}

/// One configured MCP server. Exactly one of `command` (stdio transport —
/// spawn a local process speaking newline-delimited JSON-RPC on stdio) or
/// `url` (streamable-HTTP transport — the current MCP spec, JSON or
/// SSE-framed responses) must be set. Mirrors the shape opencode/continue/
/// roo use in their MCP config files.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpServerSpec {
    /// Stable id (sanitized to `[A-Za-z0-9-]`); namespaced into tool names as
    /// `mcp__<name>__<tool>`.
    pub name: String,
    /// stdio: program to spawn (resolved via PATH).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// stdio: argv after the program.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// stdio: extra environment variables (on top of the inherited env).
    #[serde(skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub env: std::collections::HashMap<String, String>,
    /// stdio: working directory for the child process.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// http: the MCP endpoint (e.g. `https://mcp.example.com/mcp`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// http: extra headers sent with every request (e.g. `{"X-Api-Key": "…"}`).
    #[serde(skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub headers: std::collections::HashMap<String, String>,
    /// http: full `Authorization` header value. Secret — redacted in API
    /// responses (the UI only ever sees the mask).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorization: Option<String>,
}

impl fmt::Debug for McpServerSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let env_masked: std::collections::BTreeMap<_, _> = self
            .env
            .iter()
            .map(|(k, v)| (k.clone(), if v.is_empty() { "" } else { "***" }))
            .collect();
        let headers_masked: std::collections::BTreeMap<_, _> = self
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), if v.is_empty() { "" } else { "***" }))
            .collect();
        f.debug_struct("McpServerSpec")
            .field("name", &self.name)
            .field("command", &self.command)
            .field("args", &self.args)
            .field("env", &env_masked)
            .field("cwd", &self.cwd)
            .field("url", &self.url)
            .field("headers", &headers_masked)
            .field(
                "authorization",
                &self.authorization.as_ref().map(|s| redacted(s)),
            )
            .finish()
    }
}

impl McpServerSpec {
    /// Which transport this spec selects, or `None` when it's unusable as
    /// written (both or neither of `command`/`url` set — the upsert endpoint
    /// rejects those, this is the load-time fallback for hand-edited configs).
    pub(crate) fn transport(&self) -> Option<&str> {
        let cmd = self.command.as_deref().unwrap_or("").trim();
        let url = self.url.as_deref().unwrap_or("").trim();
        match (!cmd.is_empty(), !url.is_empty()) {
            (true, false) => Some("stdio"),
            (false, true) => Some("http"),
            _ => None,
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            // No hardcoded paths: a distributed build must not ship a developer's
            // machine layout. The user configures these in Settings; an empty value
            // is treated as "not configured" so we can surface a clear error early
            // instead of spawning a binary that does not exist on their machine.
            ninfer_path: String::new(),
            models_dir: String::new(),
            engine_port: 8080,
            api_key: String::new(),
            hf_cli: "hf".into(),
            hf_token: String::new(),
            build_command: "cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(nproc)".into(),
            lint_command: String::new(),
            test_command: String::new(),
            default_request_params: String::new(),
            reasoning_effort: String::new(),
            coder_sandbox: true,
            sandbox_binds: Vec::new(),
            coder_workspace: String::new(),
            coder_safe_mode: true,
            coder_commit_approval: false,
            coder_udiff_edit_enabled: true,
            coder_repo_map_enabled: true,
            chat_agent_research: false,
            chat_memory_enabled: false,
            chat_reflection_enabled: false,
            chat_deep_research_enabled: false,
            chat_reflection_model: String::new(),
            chat_browser_tier: "allow".into(),
            chat_memory_tool_tier: "allow".into(),
            chat_deep_research_max_angles: 3,
            chat_deep_research_max_steps: 5,
            chat_reflection_critique_max_tokens: 400,
            chat_computer_use_enabled: false,
            // Unlike coder_workspace (a project, deliberately left unconfigured
            // until the user points it somewhere), Computer Use is meant to work
            // the moment it's switched on — the OS temp dir is a sensible,
            // always-present default drop point (/tmp on Linux/macOS, %TEMP% on
            // Windows) that the model can redirect elsewhere with `set_directory`
            // when the user asks (e.g. "do that in my home folder instead").
            chat_computer_use_dir: std::env::temp_dir().to_string_lossy().into_owned(),
            chat_computer_use_perms: String::new(),
            remote_access_enabled: false,
            remote_access_port: 1337,
            currency_symbol: "$".into(),
            cost_per_kwh: 0.0,
            mcp_servers: Vec::new(),
            cloud_provider_enabled: false,
            cloud_provider_base_url: String::new(),
            cloud_provider_api_key: String::new(),
            cloud_provider_default_model: String::new(),
            cloud_provider_primary_model: String::new(),
            cloud_provider_subagent_model: String::new(),
            cloud_provider_extra_headers: String::new(),
            cloud_fallback_to_local: false,
            cloud_smart_tiering: false,
            cloud_prune_context: true,
            cloud_use_local_compactor: true,
            cloud_use_for_primary: false,
            cloud_use_for_subagent: false,
            cloud_model_pricing: std::collections::HashMap::new(),
        }
    }
}

impl fmt::Debug for AppSettings {
    /// Redacts secret keys — the API layer already masks them before
    /// they ever reach a client (see `redact_config` in lib.rs); this impl
    /// keeps that guarantee even if the struct is ever printed directly (a
    /// stray log line, a panic message, ...).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AppSettings")
            .field("ninfer_path", &self.ninfer_path)
            .field("models_dir", &self.models_dir)
            .field("engine_port", &self.engine_port)
            .field("api_key", &redacted(&self.api_key))
            .field("hf_cli", &self.hf_cli)
            .field("hf_token", &redacted(&self.hf_token))
            .field("build_command", &self.build_command)
            .field("lint_command", &self.lint_command)
            .field("test_command", &self.test_command)
            .field("default_request_params", &self.default_request_params)
            .field("reasoning_effort", &self.reasoning_effort)
            .field("coder_workspace", &self.coder_workspace)
            .field("coder_sandbox", &self.coder_sandbox)
            .field("sandbox_binds", &self.sandbox_binds)
            .field("coder_safe_mode", &self.coder_safe_mode)
            .field("coder_commit_approval", &self.coder_commit_approval)
            .field("coder_udiff_edit_enabled", &self.coder_udiff_edit_enabled)
            .field("coder_repo_map_enabled", &self.coder_repo_map_enabled)
            .field("chat_agent_research", &self.chat_agent_research)
            .field("chat_memory_enabled", &self.chat_memory_enabled)
            .field("chat_reflection_enabled", &self.chat_reflection_enabled)
            .field("chat_deep_research_enabled", &self.chat_deep_research_enabled)
            .field("chat_reflection_model", &self.chat_reflection_model)
            .field("chat_browser_tier", &self.chat_browser_tier)
            .field("chat_memory_tool_tier", &self.chat_memory_tool_tier)
            .field(
                "chat_deep_research_max_angles",
                &self.chat_deep_research_max_angles,
            )
            .field(
                "chat_deep_research_max_steps",
                &self.chat_deep_research_max_steps,
            )
            .field(
                "chat_reflection_critique_max_tokens",
                &self.chat_reflection_critique_max_tokens,
            )
            .field("remote_access_enabled", &self.remote_access_enabled)
            .field("remote_access_port", &self.remote_access_port)
            .field("chat_computer_use_enabled", &self.chat_computer_use_enabled)
            .field("chat_computer_use_dir", &self.chat_computer_use_dir)
            .field("chat_computer_use_perms", &self.chat_computer_use_perms)
            .field("currency_symbol", &self.currency_symbol)
            .field("cost_per_kwh", &self.cost_per_kwh)
            .field("mcp_servers", &self.mcp_servers)
            .field("cloud_provider_enabled", &self.cloud_provider_enabled)
            .field("cloud_provider_base_url", &self.cloud_provider_base_url)
            .field(
                "cloud_provider_api_key",
                &redacted(&self.cloud_provider_api_key),
            )
            .field(
                "cloud_provider_default_model",
                &self.cloud_provider_default_model,
            )
            .field(
                "cloud_provider_primary_model",
                &self.cloud_provider_primary_model,
            )
            .field(
                "cloud_provider_subagent_model",
                &self.cloud_provider_subagent_model,
            )
            .field(
                "cloud_provider_extra_headers",
                &self.cloud_provider_extra_headers,
            )
            .field("cloud_fallback_to_local", &self.cloud_fallback_to_local)
            .field("cloud_smart_tiering", &self.cloud_smart_tiering)
            .field("cloud_prune_context", &self.cloud_prune_context)
            .field("cloud_use_local_compactor", &self.cloud_use_local_compactor)
            .field("cloud_use_for_primary", &self.cloud_use_for_primary)
            .field("cloud_use_for_subagent", &self.cloud_use_for_subagent)
            .field("cloud_model_pricing", &self.cloud_model_pricing)
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Engine profile — one optional entry per ninfer-serve option.
// `None` ⇒ flag omitted ⇒ engine executable default.
// ---------------------------------------------------------------------------
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EngineProfile {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub api_key: Option<String>,
    pub model_id: Option<String>,
    pub chat_template: Option<String>,

    // context & memory
    pub max_context: Option<u64>,
    /// number or "auto"
    #[serde(with = "opt_number_or_auto")]
    pub kv_capacity: Option<NumberOrAuto>,
    pub prefill_chunk: Option<u64>,
    pub default_max_tokens: Option<u64>,
    pub default_thinking_budget: Option<u64>,
    pub device: Option<u32>,

    // scheduling
    pub max_concurrency: Option<u8>,
    pub max_pending_requests: Option<u64>,
    pub pending_timeout_ms: Option<u64>,
    pub log_stats_interval_ms: Option<u64>,

    // kv cache
    pub kv_dtype: Option<String>,
    pub no_prefix_reuse: Option<bool>,
    pub device_state_slots: Option<u64>,
    pub host_state_slots: Option<u64>,
    pub host_kv_mib: Option<u64>,
    pub max_private_continuations: Option<u64>,
    pub max_shared_prefixes: Option<u64>,
    pub max_long_anchors_per_continuation: Option<u64>,

    // speculative decoding
    pub spec: Option<String>,
    pub draft_tokens: Option<u8>,
    pub lm_head_draft: Option<bool>,

    // vision & media
    pub vision: Option<bool>,
    pub media_cache_mib: Option<u64>,
    pub media_live_mib: Option<u64>,
    pub media_preprocess_threads: Option<u32>,
    pub max_request_mib: Option<u64>,

    // sampling defaults
    pub no_thinking: Option<bool>,
    pub preserve_thinking: Option<bool>,
    pub greedy: Option<bool>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<u32>,
    pub min_p: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub seed: Option<u64>,

    // logging & misc
    pub log_level: Option<String>,
    pub request_log_jsonl: Option<String>,
    pub response_store_max_records: Option<u64>,
    pub response_store_max_mib: Option<u64>,
    pub context_cost_presets: Option<String>,
    pub cors: Option<bool>,
    pub no_cuda_graph: Option<bool>,
}

impl fmt::Debug for EngineProfile {
    /// Redacts `api_key` for the same reason as [`AppSettings`]'s manual impl.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EngineProfile")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("api_key", &self.api_key.as_ref().map(|_| "***"))
            .field("model_id", &self.model_id)
            .field("chat_template", &self.chat_template)
            .field("max_context", &self.max_context)
            .field("kv_capacity", &self.kv_capacity)
            .field("prefill_chunk", &self.prefill_chunk)
            .field("default_max_tokens", &self.default_max_tokens)
            .field("default_thinking_budget", &self.default_thinking_budget)
            .field("device", &self.device)
            .field("max_concurrency", &self.max_concurrency)
            .field("max_pending_requests", &self.max_pending_requests)
            .field("pending_timeout_ms", &self.pending_timeout_ms)
            .field("log_stats_interval_ms", &self.log_stats_interval_ms)
            .field("kv_dtype", &self.kv_dtype)
            .field("no_prefix_reuse", &self.no_prefix_reuse)
            .field("device_state_slots", &self.device_state_slots)
            .field("host_state_slots", &self.host_state_slots)
            .field("host_kv_mib", &self.host_kv_mib)
            .field("max_private_continuations", &self.max_private_continuations)
            .field("max_shared_prefixes", &self.max_shared_prefixes)
            .field(
                "max_long_anchors_per_continuation",
                &self.max_long_anchors_per_continuation,
            )
            .field("spec", &self.spec)
            .field("draft_tokens", &self.draft_tokens)
            .field("lm_head_draft", &self.lm_head_draft)
            .field("vision", &self.vision)
            .field("media_cache_mib", &self.media_cache_mib)
            .field("media_live_mib", &self.media_live_mib)
            .field("media_preprocess_threads", &self.media_preprocess_threads)
            .field("max_request_mib", &self.max_request_mib)
            .field("no_thinking", &self.no_thinking)
            .field("preserve_thinking", &self.preserve_thinking)
            .field("greedy", &self.greedy)
            .field("temperature", &self.temperature)
            .field("top_p", &self.top_p)
            .field("top_k", &self.top_k)
            .field("min_p", &self.min_p)
            .field("presence_penalty", &self.presence_penalty)
            .field("frequency_penalty", &self.frequency_penalty)
            .field("seed", &self.seed)
            .field("log_level", &self.log_level)
            .field("request_log_jsonl", &self.request_log_jsonl)
            .field(
                "response_store_max_records",
                &self.response_store_max_records,
            )
            .field("response_store_max_mib", &self.response_store_max_mib)
            .field("context_cost_presets", &self.context_cost_presets)
            .field("cors", &self.cors)
            .field("no_cuda_graph", &self.no_cuda_graph)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NumberOrAuto {
    Number(u64),
    Auto,
}

mod opt_number_or_auto {
    use super::*;
    pub fn deserialize<'de, D>(d: D) -> Result<Option<NumberOrAuto>, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let v: Option<serde_json::Value> = Option::deserialize(d)?;
        match v {
            None => Ok(None),
            // An empty string is the web UI's "unset" sentinel for kv-capacity
            // (the Segmented shows "follow" while keeping ''); treat it as None.
            Some(serde_json::Value::String(s)) if s.is_empty() => Ok(None),
            Some(serde_json::Value::String(s)) if s == "auto" => Ok(Some(NumberOrAuto::Auto)),
            Some(serde_json::Value::String(s)) => s
                .parse::<u64>()
                .map(NumberOrAuto::Number)
                .map(Some)
                .map_err(|_| serde::de::Error::custom("kv-capacity: expected number or 'auto'")),
            Some(serde_json::Value::Number(n)) => {
                if let Some(u) = n.as_u64() {
                    Ok(Some(NumberOrAuto::Number(u)))
                } else {
                    Err(serde::de::Error::custom(
                        "kv-capacity: expected non-negative integer or 'auto'",
                    ))
                }
            }
            Some(_) => Err(serde::de::Error::custom(
                "kv-capacity: expected number or 'auto'",
            )),
        }
    }
    pub fn serialize<S>(v: &Option<NumberOrAuto>, s: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match v {
            None => s.serialize_none(),
            Some(NumberOrAuto::Auto) => s.serialize_str("auto"),
            Some(NumberOrAuto::Number(n)) => s.serialize_u64(*n),
        }
    }
}

#[cfg(test)]
mod debug_redaction {
    use super::*;

    const SECRET: &str = "sk-super-secret-value-do-not-leak";

    #[test]
    fn app_settings_debug_omits_api_key_and_hf_token() {
        let settings = AppSettings {
            api_key: SECRET.to_string(),
            hf_token: SECRET.to_string(),
            cloud_provider_api_key: SECRET.to_string(),
            ..AppSettings::default()
        };
        let rendered = format!("{settings:?}");
        assert!(
            !rendered.contains(SECRET),
            "AppSettings Debug leaked the secret: {rendered}"
        );
        // The field should still be visible as present, just masked.
        assert!(
            rendered.contains("api_key: \"***\""),
            "expected a masked api_key field: {rendered}"
        );
        assert!(
            rendered.contains("hf_token: \"***\""),
            "expected a masked hf_token field: {rendered}"
        );
        assert!(
            rendered.contains("cloud_provider_api_key: \"***\""),
            "expected a masked cloud_provider_api_key field: {rendered}"
        );
    }

    #[test]
    fn app_settings_debug_shows_empty_when_unset() {
        let settings = AppSettings::default();
        let rendered = format!("{settings:?}");
        assert!(
            rendered.contains("api_key: \"\""),
            "expected an empty api_key field: {rendered}"
        );
    }

    #[test]
    fn engine_profile_debug_omits_api_key() {
        let profile = EngineProfile {
            api_key: Some(SECRET.to_string()),
            ..EngineProfile::default()
        };
        let rendered = format!("{profile:?}");
        assert!(
            !rendered.contains(SECRET),
            "EngineProfile Debug leaked the secret: {rendered}"
        );
        assert!(
            rendered.contains("api_key: Some(\"***\")"),
            "expected a masked api_key field: {rendered}"
        );
    }

    #[test]
    fn engine_profile_debug_shows_none_when_unset() {
        let profile = EngineProfile::default();
        let rendered = format!("{profile:?}");
        assert!(
            rendered.contains("api_key: None"),
            "expected api_key: None: {rendered}"
        );
    }

    #[test]
    fn mcp_server_spec_transport_selection() {
        let stdio_spec = McpServerSpec {
            command: Some("node".into()),
            ..Default::default()
        };
        assert_eq!(stdio_spec.transport(), Some("stdio"));

        let http_spec = McpServerSpec {
            url: Some("https://example.com/mcp".into()),
            ..Default::default()
        };
        assert_eq!(http_spec.transport(), Some("http"));

        let both_spec = McpServerSpec {
            command: Some("node".into()),
            url: Some("https://example.com/mcp".into()),
            ..Default::default()
        };
        assert_eq!(both_spec.transport(), None);

        let empty_spec = McpServerSpec::default();
        assert_eq!(empty_spec.transport(), None);
    }

    #[test]
    fn mcp_server_spec_debug_redaction() {
        let mut env = std::collections::HashMap::new();
        env.insert("SECRET_ENV".to_string(), SECRET.to_string());
        let mut headers = std::collections::HashMap::new();
        headers.insert("Authorization".to_string(), SECRET.to_string());

        let spec = McpServerSpec {
            name: "test-server".into(),
            authorization: Some(SECRET.to_string()),
            env,
            headers,
            ..Default::default()
        };
        let rendered = format!("{spec:?}");
        assert!(
            !rendered.contains(SECRET),
            "McpServerSpec Debug leaked the secret: {rendered}"
        );
        assert!(rendered.contains("authorization: Some(\"***\")"));
        assert!(rendered.contains("\"Authorization\": \"***\""));
        assert!(rendered.contains("\"SECRET_ENV\": \"***\""));
    }

    #[test]
    fn opt_number_or_auto_deserialization() {
        #[derive(Deserialize)]
        struct TestStruct {
            #[serde(with = "opt_number_or_auto")]
            kv: Option<NumberOrAuto>,
        }

        let valid_num: TestStruct = serde_json::from_str(r#"{"kv": 100}"#).unwrap();
        assert_eq!(valid_num.kv, Some(NumberOrAuto::Number(100)));

        let valid_auto: TestStruct = serde_json::from_str(r#"{"kv": "auto"}"#).unwrap();
        assert_eq!(valid_auto.kv, Some(NumberOrAuto::Auto));

        let valid_empty: TestStruct = serde_json::from_str(r#"{"kv": ""}"#).unwrap();
        assert_eq!(valid_empty.kv, None);

        let invalid_neg: Result<TestStruct, _> = serde_json::from_str(r#"{"kv": -5}"#);
        assert!(invalid_neg.is_err());

        let invalid_float: Result<TestStruct, _> = serde_json::from_str(r#"{"kv": 3.14}"#);
        assert!(invalid_float.is_err());
    }
}

