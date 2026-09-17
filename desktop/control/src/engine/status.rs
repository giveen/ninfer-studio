//! Reconcile in-memory engine state with reality (health, child liveness, external adoption).
use super::discover::{DiscoveredEngine, discover_engines};
use super::health::{engine_health, engine_model_info};
use super::launch::{ENGINE_START_TIMEOUT_MS, start_timeout_message};
use super::log::log_path_for;
use crate::types::{AppEvent, EngineInner, EngineState, State, now_ms};

/// Emit desktop shell events (tray state + OS notifications) when state changes.
pub fn update_engine_state_and_emit(eng: &mut EngineInner, state: &State, new_state: EngineState) {
    let prev = eng.state;
    eng.state = new_state;
    if prev != new_state {
        match new_state {
            EngineState::Running => {
                let model = eng.model_id.clone();
                let port = eng.port.unwrap_or(8080);
                state.emit(AppEvent::EngineReady { model, port });
            }
            EngineState::Failed => {
                let reason = eng.fail_reason.clone();
                state.emit(AppEvent::EngineFailed { reason });
            }
            EngineState::Stopped => {
                state.emit(AppEvent::EngineStopped);
            }
            _ => {}
        }
    }
}

/// Reconcile in-memory state with reality (health, child liveness, external adoption).
/// Gathers health and process discovery facts outside of the engine write lock.
pub async fn refresh_engine_status(state: &State) {
    let has_child = match state.child.try_lock() {
        Ok(g) => g.is_some(),
        Err(_) => true,
    };

    let (prev_state, port_opt, has_model) = {
        let eng = state.engine.read().await;
        (eng.state, eng.port, eng.model_id.is_some())
    };

    let cfg_port = state.config.read().await.engine_port;
    let port = port_opt.unwrap_or(cfg_port);

    // 1) Probe health outside engine write lock
    let is_healthy = engine_health(state, port).await;
    let is_cfg_healthy = if port != cfg_port {
        engine_health(state, cfg_port).await
    } else {
        is_healthy
    };

    // 2) Gather discovery & model info outside engine write lock if healthy
    let (disc_engines, model_info) = if is_healthy || is_cfg_healthy {
        let all = discover_engines().await;
        let info = if !has_model {
            engine_model_info(state, if is_healthy { port } else { cfg_port }).await
        } else {
            (None, None)
        };
        (Some(all), info)
    } else {
        (None, (None, None))
    };

    // 3) Apply state transitions atomically under lock (< 1ms lock duration)
    let mut eng = state.engine.write().await;

    if has_child {
        if let Some(_port) = eng.port {
            if is_healthy {
                if eng.state != EngineState::Running {
                    update_engine_state_and_emit(&mut eng, state, EngineState::Running);
                }
                if eng.model_id.is_none() {
                    eng.assign_model_info(model_info.0.clone(), model_info.1);
                }
            } else if eng.state == EngineState::Starting && eng.deadline.is_none() {
                eng.deadline = Some(now_ms() + ENGINE_START_TIMEOUT_MS);
            }
        }
    } else if eng.state == EngineState::Starting || eng.state == EngineState::Running {
        eng.mark_exited();
        state.emit(AppEvent::EngineStopped);
    }

    if eng.state == EngineState::Starting
        && let Some(deadline) = eng.deadline
        && now_ms() > deadline
    {
        let msg = start_timeout_message();
        eng.mark_failed(msg.clone());
        state.emit(AppEvent::EngineFailed { reason: Some(msg) });
    }

    if eng.state == EngineState::Stopped {
        if let Some(port) = eng.port {
            if is_healthy {
                if let Some(ref all) = disc_engines {
                    apply_adopt_external(&mut eng, &state.data_dir, port, all, cfg_port, model_info.clone());
                    update_engine_state_and_emit(&mut eng, state, EngineState::Running);
                }
            }
        }
    } else if eng.state == EngineState::Failed && !has_child {
        let adopt_port = if port != cfg_port && is_cfg_healthy {
            Some(cfg_port)
        } else if is_healthy {
            Some(port)
        } else {
            None
        };
        if let Some(ap) = adopt_port {
            if let Some(ref all) = disc_engines {
                apply_adopt_external(&mut eng, &state.data_dir, ap, all, cfg_port, model_info.clone());
                update_engine_state_and_emit(&mut eng, state, EngineState::Running);
            }
        }
    } else if eng.state == EngineState::External && let Some(port) = eng.port {
        if is_healthy {
            if let Some(ref all) = disc_engines {
                eng.pid = resolve_external_pid(all, Some(port), cfg_port);
            }
            if eng.model_id.is_none() {
                eng.assign_model_info(model_info.0, model_info.1);
            }
        } else {
            eng.reset_stopped();
            eng.argv = None;
            state.emit(AppEvent::EngineStopped);
        }
    }

    let new_state = eng.state;
    if new_state != prev_state {
        match new_state {
            EngineState::Running => {
                let model = eng.model_id.clone();
                let port = eng.port.unwrap_or(8080);
                state.emit(AppEvent::EngineReady { model, port });
            }
            EngineState::Failed => {
                let reason = eng.fail_reason.clone();
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
pub fn resolve_external_pid(
    all: &[DiscoveredEngine],
    port: Option<u16>,
    cfg_port: u16,
) -> Option<u32> {
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

/// Pure in-memory external engine adoption helper.
pub fn apply_adopt_external(
    eng: &mut EngineInner,
    data_dir: &std::path::Path,
    port: u16,
    all: &[DiscoveredEngine],
    cfg_port: u16,
    model_info: (Option<String>, Option<u64>),
) {
    let disc = all.iter().find(|d| d.port == Some(port));
    eng.state = EngineState::External;
    eng.adopted = true;
    eng.port = Some(port);
    eng.pid = resolve_external_pid(all, Some(port), cfg_port);
    eng.argv = disc.map(|d| d.argv.clone());
    eng.artifact = disc
        .and_then(|d| d.artifact.clone())
        .or_else(|| eng.artifact.clone());
    if model_info.0.is_some() || model_info.1.is_some() {
        eng.assign_model_info(model_info.0, model_info.1);
    }
    eng.deadline = None;
    eng.fail_reason = None;
    eng.log_path = Some(log_path_for(data_dir, port));
}

/// The single adopt-external-engine path, used by boot/refresh (stopped or
/// failed state with a live port) and by start (port already serving).
/// Records the discovered pid/argv/artifact for `port`, probes model info,
/// and points the log at the shared per-port file.
pub async fn adopt_external(eng: &mut EngineInner, state: &State, port: u16) {
    let all = discover_engines().await;
    let cfg_port = state.config.read().await.engine_port;
    let model_info = engine_model_info(state, port).await;
    apply_adopt_external(eng, &state.data_dir, port, &all, cfg_port, model_info);
}

#[cfg(test)]
mod adopt_policy_tests {
    use super::*;

    fn disc(pid: u32, port: Option<u16>) -> DiscoveredEngine {
        DiscoveredEngine {
            pid,
            port,
            start_time: None,
            argv: vec![],
            artifact: None,
        }
    }

    #[test]
    fn same_port_wins_and_cross_port_is_never_picked() {
        let all = vec![disc(111, Some(8080)), disc(222, Some(9091))];
        assert_eq!(resolve_external_pid(&all, Some(8080), 8080), Some(111));
        assert_eq!(resolve_external_pid(&all, Some(9091), 8080), Some(222));
        assert_eq!(resolve_external_pid(&all, Some(1234), 8080), None);
    }

    #[test]
    fn portless_fallback_only_on_the_configured_port() {
        let all = vec![disc(111, Some(9091)), disc(333, None)];
        assert_eq!(resolve_external_pid(&all, Some(8080), 8080), Some(333));
        assert_eq!(resolve_external_pid(&all, Some(1234), 8080), None);
        let both = vec![disc(111, Some(8080)), disc(333, None)];
        assert_eq!(resolve_external_pid(&both, Some(8080), 8080), Some(111));
    }

    #[test]
    fn apply_adopt_external_updates_in_memory_state() {
        let mut eng = EngineInner::default();
        let data_dir = std::path::Path::new("/tmp/test-data");
        let all = vec![disc(1234, Some(8080))];
        apply_adopt_external(
            &mut eng,
            data_dir,
            8080,
            &all,
            8080,
            (Some("qwen2.5".to_string()), Some(32768)),
        );
        assert_eq!(eng.state, EngineState::External);
        assert!(eng.adopted);
        assert_eq!(eng.pid, Some(1234));
        assert_eq!(eng.port, Some(8080));
        assert_eq!(eng.model_id, Some("qwen2.5".to_string()));
        assert_eq!(eng.max_context, Some(32768));
        assert!(eng.fail_reason.is_none());
        assert!(eng.deadline.is_none());
    }

    #[test]
    fn engine_state_wire_format_keeps_lowercase_strings() {
        let s = serde_json::to_value(crate::types::EngineState::External).unwrap();
        assert_eq!(s, serde_json::Value::String("external".into()));
        for (state, wire) in [
            (crate::types::EngineState::Stopped, "stopped"),
            (crate::types::EngineState::Starting, "starting"),
            (crate::types::EngineState::Running, "running"),
            (crate::types::EngineState::Stopping, "stopping"),
            (crate::types::EngineState::Failed, "failed"),
        ] {
            assert_eq!(
                serde_json::to_value(state).unwrap(),
                serde_json::Value::String(wire.into())
            );
        }
    }
}
