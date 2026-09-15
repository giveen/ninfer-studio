import { useCallback } from 'react';
import { coderExec } from '../lib/api';
import type { LogEntry } from '../lib/coderStore';

export interface UseCoderUndoOptions {
  activeWsDir: string;
  running: boolean;
  gitCommits: Array<{ hash: string; subject: string }>;
  loadGitCommits: () => void;
  refreshRepoMap: () => void | Promise<void>;
  tabsRefreshRef: React.MutableRefObject<() => void>;
  addLog: (entry: Omit<LogEntry, 'id' | 'time'>) => void;
}

export function useCoderUndo({
  activeWsDir,
  running,
  gitCommits,
  loadGitCommits,
  refreshRepoMap,
  tabsRefreshRef,
  addLog,
}: UseCoderUndoOptions) {
  /** Undo the last commit (soft reset — changes stay in the worktree). Recoverable via reflog. */
  const undoLastCommit = useCallback(async () => {
    if (running || !activeWsDir || gitCommits.length === 0) return;
    const top = gitCommits[0];
    if (!window.confirm(`Undo commit ${top.hash.slice(0, 7)} "${top.subject}"?\n\nChanges stay in the worktree (git reset --soft).`))
      return;
    addLog({ type: 'bash', label: 'undo', detail: top.hash.slice(0, 7) });
    try {
      const r = await coderExec('git reset --soft HEAD~1', undefined, 30000, activeWsDir, false, undefined, activeWsDir);
      if (r.exitCode !== 0) {
        addLog({ type: 'error', label: 'undo', detail: (r.stderr || r.stdout || 'undo failed').slice(0, 300) });
      }
    } catch (e) {
      addLog({ type: 'error', label: 'undo', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      loadGitCommits();
      void refreshRepoMap();
    }
  }, [running, activeWsDir, gitCommits, loadGitCommits, refreshRepoMap, addLog]);

  /** File-grained undo: revert the active file to its state before the most recent
   * commit that touched it (creating a recoverable undo commit). If the file has
   * only uncommitted changes, they're discarded; if it was created in that
   * commit, it's removed. */
  const undoFileEdit = useCallback(
    async (path: string) => {
      if (running || !activeWsDir) return;
      const q = (s: string) => `'${String(s).replace(/'/g, "'\\''")}'`;
      const p = q(path);
      const refresh = async () => {
        loadGitCommits();
        void refreshRepoMap();
        // Re-fetch open tabs (adopt the new disk content or flag a conflict).
        tabsRefreshRef.current();
      };
      if (
        !window.confirm(
          `Undo the last edit to ${path}?\n\nReverts this file to its previous committed state (a new undo commit is created).`,
        )
      )
        return;
      addLog({ type: 'bash', label: 'undo-file', detail: path });
      // Find the most recent commit that touched this file.
      const last = await coderExec(`git log -1 --format=%H -- ${p}`, undefined, 15000, activeWsDir, false, undefined, activeWsDir);
      const hash = (last.stdout || '').trim();
      if (!hash) {
        // No commit touched it — discard uncommitted working changes (if any).
        const dis = await coderExec(`git checkout -- ${p}`, undefined, 15000, activeWsDir, false, undefined, activeWsDir);
        if (dis.exitCode !== 0) {
          addLog({ type: 'error', label: 'undo-file', detail: `no commit and cannot discard changes for ${path}` });
          return;
        }
        addLog({ type: 'bash', label: 'undo-file', detail: `discarded working changes to ${path}` });
        await refresh();
        return;
      }
      // Root commit has no parent → no prior version to revert to.
      const parentOk = await coderExec(`git rev-parse ${hash}^`, undefined, 15000, activeWsDir, false, undefined, activeWsDir);
      if (parentOk.exitCode !== 0) {
        addLog({ type: 'error', label: 'undo-file', detail: `cannot undo root-commit change to ${path} (no prior version)` });
        return;
      }
      // Did the file exist before this commit? If not, it was created here → delete it.
      const existed = await coderExec(`git cat-file -e ${hash}^:${p}`, undefined, 15000, activeWsDir, false, undefined, activeWsDir);
      const res =
        existed.exitCode === 0
          ? await coderExec(`git checkout ${hash}^ -- ${p}`, undefined, 15000, activeWsDir, false, undefined, activeWsDir)
          : await coderExec(`git rm -f -- ${p}`, undefined, 15000, activeWsDir, false, undefined, activeWsDir);
      if (res.exitCode !== 0) {
        addLog({ type: 'error', label: 'undo-file', detail: (res.stderr || res.stdout || 'undo failed').slice(0, 300) });
        return;
      }
      const c = await coderExec(
        `git add -A -- ${p} && git commit -m ${q(`undo: revert ${path}`)}`,
        undefined,
        30000,
        activeWsDir,
        false,
        undefined,
        activeWsDir,
      );
      if (c.exitCode !== 0) {
        addLog({ type: 'error', label: 'undo-file', detail: (c.stderr || c.stdout || 'commit failed').slice(0, 300) });
      } else {
        addLog({ type: 'bash', label: 'undo-file', detail: `reverted last edit to ${path}` });
      }
      await refresh();
    },
    [running, activeWsDir, loadGitCommits, refreshRepoMap, tabsRefreshRef, addLog],
  );

  return {
    undoLastCommit,
    undoFileEdit,
  };
}
