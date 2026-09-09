// Shared, in-memory store for the most recent chat request's engine metrics
// (TTFT / prompt+decode tok/s / draft acceptance). ChatScreen writes here as
// each request finishes; the Engine panel reads it to show live token metrics
// on its Status card. This is the engine's own authoritative metric (from the
// SSE `timings`/`usage` payload), not a scrape of the engine log.

import type { MessageMeta } from './types';

export interface LiveRequestMetrics {
  meta: MessageMeta;
  model: string;
  at: number;
}

let latest: LiveRequestMetrics | null = null;
const listeners = new Set<(m: LiveRequestMetrics | null) => void>();

export function setLatestRequestMetrics(meta: MessageMeta, model: string): void {
  latest = { meta, model, at: Date.now() };
  for (const l of listeners) l(latest);
}

export function getLatestRequestMetrics(): LiveRequestMetrics | null {
  return latest;
}

export function subscribeLatestRequestMetrics(cb: (m: LiveRequestMetrics | null) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
