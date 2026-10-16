import { Terminal, AlertTriangle, Copy, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { StatusPayload } from '../lib/types';
import { useEngineLogs, LOG_TAIL_LINES } from '../lib/liveLogs';
import { LogPane } from '../components/ui';
import { formatBytes } from '../lib/format';

/** Dedicated Engine log tab: displays the shared engine-log tail with live polling
 *  when active and staleness feedback when the control plane or log file is unreadable. */
export function LogScreen({ status, active = true }: { status: StatusPayload | null; active?: boolean }) {
  const engine = status?.engine;
  const logPath = engine?.logPath;
  const logs = useEngineLogs(active);

  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((l) => l.toLowerCase().includes(q));
  }, [logs, query]);

  const engineRunning = engine?.state === 'running' || engine?.state === 'external';

  const copyFiltered = () => {
    try { void navigator.clipboard?.writeText(filtered.join('\n')); } catch { /* noop */ }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-4">
        <Terminal size={14} className="text-accent" />
        <span className="text-[12.5px] font-medium">Engine log</span>
        {logPath ? (
          <span className="truncate font-mono text-[11px] text-faint" title={logPath}>
            {logPath}
          </span>
        ) : (
          <span className="text-[11.5px] text-faint">log appears when the engine starts</span>
        )}
        {!engineRunning && engine?.state && (
          <span className="rounded bg-inset px-1.5 py-0.5 font-mono text-[10.5px] text-faint border border-line">
            {engine.state}
          </span>
        )}
        {logs.isStale && (
          <span className="flex items-center gap-1 rounded bg-warn/10 px-1.5 py-0.5 text-[10.5px] font-medium text-warn" title={logs.error ?? 'Polling paused or delayed'}>
            <AlertTriangle size={11} />
            {logs.error ? 'disconnected' : 'stale'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1 rounded border border-line bg-inset px-2 py-0.5">
            <Search size={11} className="text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter…"
              aria-label="Filter log lines"
              className="w-40 bg-transparent text-[11px] outline-none placeholder:text-faint"
            />
          </div>
          <span className="font-mono text-[11px] text-faint">
            {filtered.length !== logs.length ? `${filtered.length}/${logs.length}` : (logs.length ? `${logs.length} lines` : '')}
            {logs.size > 0 ? ` · ${formatBytes(logs.size)}` : ''}
          </span>
          <button
            type="button"
            onClick={copyFiltered}
            className="rounded border border-line bg-inset p-1 text-faint hover:text-ink"
            title="Copy visible log lines"
          >
            <Copy size={11} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 p-3">
        <LogPane lines={filtered} />
      </div>
    </div>
  );
}
