// Rust guideline compliant 2026-07-28

//! Web tools for the coder harness: `web_fetch` (HTML→text with resolved
//! image/link Markdown, SSRF-guarded against loopback/LAN/metadata
//! targets, manual redirect re-checking with pinned DNS) and `web_search`
//! (DuckDuckGo HTML endpoint scraping, like the sidecar).

use super::common::{enforce_perm, perm_scope};
use crate::engine::S;
use axum::Json;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::LazyLock;
use std::time::Duration;

/// Keep the first `max` chars of `s`, reporting whether it was cut. Single-pass.
fn truncate_chars(s: &str, max: usize) -> (String, bool) {
    if let Some((idx, _)) = s.char_indices().nth(max) {
        (s[..idx].to_string(), true)
    } else {
        (s.to_string(), false)
    }
}

static TEXT_SEL: LazyLock<scraper::Selector> = LazyLock::new(|| {
    scraper::Selector::parse("*:not(head):not(script):not(style):not(noscript)").expect("text selector")
});
static IMG_SEL: LazyLock<scraper::Selector> =
    LazyLock::new(|| scraper::Selector::parse("img[src]").expect("img selector"));
static LINK_SEL: LazyLock<scraper::Selector> =
    LazyLock::new(|| scraper::Selector::parse("a[href]").expect("link selector"));
static DDG_RESULT: LazyLock<scraper::Selector> =
    LazyLock::new(|| scraper::Selector::parse(".result").expect("ddg selector"));
static DDG_LINK: LazyLock<scraper::Selector> =
    LazyLock::new(|| scraper::Selector::parse("a.result__a").expect("ddg selector"));
static DDG_SNIP: LazyLock<scraper::Selector> =
    LazyLock::new(|| scraper::Selector::parse(".result__snippet").expect("ddg selector"));
static COLLAPSE_WS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"[ \t\x0b\x0c\r\n]+").expect("html regex"));

static SEARCH_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64)")
        .timeout(Duration::from_secs(20))
        .build()
        .expect("search client")
});

/// HTML→text over a real DOM (html5ever via `scraper`): text nodes outside
/// `head`/`script`/`style`/`noscript`, in document order, followed by
/// absolute Markdown image/link references resolved against `base`.
fn html_to_text(html: &str, base: &reqwest::Url) -> String {
    use scraper::node::Node;
    let dom = scraper::Html::parse_document(html);
    let mut out = String::new();
    for el in dom.select(&TEXT_SEL) {
        let mut parent = el.parent();
        let mut in_head = false;
        while let Some(p) = parent {
            if let Some(element) = p.value().as_element() {
                if element.name() == "head" {
                    in_head = true;
                    break;
                }
            }
            parent = p.parent();
        }
        if in_head {
            continue;
        }

        for child in el.children() {
            if let Node::Text(t) = child.value() {
                out.push_str(&t.text);
                out.push(' ');
            }
        }
    }
    let mut out = COLLAPSE_WS.replace_all(out.trim(), " ").into_owned();

    let mut images: Vec<(String, String)> = Vec::new();
    for el in dom.select(&IMG_SEL) {
        if images.len() >= 20 {
            break;
        }
        let Some(src) = el.value().attr("src") else {
            continue;
        };
        let Ok(abs) = base.join(src) else { continue };
        let abs = abs.to_string();
        if !images.iter().any(|(_, u)| u == &abs) {
            let alt = el
                .value()
                .attr("alt")
                .unwrap_or("")
                .replace('[', "(")
                .replace(']', ")");
            images.push((alt, abs));
        }
    }
    if !images.is_empty() {
        out.push_str("\n\n## Images on this page\n");
        for (i, (alt, src)) in images.iter().enumerate() {
            let alt = if alt.is_empty() {
                format!("image {}", i + 1)
            } else {
                alt.clone()
            };
            out.push_str(&format!("![{alt}]({src})\n"));
        }
    }

    let mut links: Vec<(String, String)> = Vec::new();
    for el in dom.select(&LINK_SEL) {
        if links.len() >= 20 {
            break;
        }
        let Some(href) = el.value().attr("href") else {
            continue;
        };
        let Ok(abs) = base.join(href) else { continue };
        let text = COLLAPSE_WS
            .replace_all(el.text().collect::<String>().trim(), " ")
            .into_owned();
        let text = if text.is_empty() {
            abs.to_string()
        } else {
            text
        };
        let abs = abs.to_string();
        if !links.iter().any(|(_, u)| u == &abs) {
            links.push((text, abs));
        }
    }
    if !links.is_empty() {
        out.push_str("\n\n## Links on this page\n");
        for (text, href) in &links {
            out.push_str(&format!(
                "- [{}]({href})\n",
                text.replace('[', "(").replace(']', ")")
            ));
        }
    }

    out
}

/// True when `ip` is a globally-routable address — i.e. not loopback,
/// private (RFC 1918 / ULA), link-local, CGNAT, benchmarking, documentation,
/// NAT64, 6to4 internal, multicast, broadcast, or unspecified.
fn is_global_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_global_ipv4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_global_ipv4(&v4),
            None => is_global_ipv6(v6),
        },
    }
}

fn is_global_ipv4(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        || o[0] == 0                              // 0.0.0.0/8 "this network"
        || (o[0] == 100 && (o[1] & 0xc0) == 64)   // 100.64.0.0/10 CGNAT
        || (o[0] == 198 && (o[1] & 0xfe) == 18)   // 198.18.0.0/15 Benchmarking
        || (o[0] & 0xf0) == 240)                  // 240.0.0.0/4 Reserved
}

fn is_global_ipv6(ip: &Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_global_ipv4(&v4);
    }
    let seg = ip.segments();
    // 6to4 (2002::/16) embeds IPv4 in segments[1..3]
    if seg[0] == 0x2002 {
        let v4 = Ipv4Addr::new(
            (seg[1] >> 8) as u8,
            (seg[1] & 0xff) as u8,
            (seg[2] >> 8) as u8,
            (seg[2] & 0xff) as u8,
        );
        if !is_global_ipv4(&v4) {
            return false;
        }
    }
    // NAT64 well-known prefix (64:ff9b::/96)
    if seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2] == 0 && seg[3] == 0 && seg[4] == 0 {
        let v4 = Ipv4Addr::new(
            (seg[5] >> 8) as u8,
            (seg[5] & 0xff) as u8,
            (seg[6] >> 8) as u8,
            (seg[6] & 0xff) as u8,
        );
        if !is_global_ipv4(&v4) {
            return false;
        }
    }

    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (seg[0] & 0xfe00) == 0xfc00            // fc00::/7 Unique Local
        || (seg[0] & 0xffc0) == 0xfe80            // fe80::/10 Link-Local
        || (seg[0] == 0x2001 && seg[1] == 0x0db8) // 2001:db8::/32 Documentation
        || (seg[0] == 0x0100 && seg[1] == 0))     // 100::/64 Discard prefix
}

/// Validate scheme and host for `url`, perform DNS lookup, check ALL returned IP
/// addresses against global routability rules, and return the resolved `SocketAddr`
/// vector alongside the original host string.
pub(crate) async fn resolve_and_validate_public_url(
    url: &reqwest::Url,
) -> Result<(String, Vec<SocketAddr>), (StatusCode, Json<Value>)> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "only http/https URLs are allowed"})),
        ));
    }
    let host = url.host_str().ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "url has no host"})),
        )
    })?;
    let port = url.port_or_known_default().unwrap_or(80);

    let addrs: Vec<SocketAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_global_ip(&ip) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({"error": "refusing to fetch a private/loopback/link-local address"})),
            ));
        }
        vec![SocketAddr::new(ip, port)]
    } else {
        let lookup_addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| {
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"error": format!("dns lookup failed: {e}")})),
                )
            })?
            .collect();

        if lookup_addrs.is_empty() {
            return Err((
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": "dns lookup returned no addresses"})),
            ));
        }

        for addr in &lookup_addrs {
            if !is_global_ip(&addr.ip()) {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(json!({
                        "error": format!("refusing to fetch {host}: resolves to a private/loopback/link-local address")
                    })),
                ));
            }
        }
        lookup_addrs
    };

    Ok((host.to_string(), addrs))
}

pub(crate) async fn ensure_public_http_url(
    url: &reqwest::Url,
) -> Result<(), (StatusCode, Json<Value>)> {
    resolve_and_validate_public_url(url).await.map(|_| ())
}

/// Stream response body up to `max_bytes` using `.chunk()`. Prevents unbounded
/// memory allocation from infinite streams or huge files.
async fn read_bounded_body(
    mut resp: reqwest::Response,
    max_bytes: usize,
) -> Result<(Vec<u8>, bool), (StatusCode, Json<Value>)> {
    let mut buf = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = resp.chunk().await.map_err(|e| {
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": format!("read failed: {e}")})),
        )
    })? {
        if buf.len() + chunk.len() > max_bytes {
            let take = max_bytes.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..take]);
            truncated = true;
            break;
        } else {
            buf.extend_from_slice(&chunk);
        }
    }
    Ok((buf, truncated))
}

pub async fn web_fetch(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    const MAX_REDIRECTS: u8 = 5;
    let raw = match req.get("url").and_then(|v| v.as_str()) {
        Some(u) if !u.trim().is_empty() => u.trim().to_string(),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "url required"})),
            ));
        }
    };
    enforce_perm(
        &state,
        &perm_scope(&req),
        "web_fetch",
        None,
        req.get("approvalToken").and_then(|v| v.as_str()),
    )
    .await?;

    let mut url = reqwest::Url::parse(&raw).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid url"})),
        )
    })?;

    let mut redirects = 0u8;
    let resp = loop {
        let (host_str, addrs) = resolve_and_validate_public_url(&url).await?;

        // Pin the client's DNS resolver for `host_str` to the exact checked `addrs`,
        // eliminating DNS rebinding (TOCTOU) windows between check and request.
        let client = reqwest::Client::builder()
            .user_agent("ninfier-studio/0.1")
            .timeout(Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(&host_str, &addrs)
            .build()
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": format!("client failed: {e}")})),
                )
            })?;

        let resp = client.get(url.clone()).send().await.map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": format!("fetch failed: {e}")})),
            )
        })?;

        if resp.status() == StatusCode::NOT_MODIFIED {
            break resp;
        }

        if resp.status().is_redirection() {
            let Some(location) = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
            else {
                break resp;
            };
            if redirects >= MAX_REDIRECTS {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"error": "too many redirects"})),
                ));
            }
            redirects += 1;
            url = url.join(location).map_err(|_| {
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"error": "invalid redirect location"})),
                )
            })?;
            continue;
        }
        break resp;
    };

    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let (bytes, byte_truncated) = read_bounded_body(resp, 2 * 1024 * 1024).await?;
    let text = String::from_utf8_lossy(&bytes).into_owned();

    let ct_low = content_type.to_lowercase();
    let is_html = ct_low.contains("text/html")
        || ct_low.contains("application/xhtml+xml")
        || ct_low.contains("text/xml")
        || ct_low.contains("application/xml")
        || ct_low.ends_with("+xml");

    let (content, ct) = if is_html {
        (html_to_text(&text, &url), "text/markdown".to_string())
    } else {
        let ct = if content_type.is_empty() {
            "text/plain".to_string()
        } else {
            content_type
        };
        (text, ct)
    };

    let (content, char_truncated) = truncate_chars(&content, 200_000);
    let truncated = byte_truncated || char_truncated;

    Ok(Json(
        json!({"url": url.to_string(), "status": status, "contentType": ct, "content": content, "truncated": truncated}),
    ))
}

/// Percent-encode a query string (alphanumerics + `-_.~` pass through).
fn pct_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Decode `%XX` sequences (leaves `+` alone — DuckDuckGo redirect params use
/// percent-encoding, not form-encoding). Preserves malformed `%` or `%X` sequences.
fn pct_decode(s: &str) -> String {
    let mut bytes = Vec::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let next1 = chars.peek().copied();
            let next2 = chars.clone().nth(1);
            if let (Some(h1), Some(h2)) = (next1, next2)
                && let (Some(d1), Some(d2)) = (h1.to_digit(16), h2.to_digit(16))
            {
                chars.next();
                chars.next();
                bytes.push((d1 << 4 | d2) as u8);
            } else {
                bytes.push(b'%');
            }
        } else {
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Unwrap a DuckDuckGo `/l/?...&uddg=<target>&...` redirect, if present.
/// Validates scheme to ensure only http/https target URLs are returned.
fn resolve_ddg_href(href: &str) -> String {
    if let Some(i) = href.find("uddg=") {
        let rest = &href[i + 5..];
        let end = rest.find('&').unwrap_or(rest.len());
        let decoded = pct_decode(&rest[..end]);
        if let Ok(parsed) = reqwest::Url::parse(&decoded) {
            if parsed.scheme() == "http" || parsed.scheme() == "https" {
                return decoded;
            }
        }
        return String::new();
    }
    if let Some(stripped) = href.strip_prefix("//") {
        let candidate = format!("https:{stripped}");
        if let Ok(parsed) = reqwest::Url::parse(&candidate) {
            if parsed.scheme() == "http" || parsed.scheme() == "https" {
                return candidate;
            }
        }
        return String::new();
    }
    if let Ok(parsed) = reqwest::Url::parse(href) {
        if parsed.scheme() == "http" || parsed.scheme() == "https" {
            return href.to_string();
        }
    }
    String::new()
}

/// Scrape DuckDuckGo's html endpoint the way the sidecar does (`.result`
/// nodes, `.result__a` links, `.result__snippet` text), parsed with real CSS
/// selectors. Best-effort: skips nodes it can't parse.
fn parse_ddg(html: &str) -> Vec<Value> {
    let dom = scraper::Html::parse_document(html);
    let mut out = Vec::new();
    for res in dom.select(&DDG_RESULT) {
        if out.len() >= 8 {
            break;
        }
        let Some(a) = res.select(&DDG_LINK).next() else {
            continue;
        };
        let href = match a.attr("href") {
            Some(h) => h,
            None => continue,
        };
        let title = COLLAPSE_WS
            .replace_all(a.text().collect::<String>().trim(), " ")
            .into_owned();
        let snippet = res
            .select(&DDG_SNIP)
            .next()
            .map(|s| {
                COLLAPSE_WS
                    .replace_all(s.text().collect::<String>().trim(), " ")
                    .into_owned()
            })
            .unwrap_or_default();
        let url = resolve_ddg_href(href);
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let (snippet, _) = truncate_chars(&snippet, 300);
        out.push(json!({"title": title, "url": url, "snippet": snippet}));
    }
    out
}

pub async fn web_search(
    AxumState(state): AxumState<S>,
    Json(req): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let query = match req.get("query").and_then(|v| v.as_str()) {
        Some(q) if !q.trim().is_empty() => q.trim().to_string(),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "query required"})),
            ));
        }
    };
    enforce_perm(
        &state,
        &perm_scope(&req),
        "web_search",
        None,
        req.get("approvalToken").and_then(|v| v.as_str()),
    )
    .await?;

    let resp = SEARCH_CLIENT
        .get(format!(
            "https://html.duckduckgo.com/html/?q={}",
            pct_encode(&query)
        ))
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": format!("search failed: {e}")})),
            )
        })?;

    let (bytes, _byte_truncated) = read_bounded_body(resp, 2 * 1024 * 1024).await?;
    let html = String::from_utf8_lossy(&bytes).into_owned();
    let results = parse_ddg(&html);

    let hint = if results.is_empty() {
        Some("No results found. (Note: DuckDuckGo may have rate-limited or challenged the request).")
    } else {
        None
    };

    Ok(Json(json!({
        "results": results,
        "query": query,
        "hint": hint,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_ip_classification_blocks_internal_and_reserved_ranges() {
        let blocked = [
            "127.0.0.1",
            "127.53.0.1",
            "10.0.0.1",
            "172.16.5.1",
            "192.168.1.1",
            "169.254.169.254", // cloud metadata
            "100.64.0.1",      // CGNAT
            "198.18.0.1",      // Benchmarking
            "240.1.1.1",       // Reserved
            "0.0.0.0",
            "255.255.255.255",
            "::1",
            "fe80::1",
            "fc00::1",
            "fd12::1",
            "2001:db8::1",     // IPv6 Documentation
            "64:ff9b::10.0.0.1", // NAT64 loopback/private
            "::ffff:127.0.0.1", // IPv4-mapped loopback
        ];
        for ip in blocked {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(!is_global_ip(&parsed), "should block {ip}");
        }
        let allowed = [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",
            "2606:4700:4700::1111",
        ];
        for ip in allowed {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(is_global_ip(&parsed), "should allow {ip}");
        }
    }

    #[tokio::test]
    async fn ensure_public_http_url_rejects_loopback_and_non_http_schemes() {
        for url in [
            "http://127.0.0.1/api/coder/workspace",
            "http://localhost:8787/api/status",
            "http://[::1]:8787/",
            "http://169.254.169.254/latest/meta-data/",
            "file:///etc/passwd",
        ] {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(
                ensure_public_http_url(&parsed).await.is_err(),
                "should reject {url}"
            );
        }
    }

    #[tokio::test]
    async fn ensure_public_http_url_allows_public_ip_literal() {
        let parsed = reqwest::Url::parse("http://93.184.216.34/").unwrap();
        assert!(ensure_public_http_url(&parsed).await.is_ok());
    }

    #[test]
    fn html_to_text_strips_markup_and_head_title() {
        let base = reqwest::Url::parse("https://example.com/page").unwrap();
        let out = html_to_text(
            "<html><head><title>My Title</title><style>x{}</style></head><body><h1>Hi &amp; bye</h1><script>evil()</script><p>a  b</p></body></html>",
            &base,
        );
        assert!(!out.contains("My Title"));
        assert!(!out.contains("evil()"));
        assert!(out.contains("Hi & bye"));
        assert!(out.contains('a'));
    }

    #[test]
    fn html_to_text_preserves_image_and_link_urls() {
        let base = reqwest::Url::parse("https://example.com/blog/post").unwrap();
        let out = html_to_text(
            r#"<html><body><p>See <a href="/about">the about page</a>.</p><img src="../cat.png" alt="A cat"><img src="https://cdn.example.com/dog.jpg"></body></html>"#,
            &base,
        );
        assert!(
            out.contains("![A cat](https://example.com/cat.png)"),
            "{out}"
        );
        assert!(
            out.contains("![image 2](https://cdn.example.com/dog.jpg)"),
            "{out}"
        );
        assert!(
            out.contains("[the about page](https://example.com/about)"),
            "{out}"
        );
    }

    #[test]
    fn pct_round_trip() {
        assert_eq!(pct_encode("a b+c~d"), "a%20b%2Bc~d");
        assert_eq!(pct_decode("a%20b%2Bc~d"), "a b+c~d");
        assert_eq!(pct_decode("100%_complete_%G1"), "100%_complete_%G1");
    }

    #[test]
    fn resolve_ddg_href_filters_unsafe_schemes() {
        assert_eq!(
            resolve_ddg_href("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage"),
            "https://example.com/page"
        );
        assert_eq!(
            resolve_ddg_href("//duckduckgo.com/l/?uddg=javascript%3Aalert%281%29"),
            ""
        );
        assert_eq!(
            resolve_ddg_href("//duckduckgo.com/l/?uddg=data%3Atext%2Fhtml%2Cevil"),
            ""
        );
    }

    #[test]
    fn ddg_parsing_unwraps_redirects() {
        let html = r#"<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=x">Example <b>Title</b></a><a class="result__snippet" href="x">some snippet here</a></div>"#;
        let parsed = parse_ddg(html);
        assert_eq!(parsed.len(), 1);
        assert_eq!(
            parsed[0].get("url").and_then(|v| v.as_str()),
            Some("https://example.com/page")
        );
        assert_eq!(
            parsed[0].get("title").and_then(|v| v.as_str()),
            Some("Example Title")
        );
        assert_eq!(
            parsed[0].get("snippet").and_then(|v| v.as_str()),
            Some("some snippet here")
        );
        assert!(parse_ddg("<html><body>no results</body></html>").is_empty());
    }

    #[tokio::test]
    async fn web_fetch_redirect_rechecks_ssrf_and_blocks_loopback() {
        let public_base = reqwest::Url::parse("http://93.184.216.34/").unwrap();
        let private_redirect = public_base.join("http://127.0.0.1/secret").unwrap();
        assert!(ensure_public_http_url(&private_redirect).await.is_err());

        let proto_relative = public_base.join("//127.0.0.1/secret").unwrap();
        assert!(ensure_public_http_url(&proto_relative).await.is_err());
    }
}
