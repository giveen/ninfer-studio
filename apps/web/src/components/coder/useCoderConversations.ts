import { useState } from 'react';
import {
  newConvId, emptyConv,
  type CoderStore, type WsData,
} from '../../lib/coderStore';

interface UseConversationHandlersOpts {
  store: CoderStore;
  setStore: React.Dispatch<React.SetStateAction<CoderStore>>;
  activeWs: string;
  activeConv: string;
  /** Load a conversation's live state into the visible transcript. */
  loadConv: (ws: string, convId: string) => void;
  /** Clear the visible transcript (no conversation selected). */
  clearView: () => void;
  /** True while the conversation hosts the in-flight (or paused ask_user) run — it can't be removed/hidden. */
  isPinned: (ws: string, convId: string) => boolean;
  /** True while any conversation in the workspace hosts the in-flight (or paused) run. */
  isWorkspacePinned: (ws: string) => boolean;
}

export interface ConversationHandlers {
  editingConv: { ws: string; cid: string } | null;
  setEditingConv: React.Dispatch<React.SetStateAction<{ ws: string; cid: string } | null>>;
  archivedOpen: Record<string, boolean>;
  setArchivedOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  handleSelectConv: (ws: string, convId: string) => void;
  handleSelectWorkspace: (ws: string) => void;
  handleToggleExpand: (ws: string) => void;
  handleAddWorkspace: (path: string) => void;
  handleRemoveWorkspace: (path: string) => void;
  handleRenameConv: (ws: string, cid: string, title: string) => void;
  handleArchiveConv: (ws: string, cid: string, archived: boolean) => void;
  handleDeleteConv: (ws: string, cid: string) => void;
}

/**
 * Conversation CRUD bound to the screen's store: selection, workspace
 * add/remove, rename/archive/delete. The store state itself stays in the
 * screen (transcript initializers read it before these handlers exist);
 * run-persistence paths keep using setStore directly.
 */
export function useConversationHandlers({
  store, setStore, activeWs, activeConv, loadConv, clearView, isPinned, isWorkspacePinned,
}: UseConversationHandlersOpts): ConversationHandlers {
  const [editingConv, setEditingConv] = useState<{ ws: string; cid: string } | null>(null);
  const [archivedOpen, setArchivedOpen] = useState<Record<string, boolean>>({});

  const handleSelectConv = (ws: string, convId: string) => {
    // Switching is a pure view change even mid-run: the in-flight run is pinned
    // to its own conversation and keeps persisting there, so the
    // visible transcript can follow the user without corruption (P0 #2).
    if (ws === activeWs && convId === activeConv) return;
    setStore((prev) => ({ ...prev, activeWs: ws, activeConv: convId }));
    loadConv(ws, convId);
  };

  const handleSelectWorkspace = (ws: string) => {
    const wsd = store.workspaces[ws];
    const cid = wsd?.activeConv ?? wsd?.order[0] ?? '';
    handleSelectConv(ws, cid);
  };

  const handleToggleExpand = (ws: string) => {
    setStore((prev) => {
      const wsd = prev.workspaces[ws];
      if (!wsd) return prev;
      return { ...prev, workspaces: { ...prev.workspaces, [ws]: { ...wsd, expanded: !wsd.expanded } } };
    });
  };

  const handleAddWorkspace = (path: string) => {
    const existing = store.workspaces[path];
    setStore((prev) => {
      if (existing) return { ...prev, activeWs: path, activeConv: existing.activeConv ?? existing.order[0] ?? '' };
      const id = newConvId();
      const ws: WsData = { expanded: true, conversations: { [id]: emptyConv(id) }, order: [id], activeConv: id };
      return { ...prev, activeWs: path, activeConv: id, workspaces: { ...prev.workspaces, [path]: ws } };
    });
    if (existing) {
      const cid = existing.activeConv ?? existing.order[0] ?? '';
      loadConv(path, cid);
    } else {
      clearView();
    }
  };

  const handleRemoveWorkspace = (path: string) => {
    // A workspace hosting the in-flight (or paused, ask_user) run's
    // conversation can't go away while its transcript is being written into it.
    if (isWorkspacePinned(path)) return;
    const workspaces = { ...store.workspaces };
    delete workspaces[path];
    const keys = Object.keys(workspaces);
    let aWs = store.activeWs;
    let aConv = store.activeConv;
    if (store.activeWs === path) {
      aWs = keys[0] ?? '';
      aConv = aWs ? (workspaces[aWs].activeConv ?? workspaces[aWs].order[0] ?? '') : '';
    }
    setStore((prev) => ({ ...prev, workspaces, activeWs: aWs, activeConv: aConv }));
    if (aWs && aConv) loadConv(aWs, aConv);
    else clearView();
  };

  const handleRenameConv = (ws: string, cid: string, title: string) => {
    const t = title.trim();
    setEditingConv(null);
    if (!t) return;
    setStore((prev) => {
      const wsd = prev.workspaces[ws];
      const c = wsd?.conversations[cid];
      if (!wsd || !c) return prev;
      return {
        ...prev,
        workspaces: { ...prev.workspaces, [ws]: { ...wsd, conversations: { ...wsd.conversations, [cid]: { ...c, title: t } } } },
      };
    });
  };

  const handleArchiveConv = (ws: string, cid: string, archived: boolean) => {
    // Hiding the conversation an in-flight (or paused, ask_user) run is pinned
    // to would strand its live transcript; restoring it is always fine.
    if (archived && isPinned(ws, cid)) return;
    const wsd = store.workspaces[ws];
    const c = wsd?.conversations[cid];
    if (!wsd || !c) return;
    const isActive = store.activeWs === ws && store.activeConv === cid;
    let aWs = store.activeWs;
    let aConv = store.activeConv;
    if (archived && isActive) {
      const other = wsd.order.find((id) => id !== cid && !wsd.conversations[id]?.archived);
      aConv = other ?? '';
    }
    setStore((prev) => {
      const w = prev.workspaces[ws];
      if (!w) return prev;
      const conv = w.conversations[cid];
      if (!conv) return prev;
      return {
        ...prev,
        activeWs: aWs,
        activeConv: aConv,
        workspaces: { ...prev.workspaces, [ws]: { ...w, activeConv: aConv, conversations: { ...w.conversations, [cid]: { ...conv, archived } } } },
      };
    });
    if (archived && isActive) {
      if (aConv) loadConv(aWs, aConv);
      else clearView();
    }
  };

  const handleDeleteConv = (ws: string, cid: string) => {
    if (isPinned(ws, cid)) return; // pinned by the in-flight / paused run
    if (!window.confirm('Delete this conversation? This cannot be undone.')) return;
    const wsd = store.workspaces[ws];
    if (!wsd) return;
    const isActive = store.activeWs === ws && store.activeConv === cid;
    let aWs = store.activeWs;
    let aConv = store.activeConv;
    if (isActive) {
      const remaining = wsd.order.filter((id) => id !== cid);
      aConv = remaining.find((id) => !wsd.conversations[id]?.archived) ?? remaining[0] ?? '';
    }
    setStore((prev) => {
      const w = prev.workspaces[ws];
      if (!w) return prev;
      const convs = { ...w.conversations };
      delete convs[cid];
      const order = w.order.filter((id) => id !== cid);
      return {
        ...prev,
        activeWs: aWs,
        activeConv: aConv,
        workspaces: { ...prev.workspaces, [ws]: { ...w, activeConv: aConv, conversations: convs, order } },
      };
    });
    if (isActive) {
      if (aConv) loadConv(aWs, aConv);
      else clearView();
    }
  };

  return {
    editingConv, setEditingConv, archivedOpen, setArchivedOpen,
    handleSelectConv, handleSelectWorkspace, handleToggleExpand,
    handleAddWorkspace, handleRemoveWorkspace, handleRenameConv,
    handleArchiveConv, handleDeleteConv,
  };
}
