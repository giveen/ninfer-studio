import { useState, useCallback, useEffect, useRef } from 'react';
import type { FileNode } from '../lib/types';
import { coderTree } from '../lib/api';
import type { CoderStore } from '../lib/coderStore';

export interface UseCoderFileTreeOptions {
  activeWs: string;
  activeConv: string;
  activeWsDir: string;
  treeOpen: boolean;
  wsFlushed: number;
  wsAppliedDirRef: React.RefObject<string | null>;
  setStore: React.Dispatch<React.SetStateAction<CoderStore>>;
  refreshRepoMap: () => void | Promise<void>;
}

export function useCoderFileTree({
  activeWs,
  activeConv,
  activeWsDir,
  treeOpen,
  wsFlushed,
  wsAppliedDirRef,
  setStore,
  refreshRepoMap,
}: UseCoderFileTreeOptions) {
  const [treeNodes, setTreeNodes] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeExpanded, setTreeExpanded] = useState<Record<string, boolean>>({});
  const [treeChildren, setTreeChildren] = useState<Record<string, FileNode[]>>({});
  const treeSeqRef = useRef(0);

  const loadTree = useCallback(async () => {
    if (!activeWsDir) return;
    const seq = ++treeSeqRef.current;
    setTreeLoading(true);
    try {
      const t = await coderTree(6, '.');
      if (seq === treeSeqRef.current && wsAppliedDirRef.current === activeWsDir) {
        setTreeNodes(t.nodes ?? []);
      }
    } catch {
      if (seq === treeSeqRef.current) setTreeNodes([]);
    } finally {
      if (seq === treeSeqRef.current) setTreeLoading(false);
    }
  }, [activeWsDir, wsAppliedDirRef]);

  const onExpandDir = useCallback(
    async (node: FileNode) => {
      const willOpen = !treeExpanded[node.path];
      setTreeExpanded((e) => ({ ...e, [node.path]: willOpen }));
      if (willOpen && !(treeChildren[node.path] ?? node.children)) {
        try {
          const t = await coderTree(6, node.path);
          setTreeChildren((prev) => ({ ...prev, [node.path]: t.nodes ?? [] }));
        } catch {
          /* ignore — leave unexpanded */
        }
      }
    },
    [treeExpanded, treeChildren],
  );

  const toggleBind = useCallback(
    (path: string) => {
      if (!activeWs || !activeConv) return;
      setStore((prev) => {
        const wsd = prev.workspaces[activeWs];
        const c = wsd?.conversations[activeConv];
        if (!wsd || !c) return prev;
        const cur = c.boundPaths ?? [];
        const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
        return {
          ...prev,
          workspaces: {
            ...prev.workspaces,
            [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: { ...c, boundPaths: next } } },
          },
        };
      });
      void refreshRepoMap();
    },
    [activeWs, activeConv, refreshRepoMap, setStore],
  );

  const clearBinds = useCallback(() => {
    if (!activeWs || !activeConv) return;
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      const c = wsd?.conversations[activeConv];
      if (!wsd || !c) return prev;
      return {
        ...prev,
        workspaces: {
          ...prev.workspaces,
          [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: { ...c, boundPaths: [] } } },
        },
      };
    });
    void refreshRepoMap();
  }, [activeWs, activeConv, refreshRepoMap, setStore]);

  useEffect(() => {
    if (treeOpen) void loadTree();
  }, [activeWsDir, wsFlushed, treeOpen, loadTree]);

  return {
    treeNodes,
    treeLoading,
    treeExpanded,
    treeChildren,
    loadTree,
    onExpandDir,
    toggleBind,
    clearBinds,
  };
}
