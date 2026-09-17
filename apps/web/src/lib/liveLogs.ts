import { useEffect, useState } from 'react';
import { getLogs } from './api';

/** Number of log lines requested per tail poll. */
export const LOG_TAIL_LINES = 1000;
const INTERVAL_MS = 2000;
const STALE_THRESHOLD_MS = 6000;

export interface EngineLogsState {
  lines: string[];
  size: number;
  lastOkAt: number | null;
  error: string | null;
  isStale: boolean;
}

let lines: string[] = [];
let lastSize = -1;
let lastOkAt: number | null = null;
let lastError: string | null = null;
let listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

export function getLogsState(): EngineLogsState {
  const isStale = lastOkAt !== null && Date.now() - lastOkAt > STALE_THRESHOLD_MS;
  return {
    lines,
    size: Math.max(0, lastSize),
    lastOkAt,
    error: lastError,
    isStale: isStale || lastError !== null,
  };
}

async function tick() {
  if (inFlight) return; // never stack polls on a slow control plane
  if (typeof document !== 'undefined' && document.hidden) return; // pause when tab is hidden
  inFlight = (async () => {
    try {
      const r = await getLogs(LOG_TAIL_LINES);
      lastOkAt = Date.now();
      lastError = null;
      if (r.size === lastSize) return; // no new content appended -> skip re-render notify
      lastSize = r.size;
      lines = r.lines;
      listeners.forEach((l) => l());
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'Control plane busy';
      listeners.forEach((l) => l());
    } finally {
      inFlight = null;
    }
  })();
}

/** Subscribe to the shared engine-log tail. Polling starts with the first
 *  subscriber and stops when the last one unmounts. */
export function useEngineLogs(): string[] & EngineLogsState {
  const [state, setState] = useState<EngineLogsState>(getLogsState);

  useEffect(() => {
    const notify = () => setState(getLogsState());
    listeners.add(notify);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void tick();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    if (!timer) {
      void tick();
      timer = setInterval(tick, INTERVAL_MS);
    }

    return () => {
      listeners.delete(notify);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);

  return Object.assign([...state.lines], state);
}
