import { useCallback, useEffect, useRef, useState } from 'react';
import { coderExec, coderGitLog } from '../../lib/api';
import type { CoderCommit } from '../../lib/api';
import type { LogEntry } from '../../lib/coderStore';

export interface CoderGit {
  commits: CoderCommit[];
  commitsLoading: boolean;
  commitsOpen: boolean;
  setCommitsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  expandedCommit: string | null;
  setExpandedCommit: React.Dispatch<React.SetStateAction<string | null>>;
  loadCommits: () => Promise<void>;
  revertCommit: (hash: string) => Promise<void>;
}

interface UseCoderGitOpts {
  activeWsDir: string;
  activeWs: string;
  wsFlushed: number;
  running: boolean;
  onLog: (entry: Omit<LogEntry, 'id' | 'time'>) => void;
}

/** Commit-history panel: guarded git-log fetch + one-click revert. */
export function useCoderGit({ activeWsDir, activeWs, wsFlushed, running, onLog }: UseCoderGitOpts): CoderGit {
  const [commits, setCommits] = useState<CoderCommit[]>([]);
  const [commitsOpen, setCommitsOpen] = useState(true);
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);
  // Generation counter for the commits panel fetch (same switch-race guard
  // as the tree/memory panels: only the newest response wins).
  const commitsSeqRef = useRef(0);

  const loadCommits = useCallback(async () => {
    const seq = ++commitsSeqRef.current;
    setCommitsLoading(true);
    try {
      const commits = await coderGitLog(100);
      if (seq !== commitsSeqRef.current) return; // a newer workspace/flush generation won
      setCommits(commits);
    } catch {
      // Keep the last good list rather than wiping it on a transient backend
      // blip (M2). An empty workspace simply shows no commits.
    } finally {
      if (seq === commitsSeqRef.current) setCommitsLoading(false);
    }
  }, []);

  /** One-click revert: creates a new commit undoing `hash` (safe — itself revertable). */
  const revertCommit = useCallback(async (hash: string) => {
    if (running || !activeWsDir) return;
    if (!/^[0-9a-f]{7,40}$/i.test(hash)) return;
    onLog({ type: 'bash', label: 'revert', detail: hash.slice(0, 7) });
    try {
      const r = await coderExec(`git revert --no-edit ${hash}`, undefined, 30000, activeWsDir);
      if (r.exitCode !== 0) {
        onLog({ type: 'error', label: 'revert', detail: (r.stderr || r.stdout || 'revert failed').slice(0, 300) });
      }
    } catch (e) {
      onLog({ type: 'error', label: 'revert', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      loadCommits();
    }
  }, [running, activeWs, activeWsDir, loadCommits, onLog]);

  // Refresh the commit history whenever the active workspace changes (or the
  // control-plane re-point is flushed after a held mid-run switch — wsFlushed).
  useEffect(() => {
    if (activeWsDir) loadCommits();
  }, [activeWsDir, wsFlushed, loadCommits]);

  return {
    commits, commitsLoading, commitsOpen, setCommitsOpen,
    expandedCommit, setExpandedCommit, loadCommits, revertCommit,
  };
}
