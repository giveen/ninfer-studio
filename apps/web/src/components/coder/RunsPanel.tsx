import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ChevronDown, ChevronRight, Square } from 'lucide-react';
import { cn } from '../ui';
import { redactSecrets } from '../toolResults';
import { agentRunsApi, RunStream, type RunSnapshot, type RunSummary } from '../../lib/agentRuns';

/** Sidebar server-runs section: every control-plane run (chat turns, scouts,
 *  workers, research angles), live or recent. Runs survive window close and
 *  are multi-client — expanding a row attaches read-only to watch it; the
 *  owning screen keeps driving approvals. */
export function RunsPanel() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [snap, setSnap] = useState<RunSnapshot | null>(null);
  const streamRef = useRef<RunStream | null>(null);

  const refresh = useCallback(() => {
    agentRunsApi.list().then(setRuns).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const closeStream = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    setSnap(null);
  }, []);

  const toggle = useCallback(
    (id: string) => {
      if (expanded === id) {
        setExpanded(null);
        closeStream();
        return;
      }
      setExpanded(id);
      closeStream();
      const s = new RunStream(
        id,
        (snapshot) => setSnap(snapshot),
        () => {
          // Snapshot-driven view: re-read on any non-delta frame.
          agentRunsApi.get(id).then(setSnap).catch(() => {});
        },
        () => {},
      );
      streamRef.current = s;
      void s.attach().catch(() => {});
    },
    [expanded, closeStream],
  );
  useEffect(() => closeStream, [closeStream]);

  const stop = useCallback(
    (id: string) => {
      agentRunsApi.stop(id).then(refresh).catch(() => {});
    },
    [refresh],
  );

  const statusDot = (s: RunSummary['status']) =>
    s === 'running' || s === 'awaiting_approval' || s === 'awaiting_user' || s === 'awaiting_gate'
      ? 'animate-pulse bg-accent'
      : s === 'done'
        ? 'bg-ok'
        : 'bg-danger';

  return (
    <>
      <div className="mb-1.5 flex items-center">
        <span className="flex items-center gap-1.5 text-[10.5px] font-medium text-mute">
          <Activity size={11} />
          {runs.filter((r) => r.status === 'running' || r.status === 'awaiting_approval').length > 0
            ? `${runs.filter((r) => r.status === 'running' || r.status === 'awaiting_approval').length} live`
            : 'Server runs'}
        </span>
        <button
          type="button"
          className="ml-auto rounded p-0.5 text-faint hover:text-ink"
          title={open ? 'Collapse' : 'Expand'}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      </div>
      {open &&
        (runs.length === 0 ? (
          <div className="text-[10.5px] italic text-faint">No runs yet. Chat turns, scouts, and workers all run server-side now.</div>
        ) : (
          <div className="max-h-64 space-y-1 overflow-auto">
            {runs.slice(0, 20).map((r) => {
              const live = r.status === 'running' || r.status === 'awaiting_approval' || r.status === 'awaiting_user' || r.status === 'awaiting_gate';
              const isOpen = expanded === r.id;
              return (
                <div key={r.id} className="rounded border border-line px-2 py-1">
                  <div className="flex items-center gap-2">
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDot(r.status))} />
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left font-mono text-[10.5px] text-mute hover:text-ink"
                      title={`${r.kind}: ${r.label || r.id}\n${r.id}`}
                      onClick={() => toggle(r.id)}
                    >
                      {r.label || `${r.kind} ${r.id.slice(0, 8)}`}
                    </button>
                    <span className="shrink-0 text-[10px] text-faint">
                      {r.kind} · {r.turns}/{r.maxSteps}
                    </span>
                    {live ? (
                      <button
                        type="button"
                        title="Stop run"
                        className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-danger"
                        onClick={() => stop(r.id)}
                      >
                        <Square size={11} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        title={isOpen ? 'Collapse' : 'Attach (read-only)'}
                        className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-ink"
                        onClick={() => toggle(r.id)}
                      >
                        {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      </button>
                    )}
                  </div>
                  {isOpen && (
                    <div className="mt-1 border-t border-line pt-1">
                      {snap && snap.id === r.id ? (
                        <div className="max-h-40 space-y-1 overflow-auto text-[10.5px] text-mute">
                          {snap.pendingApprovals.length > 0 && (
                            <div className="text-warn">⏳ {snap.pendingApprovals.length} approval(s) waiting in the owning screen</div>
                          )}
                          {snap.pendingGate && (
                            <div className="text-warn">⏳ gate ({snap.pendingGate.kind}) waiting in the owning screen</div>
                          )}
                          {[...snap.messages]
                            .reverse()
                            .filter((m) => m.role === 'assistant' && (m.content ?? '').trim())
                            .slice(0, 2)
                            .reverse()
                            .map((m, i) => (
                              <div key={i} className="whitespace-pre-wrap break-words">
                                {redactSecrets(String(m.content ?? '').slice(-1500))}
                              </div>
                            ))}
                          <div className="font-mono text-[10px] text-faint">
                            {snap.usage.total_tokens} tok · {snap.status}
                            {snap.stop ? ` · ${snap.stop}` : ''}
                          </div>
                        </div>
                      ) : (
                        <div className="text-[10.5px] italic text-faint">Attaching…</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
    </>
  );
}
