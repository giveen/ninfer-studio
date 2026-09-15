//! MCP tool-name namespacing: sanitize, split, mangle, spec validation.
//!
//! Depends on `types` only. Pure string logic — unit-tested here; the
//! stdio end-to-end test stays in `routes.rs` next to the handlers it hits.

use super::types::{MCP_PREFIX, ToolDef};
use crate::types::McpServerSpec;
use axum::Json;
use axum::http::StatusCode;
use rmcp::model::Tool;
use serde_json::json;
use std::collections::HashMap;

/// Sanitize a user-supplied server name: keep `[A-Za-z0-9-]`. Underscores
/// are reserved for the `mcp__<server>__<tool>` separators, so they are
/// dropped rather than translated (the name stays a stable, unique id).
pub(super) fn sanitize_server_name(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect()
}

/// Mangle an MCP tool name into something the LLM's function-name grammar
/// accepts: `[a-zA-Z0-9_-]`, capped so `mcp__` + server + `__` + tool fits
/// comfortably inside 64 chars.
pub(super) fn sanitize_tool_name(raw: &str) -> String {
    let mut out: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        out.push_str("tool");
    }
    if out.len() > 56 {
        out.truncate(56);
    }
    out
}

/// Split an `mcp__<server>__<tool>` name into `(server, tool)`. Server
/// names never contain `_` (see `sanitize_server_name`), so the first `__`
/// is unambiguously the separator; the tool part may itself contain `__`
/// (mangled from a server-side name that did).
pub(crate) fn split_mcp_name(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix(MCP_PREFIX)?;
    let idx = rest.find("__")?;
    let (server, tail) = rest.split_at(idx);
    let tool = &tail[2..];
    (!server.is_empty() && !tool.is_empty()).then_some((server, tool))
}

/// Map a server's raw `tools/list` result into namespaced, LLM-safe
/// definitions. Two raw tools that mangle to the same name get a
/// `_2`, `_3`, … suffix so neither shadows the other.
pub(super) fn mangle_tools(server: &str, tools: &[Tool]) -> Vec<ToolDef> {
    let prefix = format!("{MCP_PREFIX}{server}__");
    let mut defs = Vec::new();
    let mut count: HashMap<String, i64> = HashMap::new();
    for t in tools {
        let mut mangled = format!("{prefix}{}", sanitize_tool_name(&t.name));
        let n = count.entry(mangled.clone()).or_insert(0);
        *n += 1;
        if *n > 1 {
            mangled = format!("{mangled}_{n}");
        }
        defs.push(ToolDef {
            mangled,
            original: t.name.as_ref().to_string(),
            description: t
                .description
                .as_deref()
                .map(String::from)
                .unwrap_or_default(),
            parameters: serde_json::to_value(t.input_schema.as_ref())
                .unwrap_or_else(|_| json!({ "type": "object" })),
        });
    }
    defs
}

/// Validate a spec before it is persisted: a usable non-empty name and a
/// usable http(s) url for http transport. (Hand-edited configs that fail
/// `transport()` are tolerated at load time and simply report as
/// disconnected; the upsert endpoint is strict.)
pub(super) fn validate_spec(spec: &McpServerSpec) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let err = |m: String| (StatusCode::BAD_REQUEST, Json(json!({ "error": m })));
    if sanitize_server_name(&spec.name).is_empty() {
        return Err(err(
            "server name must contain at least one letter, digit, or dash".into(),
        ));
    }
    if spec.name.trim().len() > 40 {
        return Err(err("server name too long (max 40 chars)".into()));
    }
    // Both transports set is ambiguous (`transport()` would silently prefer
    // stdio and ignore the url) — reject so a misconfigured server surfaces
    // immediately instead of connecting over the wrong transport.
    let has_cmd = spec
        .command
        .as_deref()
        .is_some_and(|c| !c.trim().is_empty());
    let has_url = spec.url.as_deref().is_some_and(|u| !u.trim().is_empty());
    if has_cmd && has_url {
        return Err(err(
            "server needs exactly one of a stdio command or an http(s) url, not both".into(),
        ));
    }
    if matches!(spec.transport(), Some("http")) {
        let url = spec.url.as_deref().unwrap_or("").trim();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(err("http servers need an http(s):// url".into()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_and_split_names() {
        // Server names: alnum + '-', underscores stripped (they would break
        // the `mcp__<server>__<tool>` separator grammar).
        assert_eq!(sanitize_server_name("my server"), "myserver");
        assert_eq!(sanitize_server_name("file_2"), "file2");
        assert_eq!(sanitize_server_name("fs-v2"), "fs-v2");
        assert_eq!(sanitize_server_name("!!!"), "");
        // Tool names: mangled into the LLM function-name charset.
        assert_eq!(sanitize_tool_name("get weather"), "get_weather");
        assert_eq!(sanitize_tool_name("a/b:c.d"), "a_b_c_d");
        assert_eq!(sanitize_tool_name(""), "tool");
        assert_eq!(sanitize_tool_name(&"x".repeat(80)).len(), 56);
        // Split: first `__` after the prefix is the separator.
        assert_eq!(split_mcp_name("mcp__fs__read"), Some(("fs", "read")));
        assert_eq!(split_mcp_name("mcp__fs__a__b"), Some(("fs", "a__b")));
        assert_eq!(split_mcp_name("mcp__fs__"), None);
        assert_eq!(split_mcp_name("mcp__"), None);
        assert_eq!(split_mcp_name("plain_tool"), None);
        // Collision mangling: a second tool mangles to the same name gets a
        // numeric suffix; the original server-side name is kept for the call.
        let a = sanitize_tool_name("a.b");
        let b = sanitize_tool_name("a_b");
        assert_eq!(a, b);
        assert_eq!(format!("{a}_2"), format!("{b}_2"));
    }

    #[test]
    fn validate_spec_rejects_broken_configs() {
        // Lenient on purpose: hand-edited configs without a transport are
        // tolerated at load time (they show as disconnected); upsert is the
        // strict gate for that.
        let mut s = McpServerSpec::default();
        s.name = "none".into();
        assert!(validate_spec(&s).is_ok());

        // But the name must survive sanitization.
        let mut s = McpServerSpec::default();
        s.name = "!!!".into();
        let (st, body) = validate_spec(&s).unwrap_err();
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(body.0.get("error").is_some());

        // And an over-long name is rejected.
        let mut s = McpServerSpec::default();
        s.name = "x".repeat(41);
        s.command = Some("/bin/true".into());
        let (st, _) = validate_spec(&s).unwrap_err();
        assert_eq!(st, StatusCode::BAD_REQUEST);

        let mut s = McpServerSpec::default();
        s.name = "ok".into();
        s.command = Some("/bin/true".into());
        assert!(validate_spec(&s).is_ok());

        let mut s = McpServerSpec::default();
        s.name = "ok".into();
        s.url = Some("https://mcp.example.com/mcp".into());
        assert!(validate_spec(&s).is_ok());

        // Non-http(s) URLs are rejected up front.
        let mut s = McpServerSpec::default();
        s.name = "bad".into();
        s.url = Some("ftp://mcp.example.com".into());
        let (st, _) = validate_spec(&s).unwrap_err();
        assert_eq!(st, StatusCode::BAD_REQUEST);

        // Both transports set is ambiguous (stdio would silently win) —
        // rejected so the misconfiguration surfaces immediately.
        let mut s = McpServerSpec::default();
        s.name = "both".into();
        s.command = Some("/bin/true".into());
        s.url = Some("https://mcp.example.com/mcp".into());
        let (st, _) = validate_spec(&s).unwrap_err();
        assert_eq!(st, StatusCode::BAD_REQUEST);
    }
}
