import { useEffect, useState } from 'react';
import { getLogs } from './api';

// One shared tail of the engine log. Both the Engine screen's embedded pane
// and the dedicated Log tab subscribe here, so the app runs a SINGLE
// /api/logs poll (every 2s) no matter how many log panes are mounted —
// App keeps all screens mounted (hidden), so per-component polls would
// double the indefinite log reads.
const INTERVAL_MS = 2000;
const N = 1000;

let lines: string[] = [];
let listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

async function tick() {
  if (inFlight) return; // never stack polls on a slow sidecar
  inFlight = (async () => {
    try {
      const r = await getLogs(N);
      lines = r.lines;
      listeners.forEach((l) => l());
    } catch {
      /* sidecar busy — keep the last good tail */
    } finally {
      inFlight = null;
    }
  })();
}

/** Subscribe to the shared engine-log tail. Polling starts with the first
 *  subscriber and stops when the last one unmounts. */
export function useEngineLogs(): string[] {
  const [v, setV] = useState(lines);
  useEffect(() => {
    const notify = () => setV(lines);
    listeners.add(notify);
    if (!timer) {
      tick();
      timer = setInterval(tick, INTERVAL_MS);
    }
    return () => {
      listeners.delete(notify);
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return v;
}
