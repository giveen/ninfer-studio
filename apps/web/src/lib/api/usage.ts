// Usage tracking for the Engine → Usage tab. The control plane logs one
// event per proxied chat-completion request (see `usage.rs`) and folds the
// whole log on each call — there's no live/streaming aspect to this data, so
// unlike `useStatus` this fetches on demand rather than polling.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getJSON, postJSON } from './core';

export type UsageSource = 'all' | 'local' | 'remote';

export interface UsageDailyPoint {
  day: string;
  tokens: number;
  requests: number;
  cacheHitRate: number;
  /** Token count for that day, split by model — lets the trend chart stack
   *  bars per model instead of just showing the daily total. */
  models: Record<string, number>;
  /** GPU energy drawn that day while an engine was running, in kWh. */
  kwh: number;
  /** USD spent that day on cloud-model requests whose model has known
   *  pricing (see `AppSettings.cloudModelPricing`) — 0 when none of the
   *  day's requests matched a priced model (which may just mean no
   *  pricing data exists yet, not that they were free). */
  cloudCostUsd: number;
}

export interface UsageModelBreakdown {
  model: string;
  tokens: number;
  /** USD spent on this model, or null when it has no known pricing. */
  cloudCostUsd: number | null;
}

export interface UsageTotals {
  tokenUsage: number;
  requests: number;
  activeDays: number;
  avgCacheHitRate: number;
  mostUsedModel: string | null;
  /** Average prefill throughput (prompt tokens / prefill seconds) across
   *  streamed requests in the window; null when there's no timing data yet
   *  (pre-speed-tracking logs, or no streamed requests). */
  avgPrefillTps: number | null;
  /** Average generation throughput (completion tokens / decode seconds),
   *  same semantics as `avgPrefillTps`. */
  avgGenerationTps: number | null;
  /** Total GPU energy drawn while an engine was running, in kWh — not
   *  filtered by the source param (board power isn't attributable to
   *  local/remote traffic). */
  energyKwh: number;
  /** Total USD spent on cloud-model requests with known pricing this
   *  window, or null when no request in the window matched a priced model
   *  (distinct from 0 — "no pricing data" vs. "spent nothing"). */
  cloudCostUsd: number | null;
}

export interface UsageStats {
  totals: UsageTotals;
  dailySeries: UsageDailyPoint[];
  modelBreakdown: UsageModelBreakdown[];
}

export function getUsageStats(days: number, source: UsageSource): Promise<UsageStats> {
  return getJSON<UsageStats>(`/api/usage?days=${days}&source=${source}`, 8000);
}

/** Delete the usage log outright — irreversible, for starting a clean stats
 *  baseline (e.g. after a change expected to shift the numbers, so old and
 *  new behavior don't average together into a misleading figure). */
export function resetUsageStats(): Promise<{ ok: boolean; error?: string }> {
  return postJSON<{ ok: boolean; error?: string }>('/api/usage/reset', {}, 8000);
}

/** Fetch usage stats for `days`/`source`, refetching when either changes, plus
 *  a manual `refresh()` for the tab's Refresh button. */
export function useUsageStats(days: number, source: UsageSource) {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    getUsageStats(days, source)
      .then((s) => {
        if (id !== seq.current) return;
        setStats(s);
        setError(null);
      })
      .catch((e) => {
        if (id !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [days, source]);

  useEffect(() => {
    load();
  }, [load]);

  return { stats, error, loading, refresh: load };
}
