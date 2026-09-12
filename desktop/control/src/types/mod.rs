//! Shared types for the NInfer Studio control plane.
//! Field names mirror the web app's TypeScript types 1:1 (camelCase JSON).
//!
//! One file per concern:
//! settings - AppSettings, EngineProfile, NumberOrAuto (+ debug-redaction tests)
//! serve_args - build_serve_args/args_equal (+ fixture parity tests)
//! domain - wire domain types: engine/gpu/model/job/catalog
//! state - runtime State, EngineInner, AppEvent
//! util - small string/path/time helpers
//!
//! Every public item is re-exported here so `crate::types::...` paths
//! across the crate keep working unchanged.

// Rust guideline compliant 2026-07-28

mod domain;
mod serve_args;
mod settings;
mod state;
mod util;

pub use domain::{CatalogEntry, EngineState, EngineStatus, GpuApp, GpuStats, JobRec, ModelArtifact, ARTIFACTS};
pub use serve_args::{args_equal, build_serve_args};
pub use settings::{AppSettings, EngineProfile, NumberOrAuto};
pub use state::{AppEvent, EngineInner, LastStart, ProfileState, SavedProfile, State};
pub use util::{base_name, now_ms, strip_extended_prefix};
