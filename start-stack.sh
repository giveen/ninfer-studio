#!/usr/bin/env bash
# Launches the ninfier sidecar. If an inference engine is ALREADY listening on
# the configured port (e.g. started earlier on the host network namespace), the
# sidecar adopts it at startup (engineHealth check) and we skip a reload.
# Runs the sidecar on the host network namespace so its 127.0.0.1 reaches the
# engine (the harness sandbox gives background jobs an isolated loopback).
set -u
SIDECAR_DIR=/mnt/storage/Projects/ninfier-ui/apps/sidecar
LOG=/tmp/ninfier-stack.log
exec > "$LOG" 2>&1
echo "[stack] starting at $(date -Is)"

cd "$SIDECAR_DIR"
node server.js &
SIDECAR_PID=$!
echo "[stack] sidecar pid=$SIDECAR_PID"

for i in $(seq 1 60); do
  if curl -s -o /dev/null http://127.0.0.1:8787/health; then
    echo "[stack] sidecar health ok (${i} tries)"; break
  fi
  sleep 0.5
done

echo "[stack] pushing config"
curl -s -X POST http://127.0.0.1:8787/api/config -H 'content-type: application/json' \
  -d '{"ninferPath":"/mnt/storage/ninfer","modelsDir":"/mnt/storage/ninfer/models","enginePort":8080,"coderWorkspace":"/mnt/storage/Projects/ninfier-ui"}' >/dev/null

if curl -s -o /dev/null http://127.0.0.1:8080/health; then
  echo "[stack] engine already up on :8080 — adopting, no reload"
else
  echo "[stack] starting engine under sidecar"
  curl -s -X POST http://127.0.0.1:8787/api/engine/start -H 'content-type: application/json' \
    -d '{"profile":{"port":8080,"host":"127.0.0.1","modelId":"qwen-coder","maxContext":32768},"artifact":"/mnt/storage/ninfer/models/qwen3_8_27b_nvfp4.ninfer"}'
  echo
  for i in $(seq 1 300); do
    if curl -s -o /dev/null http://127.0.0.1:8080/health; then
      echo "[stack] engine up after ${i}s"; break
    fi
    sleep 1
  done
fi

echo "[stack] stack ready; waiting on sidecar pid=$SIDECAR_PID"
wait "$SIDECAR_PID"
echo "[stack] sidecar exited; shutting down"
