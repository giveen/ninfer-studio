import { useCallback, useEffect, useRef, useState } from 'react';
import { coderExec, coderGitLog } from '../../lib/api';
import type { CoderCommit } from '../../lib/api';
import type { LogEntry } from '../../lib/coderStore';
import { GIT_BRANCH_LIST_CMD, parseBranchList, shellQuote } from '../../lib/gitStatus';

export interface CoderGit {
  commits: CoderCommit[];
  commitsLoading: boolean;
  commitsOpen: boolean;
  setCommitsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  expandedCommit: string | null;
  setExpandedCommit: React.Dispatch<React.SetStateAction<string | null>>;
  loadCommits: () => Promise<void>;
  revertCommit: (hash: string) => Promise<void>;
  currentBranch: string;
  branches: string[];
  branchesLoading: boolean;
  loadBranches: () => Promise<void>;
  createBranch: (name: string) => Promise<boolean>;
  switchBranch: (name: string) => Promise<boolean>;
}

// First char must be alnum — rules out a leading '-' (which git would read as
// a flag, e.g. a branch literally named "--force") or a leading '.' or '/'.
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

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

  const [currentBranch, setCurrentBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const branchesSeqRef = useRef(0);

  const loadBranches = useCallback(async () => {
    const seq = ++branchesSeqRef.current;
    setBranchesLoading(true);
    try {
      const r = await coderExec(GIT_BRANCH_LIST_CMD, undefined, 15000, activeWsDir);
      if (seq !== branchesSeqRef.current) return;
      const { current, branches } = parseBranchList(r.stdout || '');
      setCurrentBranch(current);
      setBranches(branches);
    } catch {
      // Keep the last good list on a transient blip.
    } finally {
      if (seq === branchesSeqRef.current) setBranchesLoading(false);
    }
  }, [activeWsDir]);

  /** Client-side shape check, then git's own authoritative name validator —
   * catches rules the regex can't cheaply express (double dots, a trailing
   * dot, a `.lock` suffix, etc) in one round-trip. */
  const isValidBranchName = useCallback(async (trimmed: string): Promise<boolean> => {
    if (!trimmed || !BRANCH_NAME_RE.test(trimmed)) return false;
    try {
      const r = await coderExec(`git check-ref-format --branch ${shellQuote(trimmed)}`, undefined, 10000, activeWsDir);
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }, [activeWsDir]);

  /** Shared tail for a branch-mutating git command: run it, log + report
   * failure, and refresh branches/commits either way. */
  const runGitBranchOp = useCallback(async (cmd: string, failMsg: string): Promise<boolean> => {
    try {
      const r = await coderExec(cmd, undefined, 30000, activeWsDir);
      if (r.exitCode !== 0) {
        onLog({ type: 'error', label: 'branch', detail: (r.stderr || r.stdout || failMsg).slice(0, 300) });
        return false;
      }
      return true;
    } catch (e) {
      onLog({ type: 'error', label: 'branch', detail: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      loadBranches();
      loadCommits();
    }
  }, [activeWsDir, onLog, loadBranches, loadCommits]);

  /** Create a branch and switch to it. */
  const createBranch = useCallback(async (name: string): Promise<boolean> => {
    if (running || !activeWsDir) return false;
    const trimmed = name.trim();
    if (trimmed === currentBranch || branches.includes(trimmed)) {
      onLog({ type: 'error', label: 'branch', detail: `branch already exists: ${trimmed}` });
      return false;
    }
    if (!(await isValidBranchName(trimmed))) {
      onLog({ type: 'error', label: 'branch', detail: `invalid branch name: ${name}` });
      return false;
    }
    onLog({ type: 'bash', label: 'branch', detail: `+ ${trimmed}` });
    return runGitBranchOp(`git checkout -b ${shellQuote(trimmed)}`, 'create failed');
  }, [running, activeWsDir, onLog, currentBranch, branches, isValidBranchName, runGitBranchOp]);

  /** Switch to an existing branch. Warns first if a TRACKED file is dirty —
   * git carries compatible changes over silently and only refuses on an
   * actual conflict (checked below via exitCode), which surprises anyone
   * expecting a clean switch. Purely untracked files are skipped: they can
   * never conflict with a branch switch, so warning about them would just
   * be noise on top of the exitCode check that already catches real problems. */
  const switchBranch = useCallback(async (name: string): Promise<boolean> => {
    if (running || !activeWsDir) return false;
    const trimmed = name.trim();
    if (!(await isValidBranchName(trimmed))) {
      onLog({ type: 'error', label: 'branch', detail: `invalid branch name: ${name}` });
      return false;
    }
    if (trimmed === currentBranch) return false;
    try {
      const st = await coderExec('git status --porcelain', undefined, 10000, activeWsDir);
      const trackedDirty = (st.stdout || '').split('\n').some((l) => l.trim() && !l.startsWith('??'));
      if (trackedDirty) {
        const proceed = window.confirm(
          `You have uncommitted changes. Switching to "${trimmed}" will carry them over, or fail if they conflict with that branch. Continue?`
        );
        if (!proceed) return false;
      }
    } catch (e) {
      onLog({ type: 'error', label: 'branch', detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
    onLog({ type: 'bash', label: 'branch', detail: `switch ${trimmed}` });
    return runGitBranchOp(`git switch ${shellQuote(trimmed)}`, 'switch failed');
  }, [running, activeWsDir, onLog, currentBranch, isValidBranchName, runGitBranchOp]);

  useEffect(() => {
    if (activeWsDir) loadBranches();
  }, [activeWsDir, wsFlushed, loadBranches]);

  return {
    commits, commitsLoading, commitsOpen, setCommitsOpen,
    expandedCommit, setExpandedCommit, loadCommits, revertCommit,
    currentBranch, branches, branchesLoading, loadBranches, createBranch, switchBranch,
  };
}
