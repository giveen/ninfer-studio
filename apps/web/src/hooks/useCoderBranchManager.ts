import { useState, useCallback, useEffect, useRef } from 'react';

export interface UseCoderBranchManagerOptions {
  activeWs: string;
  running: boolean;
  gitCurrentBranch: string;
  createBranch: (name: string) => Promise<boolean>;
  switchBranch: (name: string) => Promise<boolean>;
  refreshRepoMap: () => void | Promise<void>;
  loadTree: () => void | Promise<void>;
  tabsRefreshRef: React.MutableRefObject<() => void>;
}

export function useCoderBranchManager({
  activeWs,
  running,
  gitCurrentBranch,
  createBranch,
  switchBranch,
  refreshRepoMap,
  loadTree,
  tabsRefreshRef,
}: UseCoderBranchManagerOptions) {
  const [showBranchMenu, setShowBranchMenu] = useState(false);
  const branchMenuRef = useRef<HTMLDivElement>(null);

  /** Prompt for a name, create the branch, and switch to it. */
  const handleCreateBranch = useCallback(async () => {
    if (!activeWs || running) return;
    const name = window.prompt('New branch name:');
    if (!name) return;
    const ok = await createBranch(name);
    if (ok) {
      void refreshRepoMap();
      void loadTree();
      tabsRefreshRef.current();
    }
  }, [activeWs, running, createBranch, refreshRepoMap, loadTree, tabsRefreshRef]);

  /** Switch to an existing branch from the branch menu. */
  const handleSwitchBranch = useCallback(
    async (name: string) => {
      setShowBranchMenu(false);
      if (!activeWs || running || name === gitCurrentBranch) return;
      const ok = await switchBranch(name);
      if (ok) {
        void refreshRepoMap();
        void loadTree();
        tabsRefreshRef.current();
      }
    },
    [activeWs, running, gitCurrentBranch, switchBranch, refreshRepoMap, loadTree, tabsRefreshRef],
  );

  // Close the branch menu on an outside click or Escape — it's a dropdown,
  // not a modal, so it shouldn't linger over the transcript.
  useEffect(() => {
    if (!showBranchMenu) return;
    const onDown = (e: MouseEvent) => {
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
        setShowBranchMenu(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowBranchMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showBranchMenu]);

  return {
    showBranchMenu,
    setShowBranchMenu,
    branchMenuRef,
    handleCreateBranch,
    handleSwitchBranch,
  };
}
