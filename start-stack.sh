#!/usr/bin/env bash
# Launches the ninfier control plane (Rust). If an inference engine is ALREADY listening on
# the configured port (e.g. started earlier on the host network namespace), the
# control plane adopts it at startup (engineHealth check) and we skip a reload.
# Runs the control plane on the host network namespace so its 127.0.0.1 reaches the
# engine (the harness sandbox gives background jobs an isolated loopback).
#
# No machine-specific paths are baked in — everything comes from the
# environment, and settings persist in config.json after the first run:
#   NINFER_DIR       engine checkout (optional; seeds config)
#   MODELS_DIR       models dir      (default: $NINFER_DIR/models)
#   CODER_WORKSPACE  Coder workspace (optional; seeds config)
#   ARTIFACT         .ninfer artifact to auto-start (optional)
#   ENGINE_PORT      engine port     (default: 8080)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTROL_BIN="$ROOT/desktop/target/debug/ninfier-control"
ENGINE_PORT="${ENGINE_PORT:-8080}"
LOG=/tmp/ninfier-stack.log
exec > "$LOG" 2>&1
echo "[stack] starting at $(date -Is)"

if [ ! -x "$CONTROL_BIN" ]; then
  echo "[stack] building control plane (one-time)"
  cargo build --manifest-path "$ROOT/desktop/Cargo.toml" -p ninfier-control || exit 1
fi

export NINFIER_STUDIO_DATA="${NINFIER_STUDIO_DATA:-$ROOT/data}"
export NINFIER_STUDIO_PORT=8787
"$CONTROL_BIN" &
CONTROL_PID=$!
echo "[stack] control plane pid=$CONTROL_PID"

for i in $(seq 1 60); do
  if curl -s -o /dev/null http://127.0.0.1:8787/health; then
    echo "[stack] control plane health ok (${i} tries)"; break
  fi
  sleep 0.5
done

if [ -n "${NINFER_DIR:-}" ]; then
  MODELS_DIR="${MODELS_DIR:-$NINFER_DIR/models}"
  echo "[stack] pushing config"
  curl -s -X POST http://127.0.0.1:8787/api/config -H 'content-type: application/json' \
    -d "$(printf '{"ninferPath":"%s","modelsDir":"%s","enginePort":%s,"coderWorkspace":"%s"}' \
      "$NINFER_DIR" "$MODELS_DIR" "$ENGINE_PORT" "${CODER_WORKSPACE:-}")" >/dev/null
else
  echo "[stack] NINFER_DIR not set — keeping existing config.json"
fi

if curl -s -o /dev/null http://127.0.0.1:$ENGINE_PORT/health; then
  echo "[stack] engine already up on :$ENGINE_PORT — adopting, no reload"
else
  if [ -n "${ARTIFACT:-}" ]; then
    echo "[stack] starting engine under control plane"
    curl -s -X POST http://127.0.0.1:8787/api/engine/start -H 'content-type: application/json' \
      -d "$(printf '{"profile":{"port":%s,"host":"127.0.0.1","modelId":"qwen-coder","maxContext":32768},"artifact":"%s"}' \
        "$ENGINE_PORT" "$ARTIFACT")"
    echo
    for i in $(seq 1 300); do
      if curl -s -o /dev/null http://127.0.0.1:$ENGINE_PORT/health; then
        echo "[stack] engine up after ${i}s"; break
      fi
      sleep 1
    done
  else
    echo "[stack] no ARTIFACT set and no engine on :$ENGINE_PORT — start one from the UI"
  fi
fi

echo "[stack] stack ready; waiting on control plane pid=$CONTROL_PID"
wait "$CONTROL_PID"
echo "[stack] control plane exited; shutting down"
