# Desktop Subsystem Agent Instructions (`desktop`)

These instructions apply to all Rust development within the Cargo workspace under `desktop/` (`ninfier-studio` and `ninfier-control`).

## Workspace Structure

- `desktop/app` (`ninfier-studio`): Tauri 2 desktop application binary.
- `desktop/control` (`ninfier-control`): Local inference engine daemon service.

## Rust & Tauri Coding Guidelines

1. **Async & Tokio Safety**:
   - Never perform blocking thread synchronization (e.g., `std::thread::sleep`, `std::sync::Mutex` held across await points) on Tokio runtime worker threads.
   - Use `tokio::sync` primitives for async locking and channels.

2. **Data & Storage Paths**:
   - Always respect `NINFIER_STUDIO_DATA` environment variable configurations (defaulting to `$PWD/data`).
   - Do not hardcode absolute storage paths or write temporary engine states outside the designated data directory.

3. **Workspace Lints & Error Handling**:
   - Maintain workspace lint requirements specified in `desktop/Cargo.toml` (`undocumented_unsafe_blocks`, `missing_debug_implementations`, etc.).
   - Return structured JSON error objects across Tauri IPC command boundaries instead of raw panics or plain unformatted strings.

## Local Validation

Run targeted Cargo validation commands for backend changes:

```bash
# Check control daemon
cargo check --manifest-path desktop/Cargo.toml -p ninfier-control

# Check Tauri studio app
cargo check --manifest-path desktop/Cargo.toml -p ninfier-studio

# Run control daemon tests
cargo test --manifest-path desktop/Cargo.toml -p ninfier-control
```
