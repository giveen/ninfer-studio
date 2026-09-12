// Rust guideline compliant 2026-09-12

//! Built-in headless web browser for the coder harness, driven in-process by
//! the Obscura engine (`obscura-browser`): a pure-Rust DOM + JavaScript (V8
//! via deno_core) browser, no Chromium.
//!
//! One `browser` tool, dispatched by `action`:
//!   navigate     open a URL (SSRF-guarded, like `web_fetch`; Obscura's own
//!                HTTP layer also refuses loopback/LAN/link-local so redirect
//!                chains cannot escape the guard)
//!   snapshot     current page URL, title, and readable Markdown body
//!   click        click an element (CSS selector)
//!   fill         set an input value (triggers input+change, React-safe)
//!   press_key    dispatch a keyboard event on a selector (default: active element)
//!   select_option set a <select>'s value
//!   evaluate     run a JavaScript expression in the page and return its value
//!   wait_for     poll until a CSS selector matches (or the timeout elapses)
//!   close        tear down the page and context
//!   status       report whether a page is open and where it is
//!
//! Obscura's `Page` is NOT `Send` (its V8 runtime keeps `Rc<RefCell<..>>`
//! state with strict thread affinity), so the page cannot live behind a
//! `tokio::sync::Mutex` on the shared `State`. Each browser session therefore
//! runs as a small actor on a dedicated driver thread with its own
//! current-thread tokio runtime: that thread owns the page for the whole
//! session, and every tool call is a `(command, reply-sender)` pair pushed
//! over a channel. `BrowserSlot` (a command sender, a liveness flag and a
//! timestamp — all `Send+Sync`) sits on `State`; the session is created
//! lazily on first use and an idle reaper tears it down after `IDLE_TIMEOUT`
//! so an idle agent cannot leak a V8 isolate's worth of RAM.
//!
//! Commands are served strictly one at a time (the slot's mutex serializes
//! them), which also keeps V8's "one thread at a time" isolate rule honest.
//!
//! The agent already has an unsandboxed `bash` tool, so running page JS inside
//! `ninfier-control` does not raise the threat model beyond what `exec` can do;
//! the SSRF guard is what keeps untrusted page content from reaching internal
//! services.

use super::common::enforce_perm;
use super::web::ensure_public_http_url;
use crate::engine::S;
use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::Json;
use obscura_browser::{BrowserContext, HTML_TO_MARKDOWN_JS, Page, WaitUntil};
use serde_json::{json, Value};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::{Duration, Instant};
use tokio::task::LocalSet;
use tokio::time::timeout;

/// A browser session tears down after this much idle time.
const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
/// Hard cap on a single navigation (matches Obscura's own ceiling).
const NAV_TIMEOUT: Duration = Duration::from_secs(30);
/// Cap on `evaluate` so a pathological expression cannot wedge the tool.
const EVAL_TIMEOUT: Duration = Duration::from_secs(20);
/// Default cap for `wait_for`; callers can request less.
const WAIT_FOR_MAX: Duration = Duration::from_secs(15);
/// Truncate snapshots to this many characters before returning to the model.
const MAX_SNAPSHOT_CHARS: usize = 64 * 1024;
/// Whole-command ceiling (the client's own HTTP timeout is a bit lower).
const CMD_TIMEOUT: Duration = Duration::from_secs(55);

/// Commands for the browser actor. Everything is `Send` — these cross from the
/// axum worker thread into the actor's dedicated driver thread.
#[derive(Debug)]
enum BrowserCmd {
    Navigate { url: String, wait: WaitUntil },
    Snapshot,
    Click { selector: String },
    Fill { selector: String, value: String },
    PressKey { selector: Option<String>, key: String },
    SelectOption { selector: String, value: String },
    Evaluate { expression: String },
    WaitFor { selector: String, timeout_secs: u64 },
    Status,
    /// Answer, drop the page, and exit the actor (and its driver thread).
    Stop,
}

type Reply = Value;

/// Wraps a future so a panic inside it completes the task with `Ready(())`
/// instead of unwinding out of the `LocalSet` (a dropped `LocalSet` with a
/// failed task panics, and the session must always be droppable).
struct PanicGuard<F>(F);

impl<F: std::future::Future<Output = ()>> std::future::Future for PanicGuard<F> {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<()> {
        // `PanicGuard` holds only `F`; projecting the field through the same
        // `Pin` is sound.
        // `PanicGuard` holds only `F`; projecting the field through the same
        // `Pin` is sound.
        // SAFETY: `PanicGuard` holds only `F` and no data that references
        // inside of it; projecting the field through the same `Pin` cannot
        // violate `F`'s invariants.
        let inner = unsafe { self.map_unchecked_mut(|p| &mut p.0) };
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| inner.poll(cx))) {
            Ok(poll) => poll,
            Err(e) => {
                let msg = e
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "non-string panic payload".to_string());
                tracing::error!("browser actor task panicked: {msg}");
                Poll::Ready(())
            }
        }
    }
}

/// Client-side half of a browser session. All fields are `Send+Sync`, so this
/// sits comfortably in the shared `State` under a `tokio::sync::Mutex`. The
/// page itself lives on the driver thread (see `spawn_driver`); nothing
/// `!Send` crosses into this struct.
#[derive(Debug)]
pub struct BrowserSlot {
    cmd_tx: Option<tokio::sync::mpsc::UnboundedSender<(BrowserCmd, tokio::sync::mpsc::UnboundedSender<Reply>)>>,
    /// Set to false by the driver thread when the actor exits; lets us tell
    /// "running" apart from "dead but not yet observed".
    open: Option<Arc<AtomicBool>>,
    last_used: Instant,
}

impl BrowserSlot {
    pub(crate) fn new() -> Self {
        Self { cmd_tx: None, open: None, last_used: Instant::now() }
    }

    /// True when a live browser session exists.
    pub fn is_open(&self) -> bool {
        matches!(self.open.as_ref(), Some(f) if f.load(Ordering::Relaxed))
    }

    /// Drop the session if it has been idle past the timeout.
    async fn reap_if_idle(&mut self) {
        if self.is_open() && self.last_used.elapsed() > IDLE_TIMEOUT {
            self.stop();
        }
    }

    /// Stop the session: send `Stop` (the actor drops the page and its driver
    /// thread exits) and clear the slot. The `Stop` reply is not awaited —
    /// the actor exits deterministically right after answering it, and the
    /// next `is_open()` probe observes the liveness flag.
    fn stop(&mut self) {
        if let Some(tx) = self.cmd_tx.take() {
            let (reply_tx, _reply_rx) = tokio::sync::mpsc::unbounded_channel::<Reply>();
            let _ = tx.send((BrowserCmd::Stop, reply_tx));
        }
        self.open = None;
    }

    /// Start the driver thread + actor for this session.
    fn spawn_driver(&mut self) -> Result<(), (StatusCode, Json<Value>)> {
        let (cmd_tx, cmd_rx) =
            tokio::sync::mpsc::unbounded_channel::<(BrowserCmd, tokio::sync::mpsc::UnboundedSender<Reply>)>();
        let open = Arc::new(AtomicBool::new(true));
        let open_flag = open.clone();
        std::thread::Builder::new()
            .name("browser-session".into())
            .spawn(move || {
                // A private current-thread runtime: the driver never touches
                // the control plane's runtime, and everything `!Send` (the
                // V8 page) stays on this thread for the session's lifetime.
                let open_inner = open_flag.clone();
                let res = tokio::runtime::Builder::new_current_thread().enable_all().build();
                match res {
                    Ok(rt) => {
                        rt.block_on(async {
                            let local = LocalSet::new();
                            // Drive the actor's JoinHandle: the session lives
                            // until the actor exits (Stop, or the command
                            // sender being dropped on session teardown).
                            let actor = local.spawn_local(PanicGuard(async move {
                                let () = actor_main(cmd_rx, open_inner).await;
                            }));
                            let _ = local.run_until(actor).await;
                        });
                    }
                    Err(e) => tracing::error!("browser driver runtime failed to start: {e}"),
                }
                open_flag.store(false, Ordering::Relaxed);
            })
            .map_err(|e| http_err(StatusCode::INTERNAL_SERVER_ERROR, format!("failed to start browser session: {e}")))?;
        self.cmd_tx = Some(cmd_tx);
        self.open = Some(open);
        self.last_used = Instant::now();
        Ok(())
    }
}

/// Push one command and return the receiver for its reply. Spawns the session
/// on first use; the reply channel is paired with the command in the same
/// channel write, so no reply can be lost.
async fn send_cmd(
    slot: &mut BrowserSlot,
    cmd: BrowserCmd,
) -> Result<tokio::sync::mpsc::UnboundedReceiver<Reply>, (StatusCode, Json<Value>)> {
    slot.reap_if_idle().await;
    if slot.cmd_tx.is_none() {
        slot.spawn_driver()?;
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Reply>();
    slot.cmd_tx
        .as_ref()
        .ok_or_else(|| http_err(StatusCode::INTERNAL_SERVER_ERROR, "no browser session"))?
        .send((cmd, tx))
        .map_err(|_| http_err(StatusCode::INTERNAL_SERVER_ERROR, "browser session ended"))?;
    slot.last_used = Instant::now();
    Ok(rx)
}

/// Await a command reply with the `CMD_TIMEOUT` ceiling. On timeout the
/// session is torn down: a wedged page is not recoverable in place.
async fn await_reply(
    slot: &mut BrowserSlot,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Reply>,
) -> Result<Value, (StatusCode, Json<Value>)> {
    match timeout(CMD_TIMEOUT, async { rx.recv().await }).await {
        Ok(val) => match val {
            Some(val) => Ok(val),
            None => Err(http_err(StatusCode::INTERNAL_SERVER_ERROR, "browser session ended")),
        }
        Err(_) => {
            slot.stop();
            Err(http_err(StatusCode::GATEWAY_TIMEOUT, "browser command timed out; session closed"))
        }
    }
}

fn http_err(code: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<Value>) {
    (code, Json(json!({ "error": msg.into() })))
}

fn js(s: &str) -> String {
    Value::String(s.to_string()).to_string()
}

fn cap(s: String) -> (String, bool) {
    if s.chars().count() <= MAX_SNAPSHOT_CHARS {
        (s, false)
    } else {
        let out: String = s.chars().take(MAX_SNAPSHOT_CHARS).collect();
        (out, true)
    }
}

fn eval_js(page: &mut Page, expr: &str) -> String {
    let val = page.evaluate(expr);
    if val.is_null() {
        "page script threw".to_string()
    } else {
        val.as_str().map(|s| s.to_string()).unwrap_or_else(|| val.to_string())
    }
}

/// The session task (runs on the driver thread): owns the `Page` and serves
/// commands one at a time.
async fn actor_main(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<(BrowserCmd, tokio::sync::mpsc::UnboundedSender<Reply>)>,
    _open: Arc<AtomicBool>,
) {
    // Obscura refuses loopback/RFC1918/link-local at its HTTP layer, so even
    // JS-triggered redirects and page `fetch()` calls cannot reach internal
    // services.
    let ctx = Arc::new(BrowserContext::with_storage_and_network(
        "ninfier-coder".to_string(),
        None, // no proxy
        false, // no stealth: a transparent UA is friendlier to docs sites
        Some("NInfer Studio Coder Browser/1.0".to_string()),
        None, // no persistent cookie storage
        false, // refuse private/loopback/link-local network access
    ));
    let mut page = Page::new("ninfier-coder-page".to_string(), ctx);
    page.set_navigation_timeout(NAV_TIMEOUT);

    while let Some((cmd, reply)) = rx.recv().await {
        let out = match cmd {
            BrowserCmd::Navigate { url, wait } => {
                // The actor is async and is the only user of the page right
                // now, so we simply await the navigation.
                match page.navigate_with_wait(&url, wait).await {
                    Err(e) => json!({ "error": format!("navigation failed: {e}") }),
                    Ok(()) => json!({
                        "ok": true,
                        "url": page.url_string(),
                        "title": page.evaluate("document.title").as_str().map(|s| s.to_string()),
                    }),
                }
            }
            BrowserCmd::Snapshot => {
                let title = page.evaluate("document.title").as_str().unwrap_or("").to_string();
                let md = match page.evaluate(HTML_TO_MARKDOWN_JS) {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                let (content, truncated) = cap(md);
                json!({ "url": page.url_string(), "title": title, "content": content, "truncated": truncated })
            }
            BrowserCmd::Click { selector } => {
                let expr = format!(
                    "(() => {{ const el = document.querySelector({s}); if (!el) return 'not found'; el.scrollIntoView(); el.click(); return 'clicked'; }})()",
                    s = js(&selector)
                );
                json!({ "ok": true, "result": eval_js(&mut page, &expr) })
            }
            BrowserCmd::Fill { selector, value } => {
                // React (and friends) keep value in an internal state, so
                // assign through the prototype setter and re-emit the events.
                let expr = format!(
                    "(() => {{ const el = document.querySelector({s}); if (!el) return 'not found';
                       const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
                         : (el.isContentEditable ? HTMLElement.prototype : HTMLInputElement.prototype);
                       const set = Object.getOwnPropertyDescriptor(proto, 'value');
                       if (set && set.set) set.call(el, {v}); else el.value = {v};
                       el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                       el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                       return 'filled'; }})()",
                    s = js(&selector),
                    v = js(&value)
                );
                json!({ "ok": true, "result": eval_js(&mut page, &expr) })
            }
            BrowserCmd::PressKey { selector, key } => {
                let has_sel = selector.is_some();
                let expr = format!(
                    "(() => {{ const el = ({has}) ? (document.querySelector({s}) || document.activeElement || document.body) : (document.activeElement || document.body);
                       if (!el) return 'no target'; if (el.focus) el.focus();
                       const mk = (t) => new KeyboardEvent(t, {{ key: {k}, bubbles: true, cancelable: true }});
                       el.dispatchEvent(mk('keydown')); el.dispatchEvent(mk('keyup'));
                       return 'pressed'; }})()",
                    has = has_sel,
                    s = js(selector.as_deref().unwrap_or("")),
                    k = js(&key)
                );
                json!({ "ok": true, "result": eval_js(&mut page, &expr) })
            }
            BrowserCmd::SelectOption { selector, value } => {
                let expr = format!(
                    "(() => {{ const el = document.querySelector({s}); if (!el) return 'not found';
                       if (el.tagName !== 'SELECT') return 'not a select';
                       el.value = {v};
                       el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                       return 'selected'; }})()",
                    s = js(&selector),
                    v = js(&value)
                );
                json!({ "ok": true, "result": eval_js(&mut page, &expr) })
            }
            BrowserCmd::Evaluate { expression } => {
                let val = page.evaluate_with_timeout(&expression, EVAL_TIMEOUT);
                if val.is_null() {
                    json!({ "error": "evaluate timed out or threw" })
                } else {
                    json!({ "result": val })
                }
            }
            BrowserCmd::WaitFor { selector, timeout_secs } => {
                let expr = format!("document.querySelector({}) !== null", js(&selector));
                let deadline = Instant::now() + Duration::from_secs(timeout_secs);
                loop {
                    if page.evaluate(&expr).as_bool() == Some(true) {
                        break json!({ "ok": true, "found": true });
                    }
                    if Instant::now() > deadline {
                        break json!({ "ok": true, "found": false });
                    }
                    // Yield so the runtime can service replies and `Stop`.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
            BrowserCmd::Status => json!({ "open": true, "url": page.url_string() }),
            BrowserCmd::Stop => {
                let _ = reply.send(json!({ "ok": true }));
                drop(page);
                break;
            }
        };
        let _ = reply.send(out);
    }
}

pub async fn browser(AxumState(state): AxumState<S>, Json(req): Json<Value>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    enforce_perm(&state, "browser", None).await?;
    let action = req.get("action").and_then(|v| v.as_str()).unwrap_or("status");
    let sel = req.get("selector").and_then(|v| v.as_str()).unwrap_or("");
    let mut slot = state.browser.lock().await;

    let result = match action {
        "status" => {
            if slot.is_open() {
                let rx = send_cmd(&mut slot, BrowserCmd::Status).await?;
                match await_reply(&mut slot, rx).await {
                    Ok(_) => Ok(Json(json!({ "open": true }))),
                    Err(_) => Ok(Json(json!({ "open": false }))),
                }
            } else {
                Ok(Json(json!({ "open": false })))
            }
        }
        "navigate" => {
            let url = req
                .get("url")
                .and_then(|v| v.as_str())
                .filter(|u| !u.trim().is_empty())
                .map(|u| u.trim().to_string())
                .ok_or_else(|| http_err(StatusCode::BAD_REQUEST, "navigate requires a url"))?;
            let parsed =
                reqwest::Url::parse(&url).map_err(|e| http_err(StatusCode::BAD_REQUEST, format!("bad url: {e}")))?;
            ensure_public_http_url(&parsed).await?;
            let wait = match req.get("wait_until").and_then(|v| v.as_str()).unwrap_or("domcontentloaded") {
                "load" => WaitUntil::Load,
                _ => WaitUntil::DomContentLoaded,
            };
            let rx = send_cmd(&mut slot, BrowserCmd::Navigate { url, wait }).await?;
            await_reply(&mut slot, rx).await.map(Json)
        }
        "snapshot" => {
            let rx = send_cmd(&mut slot, BrowserCmd::Snapshot).await?;
            await_reply(&mut slot, rx).await.map(Json)
        }
        "click" => {
            if sel.is_empty() {
                return Err(http_err(StatusCode::BAD_REQUEST, "click requires a selector"));
            }
            let rx = send_cmd(&mut slot, BrowserCmd::Click { selector: sel.to_string() }).await?;
            await_reply(&mut slot, rx).await.map(Json)
        }
        "fill" => {
            if sel.is_empty() {
                return Err(http_err(StatusCode::BAD_REQUEST, "fill requires a selector"));
            }
            let value = req.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let rx = send_cmd(&mut slot, BrowserCmd::Fill { selector: sel.to_string(), value: value.to_string() }).await?;
            await_reply(&mut slot, rx).await.map(Json)
        }
        "press_key" => {
            let key = req.get("key").and_then(|v| v.as_str()).unwrap_or("");
            if key.is_empty() {
                return Err(http_err(StatusCode::BAD_REQUEST, "press_key requires a key (e.g. \"Enter\")"));
            }
            let selector = if sel.is_empty() { None } else { Some(sel.to_string()) };
            let rx = send_cmd(&mut slot, BrowserCmd::PressKey { selector, key: key.to_string() }).await?;
            await_reply(&mut slot, rx).await.map(Json)
        }
        "select_option" => {
            if sel.is_empty() {
                return Err(http_err(StatusCode::BAD_REQUEST, "select_option requires a selector"));
            }
            let value = req.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let rx = send_cmd(&mut slot, BrowserCmd::SelectOption { selector: sel.to_string(), value: value.to_string() }).await?;
            await_reply(&mut slot, rx).await.map(Json)
        }
        "evaluate" => {
            let expression = req
                .get("expression")
                .and_then(|v| v.as_str())
                .filter(|e| !e.trim().is_empty())
                .ok_or_else(|| http_err(StatusCode::BAD_REQUEST, "evaluate requires an expression"))?
                .to_string();
            let rx = send_cmd(&mut slot, BrowserCmd::Evaluate { expression }).await?;
            await_reply(&mut slot, rx).await.map(Json)
        }
        "wait_for" => {
            if sel.is_empty() {
                return Err(http_err(StatusCode::BAD_REQUEST, "wait_for requires a selector"));
            }
            let timeout_secs = req
                .get("timeout")
                .and_then(|v| v.as_u64())
                .unwrap_or(5)
                .clamp(1, WAIT_FOR_MAX.as_secs());
            let rx = send_cmd(&mut slot, BrowserCmd::WaitFor { selector: sel.to_string(), timeout_secs }).await?;
            await_reply(&mut slot, rx).await.map(Json)
        }
        "close" => {
            slot.stop();
            Ok(Json(json!({ "ok": true })))
        }
        other => return Err(http_err(StatusCode::BAD_REQUEST, format!("unknown browser action: {other}"))),
    };

    slot.last_used = Instant::now();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_quoting_escapes_tricky_strings() {
        // A selector containing quotes must survive a round trip through the
        // generated JS source.
        let s = r#"a[href="/x?a=b&c=<1>"] /* weird */"#;
        let v: Value = serde_json::from_str(&js(s)).unwrap();
        assert_eq!(v.as_str().unwrap(), s);
    }

    #[test]
    fn slot_starts_closed() {
        let slot = BrowserSlot::new();
        assert!(!slot.is_open());
    }

    /// End-to-end session lifecycle: spawn the driver thread, probe status,
    /// then tear the session down. No network involved.
    #[tokio::test]
    async fn session_lifecycle_status_close() {
        let slot = tokio::sync::Mutex::new(BrowserSlot::new());
        let mut slot = slot.lock().await;
        assert!(!slot.is_open());

        let rx = send_cmd(&mut slot, BrowserCmd::Status).await.unwrap();
        let res = await_reply(&mut slot, rx).await.unwrap();
        assert_eq!(res.get("open").and_then(|v| v.as_bool()), Some(true));
        assert!(slot.is_open());

        slot.stop();
        assert!(!slot.is_open());
    }

    /// An unknown action is rejected with a clear 400 (handler level) and
    /// must not have spawned a session.
    #[tokio::test]
    async fn unknown_action_rejected() {
        let state = std::sync::Arc::new(crate::types::State::new(
            std::env::temp_dir().join(format!("ninfier-browser-test-{}", std::process::id())),
            std::env::temp_dir(),
            None,
        ));
        let (_code, body) = browser(AxumState(state.clone()), Json(json!({ "action": "frobnicate" })))
            .await
            .unwrap_err();
        assert!(body.0.get("error").is_some());
        assert!(!state.browser.lock().await.is_open());
    }
}
