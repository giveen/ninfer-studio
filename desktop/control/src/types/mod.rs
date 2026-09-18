//! Shared types for the NInfer Studio control plane.
//! Field names mirror the web app's TypeScript types 1:1 (camelCase JSON).
//!
//! One file per concern:
//! settings - AppSettings, EngineProfile, McpServerSpec, ModelPricing, NumberOrAuto (+ debug-redaction tests)
//! serve_args - build_serve_args, args_equal (+ fixture parity tests)
//! domain - wire domain types: ARTIFACTS, CatalogEntry, EngineState, EngineStatus, GpuApp, GpuStats, JobRec, ModelArtifact
//! state - runtime State, EngineInner, AppEvent, LastStart, ProfileState, SavedProfile
//! util - small string/path/time helpers: base_name, now_ms, strip_extended_prefix
//!
//! Every public item is re-exported here so `crate::types::...` paths
//! across the crate keep working unchanged.

mod domain;
mod serve_args;
mod settings;
mod state;
mod util;

pub use domain::*;
pub use serve_args::*;
pub use settings::*;
pub use state::*;
pub use util::*;
