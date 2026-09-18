//! Standalone control-plane binary: run the full HTTP control plane without
//! the Tauri window (dev mode, or a lightweight "just the server" mode).

// Rust guideline compliant 2026-07-28

use mimalloc::MiMalloc;
use std::process::ExitCode;

#[global_allocator]
static ALLOCATOR: MiMalloc = MiMalloc;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let port = ninfier_control::control_plane_port();
    let state = ninfier_control::init_state(None).await;

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
    let state_for_server = state.clone();

    let server_task = tokio::spawn(async move {
        ninfier_control::boot(state_for_server, port, Some(ready_tx)).await
    });

    if let Ok(()) = ready_rx.recv() {
        println!("NInfer Studio control plane listening on http://127.0.0.1:{port}");
    }

    let state_for_shutdown = state.clone();

    tokio::select! {
        res = server_task => {
            match res {
                Ok(Ok(())) => ExitCode::SUCCESS,
                Ok(Err(e)) => {
                    tracing::event!(
                        name: "control_plane.serve.failed",
                        tracing::Level::ERROR,
                        error = %e,
                        "server error: {e}"
                    );
                    ExitCode::FAILURE
                }
                Err(e) => {
                    tracing::event!(
                        name: "control_plane.task.failed",
                        tracing::Level::ERROR,
                        error = %e,
                        "server task panicked or failed: {e}"
                    );
                    ExitCode::FAILURE
                }
            }
        }
        _ = tokio::signal::ctrl_c() => {
            println!("\nShutdown signal received; stopping inference engine...");
            ninfier_control::engine::stop_engine(&state_for_shutdown, None).await;
            println!("Control plane stopped.");
            ExitCode::SUCCESS
        }
    }
}
