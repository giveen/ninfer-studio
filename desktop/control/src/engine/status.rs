//! Reconcile in-memory engine state with reality (health, child liveness, external adoption).
use crate::types::{AppEvent, EngineInner, EngineState, State, now_ms};
use super::discover::{DiscoveredEngine, discover_engines};
use super::health::{engine_health, engine_model_info};
use super::launch::{ENGINE_START_TIMEOUT_MS, start_timeout_message};
use super::log::log_path_for;

/// Reconcile in-memory state with reality (health, child liveness, external adoption).
pub async fn refresh_engine_status(state: &State) {
    // Liveness of a Studio-spawned child: the slot is occupied while the process
    // is alive (the reaper only clears it on actual exit). Treat a briefly-busy
    // lock as "alive" so a refresh racing the reaper's poll never flips the
    // engine to failed/external.
    let has_child = match state.child.try_lock() {
        Ok(g) => g.is_some(),
        Err(_) => true,
    };
    let mut eng = state.engine.write().await;
    let prev_state = eng.state;

    if has_child {
        if let Some(port) = eng.port {
            if engine_health(port).await {
                if eng.state != EngineState::Running {
                    eng.state = EngineState::Running;
                    if eng.model_id.is_none() {
                        let (mid, mctx) = engine_model_info(state, port).await;
                        eng.assign_model_info(mid, mctx);
                    }
                }
            } else if eng.state == EngineState::Starting && eng.deadline.is_none() {
                eng.deadline = Some(now_ms() + ENGINE_START_TIMEOUT_MS);
            }
        }
    } else if eng.state == EngineState::Starting || eng.state == EngineState::Running {
        eng.mark_exited();
    }

    if eng.state == EngineState::Starting
        && let Some(deadline) = eng.deadline
        && now_ms() > deadline
    {
        eng.mark_failed(start_timeout_message());
    }

    if eng.state == EngineState::Stopped {
        if let Some(port) = eng.port
            && engine_health(port).await
        {
            adopt_external(&mut eng, state, port).await;
        }
    } else if eng.state == EngineState::Failed && !has_child {
        // a failed spawn must not mask a live engine: if the spawn targeted a
        // non-configured port and the configured port serves, restore its view
        let cfg_port = state.config.read().await.engine_port;
        let port = if eng.port != Some(cfg_port) && engine_health(cfg_port).await {
            Some(cfg_port)
        } else {
            eng.port
        };
        if let Some(port) = port
            && engine_health(port).await
        {
            adopt_external(&mut eng, state, port).await;
        }
    } else if eng.state == EngineState::External
        && let Some(port) = eng.port
    {
        if engine_health(port).await {
            // keep pid fresh (the external process may restart) — same-port
            // policy as adoption, never a cross-port pid.
            let all = discover_engines().await;
            let cfg_port = state.config.read().await.engine_port;
            if let Some(p) = resolve_external_pid(&all, Some(port), cfg_port) {
                eng.pid = Some(p);
            }
            if eng.model_id.is_none() {
                let (mid, mctx) = engine_model_info(state, port).await;
                eng.assign_model_info(mid, mctx);
            }
        } else {
            eng.reset_stopped();
            eng.argv = None;
        }
    }

    // Edge-triggered desktop-shell events (tray state + OS notifications).
    let new_state = eng.state;
    drop(eng);
    if new_state != prev_state {
        match new_state {
            EngineState::Running => {
                let model = state.engine.read().await.model_id.clone();
                let port = state.config.read().await.engine_port;
                state.emit(AppEvent::EngineReady { model, port });
            }
            EngineState::Failed => {
                let reason = state.engine.read().await.fail_reason.clone();
                state.emit(AppEvent::EngineFailed { reason });
            }
            EngineState::Stopped => {
                state.emit(AppEvent::EngineStopped);
            }
            _ => {}
        }
    }
}

/// Cross-port fallback policy (ONE place — adopt and stop share it): the pid
/// recorded/signaled for a port is the process discovered ON that port. The
/// only fallback is a portless discovery (listener unattributable, e.g.
/// netstat failed) and only when the port is the configured default — never
/// a process bound to a *different* port, which would record (and later let
/// Stop kill) somebody else's engine.
pub fn resolve_external_pid(all: &[DiscoveredEngine], port: Option<u16>, cfg_port: u16) -> Option<u32> {
    all.iter()
        .find(|d| d.port == port)
        .map(|d| d.pid)
        .or_else(|| {
            if port == Some(cfg_port) {
                all.iter().find(|d| d.port.is_none()).map(|d| d.pid)
            } else {
                None
            }
        })
}

/// The single adopt-external-engine path, used by boot/refresh (stopped or
/// failed state with a live port) and by start (port already serving).
/// Records the discovered pid/argv/artifact for `port`, probes model info,
/// and points the log at the shared per-port file.
pub async fn adopt_external(eng: &mut EngineInner, state: &State, port: u16) {
    let all = discover_engines().await;
    let cfg_port = state.config.read().await.engine_port;
    let disc = all.iter().find(|d| d.port == Some(port));
    eng.state = EngineState::External;
    eng.adopted = true;
    eng.port = Some(port);
    eng.pid = resolve_external_pid(&all, Some(port), cfg_port);
    eng.argv = disc.map(|d| d.argv.clone());
    eng.artifact = eng.artifact.clone().or_else(|| disc.and_then(|d| d.artifact.clone()));
    let (mid, mctx) = engine_model_info(state, port).await;
    eng.assign_model_info(mid, mctx);
    eng.fail_reason = None;
    eng.log_path = Some(log_path_for(&state.data_dir, port));
}

#[cfg(test)]
mod adopt_policy_tests {
    use super::{resolve_external_pid, DiscoveredEngine};

    fn disc(pid: u32, port: Option<u16>) -> DiscoveredEngine {
        DiscoveredEngine { pid, port, argv: vec![], artifact: None }
    }

    #[test]
    fn same_port_wins_and_cross_port_is_never_picked() {
        // Two engines on two ports: adopting/stopping 8080 must resolve 111,
        // never 222 — the old start_engine copy fell back to first().
        let all = vec![disc(111, Some(8080)), disc(222, Some(9091))];
        assert_eq!(resolve_external_pid(&all, Some(8080), 8080), Some(111));
        assert_eq!(resolve_external_pid(&all, Some(9091), 8080), Some(222));
        // Unknown port with a foreign engine present: no fallback.
        assert_eq!(resolve_external_pid(&all, Some(1234), 8080), None);
    }

    #[test]
    fn portless_fallback_only_on_the_configured_port() {
        let all = vec![disc(111, Some(9091)), disc(333, None)];
        // Default port, listener unattributable: portless pid is usable.
        assert_eq!(resolve_external_pid(&all, Some(8080), 8080), Some(333));
        // Non-default port: the portless process must not be claimed.
        assert_eq!(resolve_external_pid(&all, Some(1234), 8080), None);
        // Exact match beats the portless fallback even on the default port.
        let both = vec![disc(111, Some(8080)), disc(333, None)];
        assert_eq!(resolve_external_pid(&both, Some(8080), 8080), Some(111));
    }

    #[test]
    fn engine_state_wire_format_keeps_lowercase_strings() {
        // P0-3: the enum must serialize to exactly what the web UI matches on.
        let s = serde_json::to_value(crate::types::EngineState::External).unwrap();
        assert_eq!(s, serde_json::Value::String("external".into()));
        for (state, wire) in [
            (crate::types::EngineState::Stopped, "stopped"),
            (crate::types::EngineState::Starting, "starting"),
            (crate::types::EngineState::Running, "running"),
            (crate::types::EngineState::Stopping, "stopping"),
            (crate::types::EngineState::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), serde_json::Value::String(wire.into()));
        }
    }
}

