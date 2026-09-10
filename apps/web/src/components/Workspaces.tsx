import { useState } from 'react';
import { Check, Folder, Plus, X } from 'lucide-react';
import { cn } from './ui';
import { DirBrowser } from './DirBrowser';

interface WorkspacesProps {
  workspaces: string[];
  active: string;
  onSelect: (path: string) => void;
  onAdd: (path: string) => void;
  onRemove: (path: string) => void;
  busy?: boolean;
}

/**
 * Workspace manager for the Code section. Mirrors the deepseek-harness pattern:
 * a list of workspace directories where selecting one retargets the coder to
 * operate there. "Add workspace…" picks/creates a directory (the sidecar creates
 * it if missing) and makes it active.
 */
export function Workspaces({ workspaces, active, onSelect, onAdd, onRemove, busy }: WorkspacesProps) {
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [draft, setDraft] = useState('');

  const submit = () => {
    const p = draft.trim();
    if (!p) return;
    onAdd(p);
    setDraft('');
    setAdding(false);
  };

  return (
    <div className="border-b border-line">
      <div className="flex items-center gap-2 px-2 py-2 text-sm font-semibold">
        <Folder size={14} /> Workspaces
        <button
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-faint hover:bg-panel2 hover:text-ink disabled:opacity-40"
          title="Add workspace"
          onClick={() => setAdding((v) => !v)}
          disabled={busy}
        >
          <Plus size={14} />
        </button>
      </div>

      {adding && (
        <div className="space-y-1.5 px-2 pb-2">
          <input
            autoFocus
            className="w-full rounded border border-line bg-inset px-2 py-1 font-mono text-[12px] outline-none focus:border-accent/50"
            placeholder="Absolute path, e.g. /home/you/project"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') {
                setAdding(false);
                setDraft('');
              }
            }}
          />
          <button
            className="w-full rounded border border-line px-2 py-1 text-[11px] text-mute hover:bg-panel2"
            onClick={() => setBrowsing(true)}
          >
            Browse existing folder…
          </button>
          <div className="flex gap-1.5">
            <button
              className="flex-1 rounded bg-accent/15 py-1 text-[11px] font-medium text-accent hover:bg-accent/25"
              onClick={submit}
            >
              Add workspace
            </button>
            <button
              className="rounded border border-line px-2 py-1 text-[11px] text-mute hover:bg-panel2"
              onClick={() => {
                setAdding(false);
                setDraft('');
              }}
            >
              Cancel
            </button>
          </div>
          <p className="text-[10px] leading-snug text-faint">
            Points this workspace at a directory; the sidecar creates it if missing. Selecting makes it the active workspace.
          </p>
        </div>
      )}
      {browsing && (
        <DirBrowser
          initialPath={draft || '/'}
          onPick={(p) => {
            setDraft(p);
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}

      <div className="max-h-44 space-y-0.5 overflow-auto px-2 pb-2">
        {workspaces.length === 0 && !adding && (
          <div className="px-1 py-1 text-[11px] italic text-faint">No workspaces yet — add one above.</div>
        )}
        {workspaces.map((ws) => {
          const isActive = ws === active;
          return (
            <div
              key={ws}
              className={cn(
                'group flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11.5px]',
                isActive ? 'bg-accent/12 text-ink' : 'text-mute hover:bg-panel2',
              )}
              onClick={() => onSelect(ws)}
              title={ws}
            >
              {isActive ? <Check size={12} className="shrink-0 text-accent" /> : <span className="w-3 shrink-0" />}
              <span className="flex-1 truncate font-mono">{ws || '(empty)'}</span>
              <button
                className="shrink-0 text-faint opacity-0 hover:text-danger group-hover:opacity-100"
                title="Remove workspace"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(ws);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
