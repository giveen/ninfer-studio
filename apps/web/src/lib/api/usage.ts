// Usage tracking for the Engine → Usage tab. The control plane logs one
// event per proxied chat-completion request (see `usage.rs`) and folds the
// whole log on each call — there's no live/streaming aspect to this data, so
// unlike `useStatus` this fetches on demand rather than polling.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getJSON } from './core';

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
}

export interface UsageModelBreakdown {
  model: string;
  tokens: number;
}

export interface UsageTotals {
  tokenUsage: number;
  requests: number;
  activeDays: number;
  avgCacheHitRate: number;
  mostUsedModel: string | null;
  /** Total GPU energy drawn while an engine was running, in kWh — not
   *  filtered by the source param (board power isn't attributable to
   *  local/remote traffic). */
  energyKwh: number;
}

export interface UsageStats {
  totals: UsageTotals;
  dailySeries: UsageDailyPoint[];
  modelBreakdown: UsageModelBreakdown[];
}

export function getUsageStats(days: number, source: UsageSource): Promise<UsageStats> {
  return getJSON<UsageStats>(`/api/usage?days=${days}&source=${source}`, 8000);
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
