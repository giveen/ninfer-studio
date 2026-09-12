import { ChevronDown, ChevronRight, RefreshCw, Undo2 } from 'lucide-react';
import type { CoderGit } from './useCoderGit';

interface CommitsPanelProps {
  git: CoderGit;
}

/** Sidebar commit-history list: refresh, collapse, expand, one-click revert. */
export function CommitsPanel({ git }: CommitsPanelProps) {
  const {
    commits, commitsLoading, commitsOpen, setCommitsOpen,
    expandedCommit, setExpandedCommit, loadCommits, revertCommit,
  } = git;
  return (
    <div className="max-h-52 shrink-0 overflow-hidden border-t border-line p-2">
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          className="ml-auto rounded p-0.5 text-faint hover:text-ink"
          title="Refresh"
          onClick={() => loadCommits()}
        >
          <RefreshCw size={12} className={commitsLoading ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          className="rounded p-0.5 text-faint hover:text-ink"
          title={commitsOpen ? 'Collapse' : 'Expand'}
          onClick={() => setCommitsOpen((o) => !o)}
        >
          {commitsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      </div>
      {commitsOpen && (
        <div className="max-h-40 space-y-1 overflow-auto">
          {commitsLoading ? (
            <div className="text-faint italic text-[11px]">Loading…</div>
          ) : commits.length === 0 ? (
            <div className="text-faint italic text-[11px]">No commits yet.</div>
          ) : (
            commits.map((c) => (
              <div key={c.hash} className="rounded border border-line">
                <div className="flex w-full items-center gap-2 px-2 py-1 hover:bg-panel2">
                  <button
                    type="button"
                    onClick={() => setExpandedCommit(expandedCommit === c.hash ? null : c.hash)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span className="shrink-0 font-mono text-[10.5px] text-accent">{c.hash.slice(0, 7)}</span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink">{c.subject}</span>
                    <span className="shrink-0 text-[10px] text-faint">{c.relDate}</span>
                  </button>
                  <button
                    type="button"
                    title={`Revert ${c.hash.slice(0, 7)} (creates an undo commit)`}
                    onClick={() => revertCommit(c.hash)}
                    className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-warn"
                  >
                    <Undo2 size={12} />
                  </button>
                </div>
                {expandedCommit === c.hash && (
                  <div className="whitespace-pre-wrap border-t border-line px-2 py-1.5 text-[10.5px] leading-relaxed text-mute">
                    <div className="mb-1 text-faint">{c.author} · {c.date}</div>
                    {c.body || c.subject}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
