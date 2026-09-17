//! Engine process supervision: spawn / health-poll / stop / adopt-external.
//!
//! One file per concern:
//! discover - external ninfer-serve discovery (/proc, tasklist+netstat)
//! gpu      - VRAM accounting from the engine log
//! health   - /health + /v1/models probing, argv fallback
//! launch   - spawn / stop / signal + the public engine view
//! log      - per-port engine log files + size-cap rotation
//! status   - reconcile in-memory state with reality, adopt-external policy
//!
//! Directory Invariant (MUST be preserved across all module edits):
//!   Modules in `engine/` share the process slot (`state.child`), the per-port log file,
//!   and `state.engine`. Readers of engine state or log content MUST verify against the active
//!   run's identity (`spawn_epoch` on `EngineInner` or `ENGINE_START_MARKER` in log files)
//!   rather than assuming values in a slot or log file belong to the current run.
//!
//! Every router-facing entry point and shared type is re-exported here for `routes_engine.rs`,
//! `lib.rs`, and the `crate::engine::S` users in `coder/`.

// Rust guideline compliant 2026-07-28

use std::sync::Arc;

use crate::types::State;

pub type S = Arc<State>;

mod discover;
mod gpu;
mod health;
mod launch;
mod log;
mod status;

pub use discover::{DiscoveredEngine, discover_engines};
pub use gpu::{VRAM_FLOOR_GIB, vram_status};
pub use health::{engine_health, engine_model_info};
pub use launch::{fail_and_emit, public_engine, start_engine, stop_engine};
pub use status::refresh_engine_status;
