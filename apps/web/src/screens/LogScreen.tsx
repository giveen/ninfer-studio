import { Terminal } from 'lucide-react';
import type { StatusPayload } from '../lib/types';
import { useEngineLogs } from '../lib/liveLogs';
import { LogPane } from '../components/ui';

// Full-screen engine log: the same tail the Engine screen shows at the bottom,
// promoted to its own tab so it can be watched without scrolling settings.
// The tail itself comes from the shared useEngineLogs store, so this pane and
// the Engine screen's pane run ONE /api/logs poll together.
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
        <span className="ml-auto font-mono text-[11px] text-faint">{logs.length ? `${logs.length} lines (last 1000)` : ''}</span>
      </div>
      <div className="min-h-0 flex-1 p-3">
        <LogPane lines={logs} />
      </div>
    </div>
  );
}
