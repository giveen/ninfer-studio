import { Terminal, AlertTriangle } from 'lucide-react';
import type { StatusPayload } from '../lib/types';
import { useEngineLogs, LOG_TAIL_LINES } from '../lib/liveLogs';
import { LogPane } from '../components/ui';

// Dedicated Engine log tab: displays the shared engine-log tail with live polling
// and staleness feedback when the control plane or log file is unreadable.
export function LogScreen({ status }: { status: StatusPayload | null }) {
  const engine = status?.engine;
  const logPath = engine?.logPath;
  const logs = useEngineLogs();

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
        {logs.isStale && (
          <span className="flex items-center gap-1 rounded bg-warn/10 px-1.5 py-0.5 text-[10.5px] font-medium text-warn" title={logs.error ?? 'Polling paused or delayed'}>
            <AlertTriangle size={11} />
            stale
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-faint">
          {logs.length ? `${logs.length} lines (last ${LOG_TAIL_LINES})` : ''}
        </span>
      </div>
      <div className="min-h-0 flex-1 p-3">
        <LogPane lines={logs} />
      </div>
    </div>
  );
}
