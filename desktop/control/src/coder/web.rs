// Rust guideline compliant 2026-07-28

//! Web tools for the coder harness: `web_fetch` (HTML→text with resolved
//! image/link Markdown, SSRF-guarded against loopback/LAN/metadata
//! targets, manual redirect re-checking) and `web_search` (DuckDuckGo HTML
//! endpoint scraping, like the sidecar).

use super::common::enforce_perm;
use crate::engine::S;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::LazyLock;
use std::time::Duration;

/// Keep the first `max` chars of `s`, reporting whether it was cut.
fn truncate_chars(s: &str, max: usize) -> (String, bool) {
    if s.chars().count() > max {
        (s.chars().take(max).collect(), true)
    } else {
        (s.to_string(), false)
    }
}

static TEXT_SEL: LazyLock<scraper::Selector> = LazyLock::new(|| {
    scraper::Selector::parse("*:not(script):not(style):not(noscript)").expect("text selector")
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

/// HTML→text over a real DOM (html5ever via `scraper`): every text node whose
/// parent isn't `script`/`style`/`noscript`, in document order, followed by
/// the page's images and links as absolute Markdown `![alt](url)`/`[text](url)`
/// references (resolved against `base`, the page's own URL — `src`/`href`
/// are frequently relative). Without these, a model asked to "show a
/// picture" or cite a source has no real URL to reach for and either
/// hallucinates one or links to the page itself instead of the image.
/// Entities come decoded from the parser; whitespace is collapsed. The
/// sidecar uses Readability+Turndown (Node-only) for the same shape of
/// output — plain text plus a Markdown-preserved image/link.
fn html_to_text(html: &str, base: &reqwest::Url) -> String {
    use scraper::node::Node;
    let dom = scraper::Html::parse_document(html);
    let mut out = String::new();
    for el in dom.select(&TEXT_SEL) {
        // Direct text children only: each text node has exactly one parent,
        // so nothing is duplicated and script/style subtrees stay excluded.
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
        let Some(src) = el.value().attr("src") else { continue };
        let Ok(abs) = base.join(src) else { continue };
        let abs = abs.to_string();
        if !images.iter().any(|(_, u)| u == &abs) {
            let alt = el.value().attr("alt").unwrap_or("").replace('[', "(").replace(']', ")");
            images.push((alt, abs));
        }
    }
    if !images.is_empty() {
        out.push_str("\n\n## Images on this page\n");
        for (i, (alt, src)) in images.iter().enumerate() {
            let alt = if alt.is_empty() { format!("image {}", i + 1) } else { alt.clone() };
            out.push_str(&format!("![{alt}]({src})\n"));
        }
    }

    let mut links: Vec<(String, String)> = Vec::new();
    for el in dom.select(&LINK_SEL) {
        if links.len() >= 20 {
            break;
        }
        let Some(href) = el.value().attr("href") else { continue };
        let Ok(abs) = base.join(href) else { continue };
        let text = COLLAPSE_WS.replace_all(el.text().collect::<String>().trim(), " ").into_owned();
        let text = if text.is_empty() { abs.to_string() } else { text };
        let abs = abs.to_string();
        if !links.iter().any(|(_, u)| u == &abs) {
            links.push((text, abs));
        }
    }
    if !links.is_empty() {
        out.push_str("\n\n## Links on this page\n");
        for (text, href) in &links {
            out.push_str(&format!("- [{}]({href})\n", text.replace('[', "(").replace(']', ")")));
        }
    }

    out
}

/// True when `ip` is a globally-routable address — i.e. not loopback,
/// private (RFC 1918 / ULA), link-local, CGNAT, multicast, broadcast, or
/// unspecified. Used to keep `web_fetch` off the loopback control plane and
/// the local network (SSRF).
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
        || o[0] == 0                              // "this network"
        || (o[0] == 100 && (o[1] & 0xc0) == 64))  // 100.64.0.0/10 CGNAT
}

fn is_global_ipv6(ip: &Ipv6Addr) -> bool {
    let seg0 = ip.segments()[0];
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (seg0 & 0xfe00) == 0xfc00  // fc00::/7 unique local
        || (seg0 & 0xffc0) == 0xfe80) // fe80::/10 link-local
}

/// Reject `url` unless its scheme is http(s) and its host resolves only to
/// globally-routable addresses — blocks fetching the loopback control plane
/// (or any other internal/LAN service) via a tool an agent can call on
/// untrusted content (fetched pages, files in the workspace).
async fn ensure_public_http_url(url: &reqwest::Url) -> Result<(), (StatusCode, Json<Value>)> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "only http/https URLs are allowed"}))));
    }
    let host = url
        .host_str()
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(json!({"error": "url has no host"}))))?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if is_global_ip(&ip) {
            Ok(())
        } else {
            Err((StatusCode::FORBIDDEN, Json(json!({"error": "refusing to fetch a private/loopback/link-local address"}))))
        };
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let mut addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("dns lookup failed: {e}")}))))?
        .peekable();
    if addrs.peek().is_none() {
        return Err((StatusCode::BAD_GATEWAY, Json(json!({"error": "dns lookup returned no addresses"}))));
    }
    for addr in addrs {
        if !is_global_ip(&addr.ip()) {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({"error": format!("refusing to fetch {host}: resolves to a private/loopback/link-local address")})),
            ));
        }
    }
    Ok(())
}

pub async fn web_fetch(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    const MAX_REDIRECTS: u8 = 5;
    let raw = match req.get("url").and_then(|v| v.as_str()) {
        Some(u) if !u.trim().is_empty() => u.trim().to_string(),
        _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "url required"})))),
    };
    enforce_perm(&state, "web_fetch", None).await?;
    let mut url = reqwest::Url::parse(&raw)
        .map_err(|_| (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid url"}))))?;
    let client = reqwest::Client::builder()
        .user_agent("ninfier-studio/0.1")
        .timeout(Duration::from_secs(25))
        // Redirects are followed manually below so each hop can be
        // re-checked against the SSRF guard — otherwise a public URL could
        // 302 straight into the loopback control plane or the LAN.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("client failed: {e}")}))))?;
    let mut redirects = 0u8;
    let resp = loop {
        ensure_public_http_url(&url).await?;
        let resp = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("fetch failed: {e}")}))))?;
        if resp.status().is_redirection() {
            let Some(location) = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()) else {
                break resp;
            };
            if redirects >= MAX_REDIRECTS {
                return Err((StatusCode::BAD_GATEWAY, Json(json!({"error": "too many redirects"}))));
            }
            redirects += 1;
            url = url
                .join(location)
                .map_err(|_| (StatusCode::BAD_GATEWAY, Json(json!({"error": "invalid redirect location"}))))?;
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
    let mut bytes = resp
        .bytes()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("read failed: {e}")}))))?
        .to_vec();
    bytes.truncate(2 * 1024 * 1024);
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let (content, ct) = if content_type.contains("html") {
        (html_to_text(&text, &url), "text/markdown".to_string())
    } else {
        let ct = if content_type.is_empty() { "text/plain".to_string() } else { content_type };
        (text, ct)
    };
    let (content, truncated) = truncate_chars(&content, 200_000);
    Ok(Json(json!({"url": url.to_string(), "status": status, "contentType": ct, "content": content, "truncated": truncated})))
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
/// percent-encoding, not form-encoding).
fn pct_decode(s: &str) -> String {
    let mut bytes = Vec::with_capacity(s.len());
    let mut it = s.bytes();
    while let Some(b) = it.next() {
        if b == b'%' {
            let hi = it.next().unwrap_or(b'0');
            let lo = it.next().unwrap_or(b'0');
            let hex = |c: u8| (c as char).to_digit(16).unwrap_or(0) as u8;
            bytes.push(hex(hi) << 4 | hex(lo));
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}


/// Unwrap a DuckDuckGo `/l/?...&uddg=<target>&...` redirect, if present.
fn resolve_ddg_href(href: &str) -> String {
    if let Some(i) = href.find("uddg=") {
        let rest = &href[i + 5..];
        let end = rest.find('&').unwrap_or(rest.len());
        let decoded = pct_decode(&rest[..end]);
        if !decoded.is_empty() {
            return decoded;
        }
    }
    if let Some(stripped) = href.strip_prefix("//") {
        return format!("https:{stripped}");
    }
    href.to_string()
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
        let title = COLLAPSE_WS.replace_all(a.text().collect::<String>().trim(), " ").into_owned();
        let snippet = res
            .select(&DDG_SNIP)
            .next()
            .map(|s| COLLAPSE_WS.replace_all(s.text().collect::<String>().trim(), " ").into_owned())
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

pub async fn web_search(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let query = match req.get("query").and_then(|v| v.as_str()) {
        Some(q) if !q.trim().is_empty() => q.trim().to_string(),
        _ => return Err((StatusCode::BAD_REQUEST, Json(json!({"error": "query required"})))),
    };
    enforce_perm(&state, "web_search", None).await?;
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64)")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("client failed: {e}")}))))?;
    let html = client
        .get(format!("https://html.duckduckgo.com/html/?q={}", pct_encode(&query)))
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("search failed: {e}")}))))?
        .text()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(json!({"error": format!("read failed: {e}")}))))?;
    Ok(Json(json!({"results": parse_ddg(&html), "query": query})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_ip_classification_blocks_internal_ranges() {
        let blocked = [
            "127.0.0.1", "127.53.0.1", "10.0.0.1", "172.16.5.1", "192.168.1.1",
            "169.254.169.254", // cloud metadata
            "100.64.0.1",      // CGNAT
            "0.0.0.0", "255.255.255.255",
            "::1", "fe80::1", "fc00::1", "fd12::1",
            "::ffff:127.0.0.1", // IPv4-mapped loopback
        ];
        for ip in blocked {
            let parsed: IpAddr = ip.parse().unwrap();
            assert!(!is_global_ip(&parsed), "should block {ip}");
        }
        let allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"];
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
            assert!(ensure_public_http_url(&parsed).await.is_err(), "should reject {url}");
        }
    }

    #[tokio::test]
    async fn ensure_public_http_url_allows_public_ip_literal() {
        let parsed = reqwest::Url::parse("http://93.184.216.34/").unwrap();
        assert!(ensure_public_http_url(&parsed).await.is_ok());
    }

    #[test]
    fn html_to_text_strips_markup() {
        let base = reqwest::Url::parse("https://example.com/page").unwrap();
        let out = html_to_text("<html><head><style>x{}</style></head><body><h1>Hi &amp; bye</h1><script>evil()</script><p>a  b</p></body></html>", &base);
        assert!(!out.contains('<'));
        assert!(!out.contains("evil()"));
        assert!(out.contains("Hi & bye"));
        assert!(out.contains('a'));
    }

    /// A model asked to show a picture or cite a source needs a real,
    /// absolute URL — not just a page's stripped-down text — so the
    /// fetched page's images/links are appended as resolved Markdown refs.
    #[test]
    fn html_to_text_preserves_image_and_link_urls() {
        let base = reqwest::Url::parse("https://example.com/blog/post").unwrap();
        let out = html_to_text(
            r#"<html><body><p>See <a href="/about">the about page</a>.</p><img src="../cat.png" alt="A cat"><img src="https://cdn.example.com/dog.jpg"></body></html>"#,
            &base,
        );
        assert!(out.contains("![A cat](https://example.com/cat.png)"), "{out}");
        assert!(out.contains("![image 2](https://cdn.example.com/dog.jpg)"), "{out}");
        assert!(out.contains("[the about page](https://example.com/about)"), "{out}");
    }

    #[test]
    fn pct_round_trip() {
        assert_eq!(pct_encode("a b+c~d"), "a%20b%2Bc~d");
        assert_eq!(pct_decode("a%20b%2Bc~d"), "a b+c~d");
    }

    #[test]
    fn ddg_parsing_unwraps_redirects() {
        let html = r#"<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=x">Example <b>Title</b></a><a class="result__snippet" href="x">some snippet here</a></div>"#;
        let parsed = parse_ddg(html);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].get("url").and_then(|v| v.as_str()), Some("https://example.com/page"));
        assert_eq!(parsed[0].get("title").and_then(|v| v.as_str()), Some("Example Title"));
        assert_eq!(parsed[0].get("snippet").and_then(|v| v.as_str()), Some("some snippet here"));
        assert!(parse_ddg("<html><body>no results</body></html>").is_empty());
    }
}
