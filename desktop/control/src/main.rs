//! Standalone control-plane binary: run the full HTTP control plane without
//! the Tauri window (dev mode, or a lightweight "just the server" mode).

fn main() {
    let port: u16 = std::env::var("NINFIER_STUDIO_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8787);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");
    rt.block_on(async {
        let state = ninfier_control::init_state(None).await;
        ninfier_control::boot_adopt(&state).await;
        if let Err(e) = ninfier_control::serve(state, port).await {
            eprintln!("[ninfier-control] server error: {e}");
            std::process::exit(1);
        }
    });
}
