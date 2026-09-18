import React from 'react';
import { BookmarkPlus, RotateCcw, Trash2 } from 'lucide-react';
import type { Checkpoint } from '../../lib/coderStore';
import { SidebarSection } from './CoderSidebar';

export interface CheckpointsPanelProps {
  showCheckpoints: boolean;
  activeWs: string;
  activeConv: string;
  running: boolean;
  checkpoints: Checkpoint[];
  createCheckpoint: (opts?: { auto?: boolean }) => Promise<void>;
  restoreCheckpoint: (cp: Checkpoint) => Promise<void>;
  deleteCheckpoint: (id: string) => void;
}

export function CheckpointsPanel({
  showCheckpoints,
  activeWs,
  activeConv,
  running,
  checkpoints,
  createCheckpoint,
  restoreCheckpoint,
  deleteCheckpoint,
}: CheckpointsPanelProps) {
  if (!showCheckpoints || !activeWs) return null;

  return (
    <SidebarSection title="Checkpoints" icon={<BookmarkPlus size={13} />} defaultOpen={false}>
      <div className="shrink-0 border-b border-line bg-panel px-4 py-2">
        <div className="mb-1.5 flex items-center">
          <button
            type="button"
            className="ml-auto rounded border border-line px-2 py-px text-[10.5px] normal-case tracking-normal text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
            onClick={() => void createCheckpoint()}
            disabled={!activeConv || running}
            title="Snapshot the transcript and workspace HEAD"
          >
            + checkpoint
          </button>
        </div>
        {checkpoints.length === 0 ? (
          <div className="text-[11px] italic text-faint">
            No checkpoints yet — snapshot before a risky run, restore when the loop goes off a cliff.
          </div>
        ) : (
          <div className="max-h-36 space-y-1 overflow-auto">
            {checkpoints.map((cp) => (
              <div key={cp.id} className="flex items-center gap-2 rounded border border-line px-2 py-1">
                <span className="shrink-0 font-mono text-[10.5px] text-accent">{cp.label}</span>
                {cp.auto && (
                  <span
                    className="shrink-0 rounded bg-panel2 px-1 py-0.5 text-[9.5px] uppercase tracking-wide text-faint"
                    title="Taken automatically before this turn's first edit/write/commit"
                  >
                    auto
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[11px] text-mute">
                  {new Date(cp.time).toLocaleString()} · {cp.messageCount ?? cp.messages ?? 0} msgs · {cp.todos.length} todos
                </span>
                <button
                  type="button"
                  title={`Restore checkpoint ${cp.label}`}
                  onClick={() => void restoreCheckpoint(cp)}
                  disabled={running}
                  className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-ok disabled:opacity-40"
                >
                  <RotateCcw size={12} />
                </button>
                <button
                  type="button"
                  title="Delete checkpoint"
                  onClick={() => deleteCheckpoint(cp.id)}
                  className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </SidebarSection>
  );
}
