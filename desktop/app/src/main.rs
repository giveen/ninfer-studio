//! NInfer Studio desktop shell.
//!
//! The Tauri window hosts the same loopback control-plane URL the browser uses
//! (http://127.0.0.1:8787). The control plane (engine supervision, model
//! management, GPU stats, SSE-safe engine API proxy, static hosting) runs in
//! this process's Rust core — no Node sidecar needed at runtime.
//!
//! Tier 3 platform polish:
//!  * Tray icon + close-to-hide: closing the window hides to the tray (the
//!    spawned engine keeps running) instead of killing it. Gated behind the
//!    `tray` feature (needs libappindicator3-dev at build time on Linux).
//!  * Single-instance: a second launch focuses the existing window.
//!  * Native OS notifications for engine ready/stopped, download & build done.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Manager, WindowEvent};

use ninfier_control::types::AppEvent;
use ninfier_control::{boot_adopt, init_state, serve_until_ready};
use tauri_plugin_notification::NotificationExt;

#[cfg(feature = "tray")]
use tauri::menu::{Menu, MenuItem};
#[cfg(feature = "tray")]
use tauri::tray::{TrayIcon, TrayIconBuilder};

/// Whether an engine is currently running — drives the "engine still running"
/// tray/notification state when the window is hidden.
struct EngineRunning(Arc<AtomicBool>);

#[cfg(feature = "tray")]
/// Tray handle, managed so the event pump can update its tooltip/state.
struct TrayState(std::sync::Mutex<Option<TrayIcon>>);

fn main() {
    // Shared flag (cloned into both the window-event handler and the setup).
    let engine_running = Arc::new(AtomicBool::new(false));
    let engine_running_ev = engine_running.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch should just focus the existing window.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        // Close -> hide to tray (keep the engine alive) instead of quitting.
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                // If an engine is still running, reassure the user it lives on.
                if engine_running_ev.load(Ordering::SeqCst) {
                    let _ = window
                        .app_handle()
                        .notification()
                        .builder()
                        .title("NInfer Studio hidden to tray")
                        .body("The inference engine is still running in the background.")
                        .show();
                }
            }
        })
        .setup(move |app| {
            // ---- event bridge: control plane -> OS notifications + tray -----
            let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel::<AppEvent>();

            // ---- tray (gated: needs libappindicator3-dev on Linux) ----------
            #[cfg(feature = "tray")]
            {
                let show_i = MenuItem::with_id(app, "show", "Show NInfer Studio", true, None::<&str>)?;
                let hide_i = MenuItem::with_id(app, "hide", "Hide to tray", true, None::<&str>)?;
                let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::new()?;
                menu.append(&show_i)?;
                menu.append(&hide_i)?;
                menu.append(&quit_i)?;
                let tray = TrayIconBuilder::with_id("main-tray")
                    .icon(
                        app.default_window_icon()
                            .cloned()
                            .expect("window icon missing"),
                    )
                    .tooltip("NInfer Studio")
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "hide" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
                app.manage(TrayState(std::sync::Mutex::new(Some(tray))));
            }

            app.manage(EngineRunning(engine_running.clone()));

            // In a bundled (release) binary, serve the UI from Tauri's resource
            // dir — where frontendDist is baked at build time — instead of the
            // compile-time source path that default_dist_dir() would otherwise
            // resolve to (CARGO_MANIFEST_DIR is frozen at build time and points
            // at the CI runner, not the user's machine).
            if !cfg!(debug_assertions) {
                if let Ok(res) = app.path().resource_dir() {
                    unsafe {
                        std::env::set_var("NINFIER_STUDIO_DIST", res);
                    }
                }
            }

            // ---- control plane on a dedicated tokio runtime ------------------
            let port: u16 = std::env::var("NINFIER_STUDIO_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(8787);

            let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("failed to build tokio runtime");
                rt.block_on(async move {
                    let state = init_state(Some(ev_tx)).await;
                    boot_adopt(&state).await;
                    if let Err(e) = serve_until_ready(state, port, Some(ready_tx)).await {
                        eprintln!("[ninfier-studio] control plane error: {e}");
                    }
                });
            });
            // block this thread until the listener is bound (5 s cap)
            let _ = ready_rx.recv_timeout(std::time::Duration::from_secs(5));

            // ---- event pump: notifications + tray state ----------------------
            let pump_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(ev) = ev_rx.recv().await {
                    handle_event(&pump_handle, &ev);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running NInfer Studio");
}

/// Map a control-plane event to an OS notification and update tray state.
fn handle_event(app: &tauri::AppHandle, ev: &AppEvent) {
    let (title, body): (String, String) = match ev {
        AppEvent::EngineReady { model, port } => (
            "Engine ready".to_string(),
            format!(
                "{} is serving on :{}",
                model.clone().unwrap_or_else(|| "Engine".to_string()),
                port
            ),
        ),
        AppEvent::EngineStopped => (
            "Engine stopped".to_string(),
            "The inference engine is no longer running.".to_string(),
        ),
        AppEvent::EngineFailed { reason } => (
            "Engine failed".to_string(),
            reason
                .clone()
                .unwrap_or_else(|| "Engine exited unexpectedly.".to_string()),
        ),
        AppEvent::DownloadFinished { file, ok } => (
            if *ok { "Download finished" } else { "Download failed" }.to_string(),
            file.clone(),
        ),
        AppEvent::BuildFinished { action, ok } => (
            if *ok {
                format!("{action} finished")
            } else {
                format!("{action} failed")
            },
            String::new(),
        ),
    };

    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();

    // Reflect engine state in the tray ("engine still running" indicator).
    let running = matches!(ev, AppEvent::EngineReady { .. });
    app.state::<EngineRunning>().0.store(running, Ordering::SeqCst);
    #[cfg(feature = "tray")]
    if let Some(tray) = app.state::<TrayState>().0.lock().unwrap().as_ref() {
        let tip = if running {
            "NInfer Studio — engine running"
        } else if matches!(ev, AppEvent::EngineFailed { .. }) {
            "NInfer Studio — engine failed"
        } else {
            "NInfer Studio"
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}
