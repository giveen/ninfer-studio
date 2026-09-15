import { useState, useCallback } from 'react';
import type { ChatMessage } from '../lib/types';
import { coderExec } from '../lib/api';
import type { Checkpoint, CoderStore, LogEntry, TodoItem } from '../lib/coderStore';

const MAX_AUTO_CHECKPOINTS = 5;

export interface UseCoderCheckpointsOptions {
  activeWs: string;
  activeConv: string;
  activeWsDir: string;
  messages: ChatMessage[];
  ledger: LogEntry[];
  todos: TodoItem[];
  running: boolean;
  setStore: React.Dispatch<React.SetStateAction<CoderStore>>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setLedger: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  applyTodos: (nextTodos: TodoItem[], ts?: number | null) => void;
  addLog: (entry: Omit<LogEntry, 'id' | 'time'>) => void;
  loadGitCommits?: () => void;
  refreshRepoMap?: () => void;
}

export function useCoderCheckpoints({
  activeWs,
  activeConv,
  activeWsDir,
  messages,
  ledger,
  todos,
  running,
  setStore,
  setMessages,
  setLedger,
  applyTodos,
  addLog,
  loadGitCommits,
  refreshRepoMap,
}: UseCoderCheckpointsOptions) {
  const [showCheckpoints, setShowCheckpoints] = useState(false);

  /** Snapshot the transcript/todos plus the workspace HEAD (transcript-only outside git).
   *  `auto: true` is used for the once-per-turn safety snapshot taken right before the
   *  first mutating tool call — silent (doesn't pop the panel open) and capped. */
  const createCheckpoint = useCallback(
    async (opts?: { auto?: boolean }) => {
      if (!activeWs || !activeConv) return;
      let commit = '';
      try {
        const r = await coderExec('git rev-parse HEAD', undefined, 10000, activeWsDir, false, undefined, activeWsDir);
        if (r.exitCode === 0 && /^[0-9a-f]{5,40}$/i.test((r.stdout || '').trim())) commit = (r.stdout || '').trim();
      } catch {
        /* not a git repo — transcript-only checkpoint */
      }
      const auto = opts?.auto ?? false;
      const cp: Checkpoint = {
        id: 'cp-' + crypto.randomUUID(),
        time: Date.now(),
        label: commit ? commit.slice(0, 7) : 'transcript',
        commit,
        messages: messages.length,
        ledger: ledger.length,
        todos,
        auto,
      };
      setStore((prev) => {
        const wsd = prev.workspaces[activeWs];
        const meta = wsd?.conversations[activeConv];
        if (!wsd || !meta) return prev;
        let list = [...(meta.checkpoints ?? []), cp];
        if (auto) {
          const autoIds = list.filter((c) => c.auto).map((c) => c.id);
          if (autoIds.length > MAX_AUTO_CHECKPOINTS) {
            const drop = new Set(autoIds.slice(0, autoIds.length - MAX_AUTO_CHECKPOINTS));
            list = list.filter((c) => !drop.has(c.id));
          }
        }
        const next = { ...meta, checkpoints: list };
        return {
          ...prev,
          workspaces: {
            ...prev.workspaces,
            [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: next } },
          },
        };
      });
      addLog({
        type: 'compact',
        label: auto ? 'checkpoint (auto)' : 'checkpoint',
        detail: `saved (${cp.messages} msgs${commit ? ` @ ${cp.label}` : ', no git repo'})`,
      });
      if (!auto) setShowCheckpoints(true);
    },
    [activeWs, activeConv, activeWsDir, messages.length, ledger.length, todos, setStore, addLog],
  );

  /** Restore a checkpoint: hard-reset the workspace, then truncate transcript + todos. */
  const restoreCheckpoint = useCallback(
    async (cp: Checkpoint) => {
      if (running || !activeWs || !activeConv) return;
      const wsFiles = cp.commit
        ? `Workspace files reset to ${cp.label} (git reset --hard). Uncommitted changes will be lost.`
        : 'No git commit recorded — only the transcript will be truncated.';
      if (
        !window.confirm(
          `Restore checkpoint from ${new Date(cp.time).toLocaleString()}?\n\n${wsFiles}\nTranscript truncated to ${cp.messages} messages.`,
        )
      )
        return;
      if (cp.commit) {
        if (!/^[0-9a-f]{5,40}$/i.test(cp.commit)) return;
        const r = await coderExec(`git reset --hard ${cp.commit}`, undefined, 30000, activeWsDir, false, undefined, activeWsDir);
        if (r.exitCode !== 0) {
          addLog({ type: 'error', label: 'restore', detail: (r.stderr || r.stdout || 'reset failed').slice(0, 300) });
        }
        loadGitCommits?.();
        refreshRepoMap?.();
      }
      const keptMessages = messages.slice(0, cp.messages);
      const keptLedger = ledger.slice(0, cp.ledger);
      setMessages(keptMessages);
      applyTodos(cp.todos, null);
      setLedger([
        ...keptLedger,
        { id: crypto.randomUUID(), time: Date.now(), type: 'compact', label: 'restore', detail: `restored checkpoint ${cp.label}` },
      ]);
      setStore((prev) => {
        const wsd = prev.workspaces[activeWs];
        const meta = wsd?.conversations[activeConv];
        if (!wsd || !meta) return prev;
        return {
          ...prev,
          workspaces: {
            ...prev.workspaces,
            [activeWs]: {
              ...wsd,
              conversations: {
                ...wsd.conversations,
                [activeConv]: {
                  ...meta,
                  messages: keptMessages,
                  todos: cp.todos,
                  todosUpdatedAt: undefined,
                  updatedAt: Date.now(),
                },
              },
            },
          },
        };
      });
    },
    [running, activeWs, activeConv, activeWsDir, messages, ledger, setMessages, applyTodos, setLedger, setStore, addLog, loadGitCommits, refreshRepoMap],
  );

  const deleteCheckpoint = useCallback(
    (id: string) => {
      if (!activeWs || !activeConv) return;
      setStore((prev) => {
        const wsd = prev.workspaces[activeWs];
        const meta = wsd?.conversations[activeConv];
        if (!wsd || !meta) return prev;
        return {
          ...prev,
          workspaces: {
            ...prev.workspaces,
            [activeWs]: {
              ...wsd,
              conversations: {
                ...wsd.conversations,
                [activeConv]: { ...meta, checkpoints: (meta.checkpoints ?? []).filter((c) => c.id !== id) },
              },
            },
          },
        };
      });
    },
    [activeWs, activeConv, setStore],
  );

  return {
    showCheckpoints,
    setShowCheckpoints,
    createCheckpoint,
    restoreCheckpoint,
    deleteCheckpoint,
  };
}
