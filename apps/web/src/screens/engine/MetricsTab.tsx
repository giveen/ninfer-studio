import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import { Badge, Button, SectionCard, Stat, cn } from '../../components/ui';
import { getEngineMetrics } from '../../lib/api/engine';
import {
  formatLabels,
  formatPromValue,
  parsePrometheus,
  promValue,
  type PromFamily,
} from '../../lib/prometheus';

const AUTO_REFRESH_MS = 5000;

/** Presentation-only grouping. Every family lands in exactly one bucket, and
 *  anything unrecognized falls through to "Other" — the Engine owns the metric
 *  vocabulary, so nothing here may hide a series it publishes. */
const GROUPS: Array<{ id: string; title: string; match: (name: string) => boolean }> = [
  {
    id: 'scheduler',
    title: 'Scheduler & capacity',
    match: (n) =>
      /^ninfer_(max_concurrency|max_context_tokens|model_info)$/.test(n) ||
      /^ninfer_requests_(running|waiting|paused|prefilling|decode_ready|replaying|materializing)$/.test(n),
  },
  { id: 'tokens', title: 'Tokens', match: (n) => n.includes('_tokens_') },
  { id: 'spec', title: 'Speculative decoding', match: (n) => n.includes('spec_decode') },
  {
    id: 'context',
    title: 'Context cache, Host & transfers',
    match: (n) =>
      /^ninfer_(host_|device_)/.test(n) ||
      n.startsWith('ninfer_context_transfer') ||
      n.startsWith('ninfer_preemptions') ||
      n.startsWith('ninfer_snapshot_restores') ||
      n.startsWith('ninfer_replay_restores'),
  },
  { id: 'constraints', title: 'Constrained decoding', match: (n) => n.includes('constraint') },
  {
    id: 'requests',
    title: 'Requests & latency',
    match: (n) =>
      n.startsWith('ninfer_requests_total') ||
      n.startsWith('ninfer_response_failures') ||
      n.startsWith('ninfer_time_to_first_token') ||
      n.startsWith('ninfer_request_duration') ||
      n.startsWith('ninfer_request_queue'),
  },
];

function groupFamilies(families: PromFamily[]): Array<{ id: string; title: string; families: PromFamily[] }> {
  const buckets = new Map<string, PromFamily[]>(GROUPS.map((g) => [g.id, []]));
  const other: PromFamily[] = [];
  for (const fam of families) {
    const group = GROUPS.find((g) => g.match(fam.name));
    if (group) buckets.get(group.id)!.push(fam);
    else other.push(fam);
  }
  const out = GROUPS.map((g) => ({ id: g.id, title: g.title, families: buckets.get(g.id)! })).filter(
    (g) => g.families.length > 0,
  );
  if (other.length > 0) out.push({ id: 'other', title: 'Other', families: other });
  return out;
}

function FamilyTable({ family }: { family: PromFamily }) {
  return (
    <div className="rounded-lg border border-line bg-inset">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-3.5 py-2">
        <span className="font-mono text-[12.5px] font-medium text-fg">{family.name}</span>
        {family.type && <Badge tone="neutral">{family.type}</Badge>}
        {family.help && <span className="text-[11.5px] text-faint">{family.help}</span>}
      </div>
      <div className="divide-y divide-line">
        {family.samples.map((s, i) => (
          <div key={`${family.name}-${i}`} className="flex items-baseline justify-between gap-4 px-3.5 py-1.5">
            <span className="min-w-0 truncate font-mono text-[11.5px] text-mute" title={formatLabels(s.labels)}>
              {formatLabels(s.labels) || '—'}
            </span>
            <span className="font-mono text-[12.5px] tabular-nums text-fg">{formatPromValue(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MetricsTab({ active }: { active: boolean }) {
  const [families, setFamilies] = useState<PromFamily[]>([]);
  const [raw, setRaw] = useState('');
  const [port, setPort] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  const [at, setAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getEngineMetrics();
      if (res.ok && typeof res.metrics === 'string') {
        setRaw(res.metrics);
        setFamilies(parsePrometheus(res.metrics));
        setPort(res.port ?? null);
        setError(null);
        setAt(Date.now());
      } else {
        setFamilies([]);
        setRaw('');
        setError(res.message || 'engine metrics unavailable');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'engine metrics unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (!active || !auto) return;
    const timer = setInterval(() => void refresh(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, auto, refresh]);

  const groups = useMemo(() => groupFamilies(families), [families]);

  const running = promValue(families, 'ninfer_requests_running');
  const waiting = promValue(families, 'ninfer_requests_waiting');
  const paused = promValue(families, 'ninfer_requests_paused');
  const ready = promValue(families, 'ninfer_engine_ready');
  const kvUsed = promValue(families, 'ninfer_device_kv_used_pages');
  const kvCap = promValue(families, 'ninfer_device_kv_capacity_pages');
  const hostUsed = promValue(families, 'ninfer_host_context_used_bytes');
  const hostCap = promValue(families, 'ninfer_host_context_capacity_bytes');

  return (
    <div className="space-y-4">
      <SectionCard
        title="Live metrics"
        description="Prometheus snapshot from the engine's GET /metrics, proxied through the control plane with the same API-key auth. Counters reset when the engine restarts."
        icon={<Activity size={15} />}
        actions={
          <>
            <Button size="sm" onClick={() => setAuto((v) => !v)} variant={auto ? 'subtle' : 'ghost'} title="Poll every 5s while this tab is open">
              {auto ? 'Auto 5s' : 'Auto off'}
            </Button>
            <Button size="sm" onClick={() => setShowRaw((v) => !v)} variant={showRaw ? 'subtle' : 'ghost'}>
              {showRaw ? 'Grouped' : 'Raw'}
            </Button>
            <Button size="sm" onClick={() => void refresh()} disabled={loading} title="Refresh now">
              <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
            </Button>
          </>
        }
      >
        {error ? (
          <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3.5 py-3 text-[12.5px] text-warn">
            <AlertTriangle size={14} />
            <span>{error}</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Ready"
              value={ready === null ? '—' : ready >= 1 ? 'yes' : 'no'}
              tone={ready === null ? 'neutral' : ready >= 1 ? 'ok' : 'danger'}
              sub={port ? `port ${port}` : undefined}
            />
            <Stat label="Running" value={running === null ? '—' : formatPromValue(running)} sub="admitted lanes" />
            <Stat label="Waiting" value={waiting === null ? '—' : formatPromValue(waiting)} sub={paused ? `${formatPromValue(paused)} paused` : 'FIFO queue'} />
            <Stat
              label="KV pages"
              value={kvUsed === null ? '—' : `${formatPromValue(kvUsed)}${kvCap ? ` / ${formatPromValue(kvCap)}` : ''}`}
              sub="Device Main KV"
            />
            <Stat
              label="Host context"
              value={hostUsed === null ? '—' : formatPromValue(hostUsed)}
              sub={hostCap !== null ? `of ${formatPromValue(hostCap)} bytes` : 'bytes used'}
            />
            <Stat label="Refreshed" value={at ? new Date(at).toLocaleTimeString() : '—'} tone="neutral" sub={loading ? 'refreshing…' : undefined} />
          </div>
        )}
      </SectionCard>

      {showRaw ? (
        <SectionCard title="Raw exposition" description="Exactly what GET /metrics returned." collapsible>
          <pre className="max-h-[60vh] overflow-auto rounded-lg border border-line bg-inset p-3 font-mono text-[11.5px] leading-relaxed text-mute">
            {raw || '# no metrics'}
          </pre>
        </SectionCard>
      ) : (
        groups.map((g) => (
          <SectionCard key={g.id} title={g.title} description={`${g.families.length} metric famil${g.families.length === 1 ? 'y' : 'ies'}`} collapsible>
            <div className="space-y-3">
              {g.families.map((f) => (
                <FamilyTable key={f.name} family={f} />
              ))}
            </div>
          </SectionCard>
        ))
      )}

      {!showRaw && groups.length === 0 && !error && (
        <p className="text-[12.5px] text-mute">No metric families published yet.</p>
      )}
    </div>
  );
}
