import React from 'react';
import {
  Folder,
  Play,
  GitBranch,
  Plus,
  GitCommit,
  BookmarkPlus,
  GitFork,
  Download,
  Undo2,
} from 'lucide-react';
import { cn } from '../ui';
import type { CoderStore, ConvMeta } from '../../lib/coderStore';

export interface CoderParams {
  thinking: boolean;
  thinkLevel?: 'low' | 'medium' | 'high' | 'xhigh';
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  criticModel?: string;
  promptCache?: boolean;
  humanize?: boolean;
  voiceProfile?: string;
  reviewLens?: string;
  maxAgentSteps?: number;
  compactAt?: number;
  primaryProvider?: 'ninfer' | 'cloud';
  primaryCloudModel?: string;
  subagentProvider?: 'ninfer' | 'cloud';
  subagentCloudModel?: string;
}

export interface CoderHeaderProps {
  activeWs: string;
  activeMeta: ConvMeta | null;
  runConv: { ws: string; convId: string } | null;
  wsHeld: boolean;
  wsAppliedDirRef: React.RefObject<string | null>;
  ctxTokens: number;
  ctxLimit: number | null;
  running: boolean;
  agentSteps: number;
  maxAgentSteps?: number;
  planMode: boolean;
  setPlanMode: React.Dispatch<React.SetStateAction<boolean>>;
  scoutOn: boolean;
  setScoutOn: React.Dispatch<React.SetStateAction<boolean>>;
  verifyMode: boolean;
  setVerifyMode: React.Dispatch<React.SetStateAction<boolean>>;
  runVerifyNow: () => Promise<void>;
  verifyNowBusy: boolean;
  criticMode: boolean;
  setCriticMode: React.Dispatch<React.SetStateAction<boolean>>;
  runCriticNow: () => Promise<void>;
  criticNowBusy: boolean;
  showBranchMenu: boolean;
  setShowBranchMenu: React.Dispatch<React.SetStateAction<boolean>>;
  branchMenuRef: React.RefObject<HTMLDivElement | null>;
  git: {
    currentBranch: string;
    branches: string[];
    branchesLoading: boolean;
    commits: any[];
    loadBranches: () => void;
  };
  handleSwitchBranch: (b: string) => Promise<void>;
  handleCreateBranch: () => Promise<void>;
  diffViewOpen: boolean;
  setDiffViewOpen: React.Dispatch<React.SetStateAction<boolean>>;
  memOpen: boolean;
  setMemOpen: React.Dispatch<React.SetStateAction<boolean>>;
  memory: { learnings: any[] };
  forkConversation: () => void;
  exportTranscript: () => void;
  undoLastCommit: () => void;
  showCheckpoints: boolean;
  setShowCheckpoints: React.Dispatch<React.SetStateAction<boolean>>;
  newChat: (ws: string) => void;
  messagesCount: number;
  store: CoderStore;
  baseName: (path: string) => string;
  formatTokens: (n: number) => string;
  defaultMaxAgentSteps: number;
}

export const CoderHeader: React.FC<CoderHeaderProps> = ({
  activeWs,
  activeMeta,
  runConv,
  wsHeld,
  wsAppliedDirRef,
  ctxTokens,
  ctxLimit,
  running,
  agentSteps,
  maxAgentSteps,
  planMode,
  setPlanMode,
  scoutOn,
  setScoutOn,
  verifyMode,
  setVerifyMode,
  runVerifyNow,
  verifyNowBusy,
  criticMode,
  setCriticMode,
  runCriticNow,
  criticNowBusy,
  showBranchMenu,
  setShowBranchMenu,
  branchMenuRef,
  git,
  handleSwitchBranch,
  handleCreateBranch,
  diffViewOpen,
  setDiffViewOpen,
  memOpen,
  setMemOpen,
  memory,
  forkConversation,
  exportTranscript,
  undoLastCommit,
  showCheckpoints,
  setShowCheckpoints,
  newChat,
  messagesCount,
  store,
  baseName,
  formatTokens,
  defaultMaxAgentSteps,
}) => {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-[12px]">
      <Folder size={13} className="text-accent" />
      <span className="font-medium text-ink">{activeWs ? baseName(activeWs) : 'No workspace'}</span>
      <span className="text-faint">/</span>
      <span className="truncate text-mute">{activeMeta?.title || 'New conversation'}</span>
      {runConv && !(runConv.ws === activeWs && activeMeta?.id === runConv.convId) && (
        <span
          role="status"
          className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-1.5 text-[10px] text-accent"
          title="A run is in progress in another conversation — it keeps running in the background; switch back to watch it."
        >
          ● running in {baseName(runConv.ws)} / {store.workspaces[runConv.ws]?.conversations[runConv.convId]?.title || '…'}
        </span>
      )}
      {wsHeld && wsAppliedDirRef.current && (
        <span
          className="shrink-0 text-[10px] text-faint"
          title="All agent tools run against the control plane's configured workspace, so the re-point to this workspace is held until the in-flight run finishes."
        >
          backend on {baseName(wsAppliedDirRef.current)} until run ends
        </span>
      )}
      <span
        className="ml-auto hidden shrink-0 font-mono text-[10.5px] text-faint sm:inline"
        title={ctxLimit != null ? `${formatTokens(ctxTokens)} of ${formatTokens(ctxLimit)} context tokens used (last request)` : 'Context usage appears after the first agent request'}
      >
        {ctxLimit != null ? `ctx ${formatTokens(ctxTokens)} / ${formatTokens(ctxLimit)}` : `ctx ${formatTokens(ctxTokens)}`}
        {(running || agentSteps > 0) && <span className="text-mute"> · step {agentSteps}/{maxAgentSteps || defaultMaxAgentSteps}</span>}
      </span>
      <button
        type="button"
        onClick={() => setPlanMode((v) => !v)}
        disabled={running}
        title={planMode ? 'Plan mode ON: read-only investigation, no writes or commands' : 'Turn on Plan mode: read-only investigation'}
        className={cn('rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', planMode ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
      >
        Plan
      </button>
      <button
        type="button"
        onClick={() => setScoutOn((v) => !v)}
        disabled={running}
        title={scoutOn ? 'Scout pre-pass ON: 3 parallel read-only probes when the engine allows (max-concurrency > 1)' : 'Scout pre-pass OFF'}
        className={cn('rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', scoutOn ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
      >
        Scout
      </button>
      <button
        type="button"
        onClick={() => setVerifyMode((v) => !v)}
        disabled={running}
        title={verifyMode ? 'Verify mode ON: the run must pass lint/test before it can finish' : 'Verify mode OFF'}
        className={cn('rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', verifyMode ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
      >
        Verify
      </button>
      <button
        type="button"
        onClick={() => void runVerifyNow()}
        disabled={running || verifyNowBusy}
        title="Run now: lint/test the current working tree on disk, independent of the Verify toggle"
        className="rounded border border-line p-0.5 text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
      >
        <Play size={11} className={verifyNowBusy ? 'animate-pulse' : ''} />
      </button>
      <button
        type="button"
        onClick={() => setCriticMode((v) => !v)}
        disabled={running}
        title={criticMode ? 'Critic ON: a model reviews the diff and can bounce it back for fixes before the run finishes' : 'Critic OFF'}
        className={cn('rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', criticMode ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
      >
        Critic
      </button>
      <button
        type="button"
        onClick={() => void runCriticNow()}
        disabled={running || criticNowBusy}
        title="Run now: get a critic review of the current uncommitted diff, independent of the Critic toggle"
        className="rounded border border-line p-0.5 text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
      >
        <Play size={11} className={criticNowBusy ? 'animate-pulse' : ''} />
      </button>
      <div className="relative" ref={branchMenuRef}>
        <button
          type="button"
          onClick={() => { const next = !showBranchMenu; setShowBranchMenu(next); if (next) git.loadBranches(); }}
          disabled={!activeWs}
          title="Switch branch"
          className="flex max-w-[140px] items-center gap-1 rounded border border-line px-2 py-0.5 text-[11px] text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
        >
          <GitBranch size={13} /> <span className="truncate">{git.currentBranch || 'branch'}</span>
        </button>
        {showBranchMenu && (
          <div className="absolute left-0 top-full z-20 mt-1 max-h-56 w-48 overflow-auto rounded border border-line bg-panel py-1 shadow-lg">
            {git.branchesLoading ? (
              <div className="px-2 py-1 text-[11px] italic text-faint">Loading…</div>
            ) : git.branches.length === 0 ? (
              <div className="px-2 py-1 text-[11px] italic text-faint">No branches.</div>
            ) : (
              git.branches.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => void handleSwitchBranch(b)}
                  disabled={running}
                  title={running ? 'Stop the agent before switching branches' : `Switch to ${b}`}
                  className={cn('block w-full truncate px-2 py-1 text-left text-[11px] hover:bg-panel2 disabled:opacity-40', b === git.currentBranch ? 'text-accent' : 'text-ink')}
                >
                  {b}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => void handleCreateBranch()}
        disabled={!activeWs || running}
        title={running ? 'Stop the agent before creating a branch' : 'Create a new branch from HEAD and switch to it'}
        className="rounded border border-line p-0.5 text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
      >
        <Plus size={13} />
      </button>
      <button
        type="button"
        onClick={() => setDiffViewOpen(true)}
        disabled={!activeWs}
        title="Review the working-tree vs HEAD diff"
        className={cn('flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', diffViewOpen ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
      >
        <GitCommit size={13} /> Diff
      </button>
      <button
        type="button"
        onClick={() => setMemOpen(true)}
        disabled={!activeWs}
        title={`Repository intent rules (${memory.learnings.length} rule${memory.learnings.length === 1 ? '' : 's'})`}
        className={cn('flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-40', memOpen ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
      >
        <BookmarkPlus size={13} /> Memory{memory.learnings.length ? ` (${memory.learnings.length})` : ''}
      </button>
      <button
        type="button"
        className="rounded border border-line px-2 py-0.5 text-[11px] text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
        onClick={forkConversation}
        disabled={!activeWs || running}
        title="Fork this conversation into a new thread"
      >
        <GitFork size={13} />
      </button>
      <button
        type="button"
        className="rounded border border-line px-2 py-0.5 text-[11px] text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
        onClick={exportTranscript}
        disabled={!activeWs || messagesCount === 0}
        title="Export transcript as Markdown"
      >
        <Download size={13} />
      </button>
      <button
        type="button"
        className="rounded border border-line px-2 py-0.5 text-[11px] text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
        onClick={undoLastCommit}
        disabled={!activeWs || running || git.commits.length === 0}
        title="Undo last commit (changes stay in the worktree)"
      >
        <Undo2 size={13} />
      </button>
      <button
        type="button"
        className={cn('rounded border px-2 py-0.5 text-[11px] disabled:opacity-40', showCheckpoints ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line text-mute hover:bg-panel2 hover:text-ink')}
        onClick={() => setShowCheckpoints((o) => !o)}
        disabled={!activeWs}
        title="Checkpoints — snapshot transcript + workspace, restore on a wrong turn"
      >
        <BookmarkPlus size={13} />
      </button>
      <button
        className="rounded border border-line px-2 py-0.5 text-[11px] text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
        onClick={() => newChat(activeWs)}
        disabled={!activeWs || running}
        title="New conversation"
      >
        <Plus size={13} />
      </button>
    </div>
  );
};
