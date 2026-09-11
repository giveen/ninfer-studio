import { useEffect, useMemo, useState } from 'react';
import { X, RefreshCw, GitCommit, ShieldAlert, FileDiff } from 'lucide-react';
import { Button, cn } from './ui';
import { lineClass } from './diffStyle';
import type { CoderDiffResult } from '../lib/api';

interface DiffReviewModalProps {
  open: boolean;
  /** 'view' shows a Close button; 'approve' shows Deny + Approve. */
  mode: 'view' | 'approve';
  /** view: close · approve: deny */
  onClose: () => void;
  /** approve mode only — commits after the human signs off */
  onApprove?: () => void;
  fetchDiff: () => Promise<CoderDiffResult>;
  title?: string;
}

export function DiffReviewModal({ open, mode, onClose, onApprove, fetchDiff, title }: DiffReviewModalProps) {
  const [data, setData] = useState<CoderDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchDiff());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const lines = useMemo(() => (data?.diff || '').split('\n'), [data]);
  const fileCount = data?.files?.length ?? 0;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
      <div className="flex max-h-[85vh] w-[min(920px,94vw)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line p-3">
          <FileDiff size={15} className="text-accent" />
          <div className="text-sm font-semibold">{title ?? 'Working tree vs HEAD'}</div>
          {!loading && !error && (
            <span className="rounded bg-panel2 px-1.5 py-0.5 text-[11px] text-mute">
              {fileCount} file{fileCount === 1 ? '' : 's'} changed
            </span>
          )}
          {data?.truncated && (
            <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[11px] text-warn" title="Diff truncated by the server (~60k chars).">
              truncated
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded p-1 text-faint hover:bg-panel2 hover:text-ink"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto">
          {loading && (
            <div className="p-6 text-center text-[12px] text-faint">Loading diff…</div>
          )}
          {!loading && (error || data?.error) && (
            <div className="p-4 font-mono text-[12px] text-danger">{error || data?.error}</div>
          )}
          {!loading && !error && !data?.error && fileCount === 0 && (
            <div className="p-6 text-center text-[12px] text-faint">No uncommitted changes in the working tree.</div>
          )}
          {!loading && !error && fileCount > 0 && (
            <>
              {/* File chips */}
              <div className="flex flex-wrap gap-1.5 border-b border-line/60 bg-panel2/40 p-2">
                {data!.files.map((f) => (
                  <span
                    key={f.path}
                    className="inline-flex items-center gap-1 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[11px] text-ink"
                    title={f.path}
                  >
                    <span className="max-w-[260px] truncate">{f.path}</span>
                    {f.bar && <span className="text-faint">{f.bar}</span>}
                  </span>
                ))}
              </div>
              {/* Diff body */}
              <pre className="whitespace-pre px-1 py-1 font-mono text-[11.5px] leading-[1.5]">
                {lines.map((ln, i) => (
                  <div key={i} className={cn('px-2', lineClass(ln))}>
                    {ln || ' '}
                  </div>
                ))}
              </pre>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line p-2.5">
          {mode === 'approve' && (
            <div className="mr-auto flex items-center gap-1.5 text-[11.5px] text-warn">
              <ShieldAlert size={13} /> Commit requires your approval
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={load} title="Re-fetch the latest working-tree diff">
            <RefreshCw size={13} /> Refresh
          </Button>
          {mode === 'approve' ? (
            <>
              <Button variant="danger" size="sm" onClick={onClose}>
                Deny
              </Button>
              <Button variant="primary" size="sm" onClick={() => onApprove?.()}>
                <GitCommit size={13} /> Approve &amp; commit
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
