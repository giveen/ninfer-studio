import { useMemo, useState } from 'react';
import { X, BookmarkPlus, Trash2, RefreshCw } from 'lucide-react';
import { Button, cn } from './ui';
import type { CoderLearning, CoderMemory, CoderLearningKind } from '../lib/api';

interface MemoryModalProps {
  open: boolean;
  onClose: () => void;
  /** Header title — defaults to "Repository Memory" (Coder's per-workspace store). */
  title?: string;
  /** Current learnings (read-only snapshot from the parent). */
  memory: CoderMemory;
  /** Drop one learning by id. */
  onDropLearning: (id: string) => Promise<void> | void;
  /** Called after any mutation so the parent can refresh its snapshot. */
  onChanged?: () => void;
}

const KIND_META: Record<CoderLearningKind, { label: string; cls: string }> = {
  success: { label: 'success', cls: 'border-ok/40 bg-ok/10 text-ok' },
  tip: { label: 'tip', cls: 'border-accent/40 bg-accent/10 text-accent' },
  avoid: { label: 'avoid', cls: 'border-danger/40 bg-danger/10 text-danger' },
};

function fmtTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

export function MemoryModal({ open, onClose, title = 'Repository Memory', memory, onDropLearning, onChanged }: MemoryModalProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

  // Newest learnings first for display.
  const ordered = useMemo(() => [...(memory.learnings ?? [])].reverse(), [memory.learnings]);

  if (!open) return null;

  const drop = async (id: string) => {
    setBusyId(id);
    try {
      await onDropLearning(id);
      onChanged?.();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true">
      <div className="flex max-h-[88vh] w-[min(860px,94vw)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xl">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line p-3">
          <BookmarkPlus size={15} className="text-accent" />
          <div className="text-sm font-semibold">{title}</div>
          <span className="rounded bg-panel2 px-1.5 py-0.5 text-[11px] text-mute">
            {memory.learnings.length} active constraint{memory.learnings.length === 1 ? '' : 's'}
          </span>
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
        <div className="min-h-0 flex-1 overflow-auto p-3 space-y-4">
          <section>
            <div className="mb-1 text-[12px] font-semibold text-ink">
              Learnings from prior runs
            </div>
            {ordered.length === 0 ? (
              <div className="rounded border border-dashed border-line p-4 text-center text-[12px] text-faint">
                No learnings yet. They are extracted automatically by the intent continuity extractor,
                or recorded on the fly via the agent's <code className="font-mono">memory_update</code> tool.
              </div>
            ) : (
              <ul className="space-y-1.5">
                {ordered.map((l: CoderLearning) => {
                  const meta = KIND_META[l.kind] ?? KIND_META.tip;
                  return (
                    <li
                      key={l.id}
                      className="flex items-start gap-2 rounded border border-line bg-panel2/40 p-2"
                    >
                      <span className={cn('shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase', meta.cls)}>
                        {meta.label}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] leading-snug text-ink">{l.text}</div>
                        <div className="mt-1 flex flex-wrap gap-2 text-[10.5px] text-mute font-mono">
                          {l.component && <span>component: <span className="text-faint">{l.component}</span></span>}
                          {l.scope && <span>scope: <span className="text-faint">{l.scope}</span></span>}
                          {l.target_key && <span>key: <span className="text-faint">{l.target_key}</span></span>}
                          {l.value && <span>value: <span className="text-faint">{l.value}</span></span>}
                        </div>
                        <div className="mt-1 text-[10.5px] text-faint">
                          {l.provenance ?? 'unknown'}
                          {l.task ? ` · ${l.task}` : ''} · {fmtTs(l.ts)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => drop(l.id)}
                        disabled={busyId === l.id}
                        className="shrink-0 rounded p-1 text-faint hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                        title="Delete this learning"
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line p-2.5">
          <Button variant="ghost" size="sm" onClick={onChanged} title="Reload memory from disk">
            <RefreshCw size={13} /> Reload
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
