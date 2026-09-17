import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button, SectionCard, Segmented, Stat } from '../../components/ui';
import { formatTokens } from '../../lib/format';
import { getConfig } from '../../lib/api';
import { useUsageStats, resetUsageStats, type UsageDailyPoint, type UsageSource } from '../../lib/api/usage';

// `Segmented`'s value type is constrained to `string`, so the range lives as
// strings here and is parsed back to a number for the API call.
type RangeDays = '7' | '14' | '30' | '90';
const RANGE_OPTIONS: Array<{ value: RangeDays; label: string }> = [
  { value: '7', label: '7d' },
  { value: '14', label: '14d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
];

const SOURCE_OPTIONS: Array<{ value: UsageSource; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'local', label: 'Local' },
  { value: 'remote', label: 'Remote' },
];

// Cycled across the model-usage donut slices and referenced by the chart's
// bar/line — the app's semantic theme tokens, so this stays on-palette and
// theme-aware (dark/light) without hardcoding hex.
const SERIES_COLORS = [
  'var(--color-accent)',
  'var(--color-info)',
  'var(--color-ok)',
  'var(--color-warn)',
  'var(--color-danger)',
  'var(--color-mute)',
];

/** Cost/1M tokens is routinely a fraction of a cent — a fixed 2 decimals
 *  rounds it straight to "$0.00" and hides the number entirely. Starts at 4
 *  decimals and grows (up to 8) only if the value would still round to
 *  zero, so both everyday and very cheap rates stay legible. */
function formatSmallCost(v: number): string {
  if (v === 0) return (0).toFixed(4);
  let decimals = 4;
  while (decimals < 8 && Number(v.toFixed(decimals)) === 0) decimals++;
  return v.toFixed(decimals);
}

/** Every calendar day in the last `days` days (UTC, oldest first), so the
 *  heatmap/trend show gaps as zero instead of skipping them. */
function fillDailySeries(series: UsageDailyPoint[], days: number): UsageDailyPoint[] {
  const byDay = new Map(series.map((d) => [d.day, d]));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const out: UsageDailyPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, tokens: 0, requests: 0, cacheHitRate: null, models: {}, kwh: 0, cloudCostUsd: 0 });
  }
  return out;
}

/** Arrange a filled daily series into Sunday-first weekly columns (padding
 *  the first column with nulls) for the GitHub-style activity heatmap. */
function toHeatmapWeeks(filled: UsageDailyPoint[]): Array<Array<UsageDailyPoint | null>> {
  if (!filled.length) return [];
  const firstDow = new Date(`${filled[0].day}T00:00:00Z`).getUTCDay();
  const padded: Array<UsageDailyPoint | null> = [...Array(firstDow).fill(null), ...filled];
  const weeks: Array<Array<UsageDailyPoint | null>> = [];
  for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));
  return weeks;
}

function heatCellClass(count: number, max: number): string {
  if (count <= 0) return 'bg-inset';
  const share = max > 0 ? count / max : 0;
  if (share > 0.75) return 'bg-accent';
  if (share > 0.5) return 'bg-accent/70';
  if (share > 0.25) return 'bg-accent/40';
  return 'bg-accent/20';
}

export function UsageTrackerTab({ active = true }: { active?: boolean }) {
  const [rangeDays, setRangeDays] = useState<RangeDays>('30');
  const [source, setSource] = useState<UsageSource>('all');
  const days = Number(rangeDays);
  const { stats, error, loading, refresh } = useUsageStats(days, source);

  const filled = useMemo(() => fillDailySeries(stats?.dailySeries ?? [], days), [stats, days]);
  const weeks = useMemo(() => toHeatmapWeeks(filled), [filled]);
  const maxRequests = useMemo(() => Math.max(0, ...filled.map((d) => d.requests)), [filled]);
  const modelBreakdown = stats?.modelBreakdown ?? [];
  const totalModelTokens = modelBreakdown.reduce((sum, m) => sum + m.tokens, 0);
  // Same model → color assignment as the donut below, so a model reads as
  // the same color in both charts.
  const modelColor = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];
  // Flatten each day's per-model split to top-level keys so recharts can
  // stack one `<Bar>` per model.
  const chartRows = useMemo(() => filled.map((d) => ({ day: d.day, cacheHitRate: d.cacheHitRate, ...d.models })), [filled]);

  const totals = stats?.totals;
  const cacheHitPct = totals ? `${(totals.avgCacheHitRate * 100).toFixed(1)}%` : '—';
  // Speed stats are weighted averages over streamed requests only; null until
  // the window has timing data (older log lines carry none).
  const fmtTps = (tps: number | null | undefined) => (tps != null ? `${Math.round(tps).toLocaleString()} tok/s` : '—');

  // Cost isn't in the usage payload itself — it's local-only math over the
  // reported energy and whatever rate the user configured in Settings. Kept
  // in step with a Settings save elsewhere (this screen stays mounted, so a
  // one-shot fetch on mount would otherwise go stale) by refetching whenever
  // the user hits Refresh, not just once.
  const [currencySymbol, setCurrencySymbol] = useState('$');
  const [costPerKwh, setCostPerKwh] = useState(0);
  const loadCostConfig = () => {
    getConfig()
      .then((c) => {
        setCurrencySymbol(c.currencySymbol || '$');
        setCostPerKwh(c.costPerKwh || 0);
      })
      .catch(() => undefined);
  };
  useEffect(loadCostConfig, []);
  const refreshAll = () => {
    refresh();
    loadCostConfig();
  };

  const prevActiveRef = useRef(false);
  useEffect(() => {
    if (active && !prevActiveRef.current) {
      refreshAll();
    }
    prevActiveRef.current = active;
  }, [active]);

  const estCost = totals ? totals.energyKwh * costPerKwh : 0;
  const costPerMillionTokens = totals && costPerKwh > 0 && totals.tokenUsage > 0 ? (estCost / totals.tokenUsage) * 1_000_000 : null;

  // Reset is a two-click confirm (no modal needed for a single irreversible
  // action): the first click arms it and auto-disarms after a few seconds
  // if the user doesn't follow through, so a stray click can't wipe the log.
  const [resetArmed, setResetArmed] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (armTimerRef.current) clearTimeout(armTimerRef.current); }, []);
  const handleResetClick = () => {
    if (!resetArmed) {
      setResetArmed(true);
      setResetError(null);
      armTimerRef.current = setTimeout(() => setResetArmed(false), 4000);
      return;
    }
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    setResetArmed(false);
    setResetting(true);
    setResetError(null);
    resetUsageStats()
      .then((r) => {
        if (!r.ok) throw new Error(r.error || 'Reset failed');
        refreshAll();
      })
      .catch((e) => setResetError(e instanceof Error ? e.message : String(e)))
      .finally(() => setResetting(false));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={rangeDays} onChange={setRangeDays} options={RANGE_OPTIONS} />
          <Segmented value={source} onChange={setSource} options={SOURCE_OPTIONS} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={resetArmed ? 'danger' : 'ghost'}
            onClick={handleResetClick}
            disabled={resetting}
            className="border border-line/60"
            title="Delete all logged usage history and start fresh"
          >
            <Trash2 size={13} />
            {resetting ? 'Resetting…' : resetArmed ? 'Confirm reset?' : 'Reset stats'}
          </Button>
          <Button onClick={refreshAll} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
            Refresh
          </Button>
        </div>
      </div>

      {resetError && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          Failed to reset usage stats: {resetError}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-[13px] text-danger">
          Failed to load usage stats: {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Token usage" value={totals ? totals.tokenUsage.toLocaleString() : '—'} />
        <Stat label="Requests" value={totals ? totals.requests.toLocaleString() : '—'} />
        <Stat label="Active days" value={totals ? totals.activeDays.toLocaleString() : '—'} />
        <Stat label="Avg cache hit rate" value={cacheHitPct} />
        <Stat label="Avg prefill" value={fmtTps(totals?.avgPrefillTps)} sub="prompt tok/s, streamed" />
        <Stat label="Avg generation" value={fmtTps(totals?.avgGenerationTps)} sub="completion tok/s, streamed" />
        <Stat label="Most used model" value={totals?.mostUsedModel ?? '—'} />
        <Stat label="Energy used" value={source === 'remote' ? '—' : (totals ? `${totals.energyKwh.toFixed(2)} kWh` : '—')} />
        <Stat
          label="Est. cost"
          value={source === 'remote' ? '—' : (totals && costPerKwh > 0 ? `${currencySymbol}${estCost.toFixed(2)}` : '—')}
          sub={source === 'remote' ? 'Not applicable for remote' : (costPerKwh === 0 ? 'set cost/kWh in Settings' : undefined)}
        />
        <Stat label="Cost / 1M tokens" value={source === 'remote' ? '—' : (costPerMillionTokens !== null ? `${currencySymbol}${formatSmallCost(costPerMillionTokens)}` : '—')} />
        <Stat
          label="Cloud API cost"
          value={totals?.cloudCostUsd != null ? `$${formatSmallCost(totals.cloudCostUsd)}` : '—'}
          sub={totals?.cloudCostUsd == null ? 'no priced cloud requests yet' : 'USD, priced models only'}
        />
      </div>
      <p className="text-[11.5px] text-faint">
        Energy reflects total GPU power draw while an engine is running — not power isolated to a single request, or a specific
        model if you switched models mid-session. Cloud API cost only covers models whose provider reported pricing on
        "Retrieve Models" (e.g. OpenRouter) — it is not a full accounting of every cloud dollar spent.
      </p>

      <SectionCard title="Activity heatmap" description={`Requests per day over the last ${days} days`}>
        <div className="overflow-x-auto">
          <div className="flex gap-[3px]">
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-[3px]">
                {week.map((cell, di) => (
                  <div
                    key={di}
                    title={cell ? `${cell.day}: ${cell.requests} request${cell.requests === 1 ? '' : 's'}` : undefined}
                    className={`h-3 w-3 rounded-sm ${cell ? heatCellClass(cell.requests, maxRequests) : 'opacity-0'}`}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-faint">
            <span>Less</span>
            <span className="h-3 w-3 rounded-sm bg-inset" />
            <span className="h-3 w-3 rounded-sm bg-accent/20" />
            <span className="h-3 w-3 rounded-sm bg-accent/40" />
            <span className="h-3 w-3 rounded-sm bg-accent/70" />
            <span className="h-3 w-3 rounded-sm bg-accent" />
            <span>More</span>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Daily token trend" description="Token volume by model, and cache-hit rate, by day">
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartRows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-line)" />
              <XAxis dataKey="day" tick={{ fontSize: 10.5, fill: 'var(--color-faint)' }} tickLine={false} />
              <YAxis yAxisId="tokens" tick={{ fontSize: 10.5, fill: 'var(--color-faint)' }} tickLine={false} axisLine={false} tickFormatter={(v) => formatTokens(v)} />
              <YAxis
                yAxisId="rate"
                orientation="right"
                domain={[0, 1]}
                tick={{ fontSize: 10.5, fill: 'var(--color-faint)' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `${Math.round(v * 100)}%`}
              />
              <Tooltip
                contentStyle={{ background: 'var(--color-panel2)', border: '1px solid var(--color-line)', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: 'var(--color-ink)' }}
                formatter={(value, name) =>
                  name === 'cache hit rate' ? [`${(Number(value) * 100).toFixed(1)}%`, name] : [formatTokens(Number(value)), name]
                }
              />
              <Legend wrapperStyle={{ fontSize: 11.5 }} formatter={(value) => <span style={{ color: 'var(--color-mute)' }}>{value}</span>} />
              {modelBreakdown.map((m, i) => (
                <Bar
                  key={m.model}
                  yAxisId="tokens"
                  dataKey={m.model}
                  name={m.model}
                  stackId="tokens"
                  fill={modelColor(i)}
                  radius={i === modelBreakdown.length - 1 ? [3, 3, 0, 0] : undefined}
                />
              ))}
              <Line yAxisId="rate" type="monotone" dataKey="cacheHitRate" name="cache hit rate" stroke="var(--color-ink)" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>

      <SectionCard title="Model usage" description="Token share by model">
        {modelBreakdown.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-faint">no usage recorded yet</div>
        ) : (
          <div className="flex flex-col items-center gap-4 sm:flex-row">
            <div className="h-48 w-48 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={modelBreakdown} dataKey="tokens" nameKey="model" innerRadius="60%" outerRadius="90%" paddingAngle={2}>
                    {modelBreakdown.map((m, i) => (
                      <Cell key={m.model} fill={modelColor(i)} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: 'var(--color-panel2)', border: '1px solid var(--color-line)', borderRadius: 8, fontSize: 12 }}
                    formatter={(value) => formatTokens(Number(value))}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 space-y-2">
              {modelBreakdown.map((m, i) => (
                <div key={m.model} className="flex items-center justify-between gap-3 text-[12.5px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: modelColor(i) }} />
                    <span className="truncate text-ink">{m.model}</span>
                  </span>
                  <span className="shrink-0 font-mono text-mute">
                    {formatTokens(m.tokens)} · {totalModelTokens > 0 ? Math.round((m.tokens / totalModelTokens) * 100) : 0}%
                    {m.cloudCostUsd != null && ` · $${formatSmallCost(m.cloudCostUsd)}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
