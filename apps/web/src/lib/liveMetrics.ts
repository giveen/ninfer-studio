import { useEffect, useState } from 'react';
import type { MessageMeta } from './types';

export const LIVE_METRICS_STALE_AFTER_MS = 15000;

export interface LiveRequestMetrics {
  meta: MessageMeta;
  model: string;
  at: number;
}

let latest: LiveRequestMetrics | null = null;
const listeners = new Set<(m: LiveRequestMetrics | null) => void>();

export function setLatestRequestMetrics(meta: MessageMeta, model: string): void {
  latest = { meta: { ...meta }, model, at: Date.now() };
  for (const l of listeners) l(latest);
}

export function clearLatestRequestMetrics(): void {
  latest = null;
  for (const l of listeners) l(latest);
}

export function getLatestRequestMetrics(): LiveRequestMetrics | null {
  return latest;
}

export function isLiveMetricsStale(m: LiveRequestMetrics | null, now = Date.now()): boolean {
  if (!m) return true;
  return now - m.at > LIVE_METRICS_STALE_AFTER_MS;
}

export function subscribeLatestRequestMetrics(cb: (m: LiveRequestMetrics | null) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useLatestRequestMetrics(): LiveRequestMetrics | null {
  const [metrics, setMetrics] = useState<LiveRequestMetrics | null>(latest);
  useEffect(() => subscribeLatestRequestMetrics(setMetrics), []);
  return metrics;
}
