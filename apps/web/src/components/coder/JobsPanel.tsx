import { BrainCircuit, ChevronDown, ChevronRight, Square, X } from 'lucide-react';
import { cn } from '../ui';
import { redactSecrets } from '../toolResults';
import type { CoderJobs } from './useCoderJobs';

interface JobsPanelProps {
  jobs: CoderJobs;
  /** Worktree-aware dir the run executes in — lists are tagged with it, not the workspace root. */
  activeWsDir: string;
}

/** Sidebar jobs section body: collapse toggle + live subagents + background shell jobs. */
export function JobsPanel({ jobs, activeWsDir }: JobsPanelProps) {
  const { bgJobs, activeSubs, subTick, jobStatus, jobsOpen, setJobsOpen, killJob, dismissJob } = jobs;
  // Both lists are tagged with activeWsDir (the worktree-aware dir a
  // run actually executes in), not activeWs (the workspace root) —
  // a worktree conversation's jobs would otherwise never match.
  const wsJobs = bgJobs.filter((j) => j.ws === activeWsDir);
  const subs = activeSubs.filter((s) => s.ws === activeWsDir);
  return (
    <>
      <div className="mb-1.5 flex items-center">
        <button
          type="button"
          className="ml-auto rounded p-0.5 text-faint hover:text-ink"
          title={jobsOpen ? 'Collapse' : 'Expand'}
          onClick={() => setJobsOpen((o) => !o)}
        >
          {jobsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      </div>
      {jobsOpen && (wsJobs.length === 0 && subs.length === 0 ? (
        <div className="text-[10.5px] italic text-faint">No background jobs. Long builds/tests run here via bash with background:true.</div>
      ) : (
        <div className="max-h-40 space-y-1 overflow-auto">
          {subs.map((s) => (
            <div key={s.id} className="rounded border border-accent/25 bg-accent/8 px-2 py-1" title={s.task}>
              <div className="flex items-center gap-2">
                <BrainCircuit size={11} className="shrink-0 animate-pulse text-accent" />
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-mute">{s.label} — {s.task}</span>
                <span className="shrink-0 text-[10px] text-faint">{Math.max(1, Math.round((subTick - s.since) / 1000))}s</span>
              </div>
            </div>
          ))}
          {wsJobs.map((j) => {
            const s = jobStatus[j.id];
            const done = s?.done ?? false;
            const ok = done && (s?.exitCode === 0);
            return (
              <div key={j.id} className="rounded border border-line px-2 py-1">
                <div className="flex items-center gap-2">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', !done ? 'animate-pulse bg-accent' : ok ? 'bg-ok' : 'bg-danger')} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mute" title={j.command}>{j.command || j.id}</span>
                  <span className="shrink-0 text-[10px] text-faint">{!done ? 'running' : s?.exitCode === null ? (s?.killed ? 'killed' : 'done') : `exit ${s?.exitCode}`}</span>
                  {!done ? (
                    <button
                      type="button"
                      title="Kill job"
                      className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-danger"
                      onClick={() => killJob(j.id)}
                    >
                      <Square size={11} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      title="Dismiss"
                      className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-ink"
                      onClick={() => dismissJob(j.id)}
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
                {s && (s.stdout || s.stderr) && (
                  <div className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all border-t border-line pt-1 font-mono text-[10px] text-mute">
                    {redactSecrets((s.stdout + (s.stderr ? `\n${s.stderr}` : '')).slice(-2000))}
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
