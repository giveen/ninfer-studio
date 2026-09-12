//! Engine process supervision: spawn / health-poll / stop / adopt-external.
//!
//! One file per concern:
//! health - /health + /v1/models probing, argv fallback
//! discover - external ninfer-serve discovery (/proc, tasklist+netstat)
//! status - reconcile in-memory state with reality, adopt-external policy
//! log - per-port engine log files + size-cap rotation
//! gpu - VRAM accounting from the engine log
//! launch - spawn / stop / signal + the public engine view
//!
//! Every public handler/type is re-exported here so `lib.rs` (and the
//! `crate::engine::S` users in `coder/`) keep using `engine::...` paths
//! unchanged.

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

pub use discover::{DiscoveredEngine, discover_engines, find_external_serve_pids};
pub use gpu::{VRAM_FLOOR_GIB, vram_status};
pub use health::{engine_health, engine_model_info};
pub use launch::{fail_and_emit, public_engine, start_engine, stop_engine};
pub use status::refresh_engine_status;
