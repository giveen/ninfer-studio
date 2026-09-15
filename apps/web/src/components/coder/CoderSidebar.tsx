import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Plus,
  Terminal,
  X,
  Pencil,
  Archive,
  Trash2,
  RotateCcw,
  Shield,
  GitCommit,
  Activity,
  RefreshCw,
  ChevronLeft,
} from 'lucide-react';
import { cn } from '../ui';
import type { CoderStore, LogEntry } from '../../lib/coderStore';
import type { McpToolInfo } from '../../lib/api';
import type { FileNode } from '../../lib/types';
import { TOOLS, type PermTier, type PermConfig, mcpServerKey, mcpToolTier, splitMcpName, DEFAULT_PERMS } from '../../lib/coderTools';
import { CommitsPanel } from './CommitsPanel';
import { JobsPanel } from './JobsPanel';
import { RunsPanel } from './RunsPanel';

export function SidebarSection({
  title,
  icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-3">
      <button
        type="button"
        className="mb-1.5 flex w-full items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-faint hover:text-ink"
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        {title}
        <ChevronDown size={12} className={`ml-auto shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && children}
    </div>
  );
}

export interface CoderSidebarProps {
  store: CoderStore;
  activeWs: string;
  activeConv: string;
  runConv: { ws: string; convId: string } | null;
  wsBusy: boolean;
  setShowDir: (v: boolean) => void;
  handleToggleExpand: (ws: string) => void;
  handleSelectWorkspace: (ws: string) => void;
  baseName: (p: string) => string;
  newChat: (ws: string) => void;
  handleRemoveWorkspace: (ws: string) => void;
  editingConv: { ws: string; cid: string } | null;
  setEditingConv: (val: { ws: string; cid: string } | null) => void;
  handleRenameConv: (ws: string, cid: string, title: string) => void;
  handleSelectConv: (ws: string, cid: string) => void;
  relTime: (t: number) => string;
  handleArchiveConv: (ws: string, cid: string, archive: boolean) => void;
  handleDeleteConv: (ws: string, cid: string) => void;
  archivedOpen: Record<string, boolean>;
  setArchivedOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  ledger: LogEntry[];
  perms: PermConfig;
  permsOpen: boolean;
  setPermsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setToolPerm: (name: string, tier: PermTier) => void;
  mcpTools: McpToolInfo[];
  activeWsDir: string;
  setPerms: (p: PermConfig) => void;
  setStore: React.Dispatch<React.SetStateAction<CoderStore>>;
  git: any;
  jobs: any;
  treeOpen: boolean;
  setTreeOpen: (v: boolean) => void;
  treeLoading: boolean;
  treeNodes: FileNode[];
  loadTree: () => Promise<void>;
  renderTree: (nodes: FileNode[], depth: number) => React.ReactNode;
  boundPaths: string[];
  clearBinds: () => void;
}

export const CoderSidebar: React.FC<CoderSidebarProps> = ({
  store,
  activeWs,
  activeConv,
  runConv,
  wsBusy,
  setShowDir,
  handleToggleExpand,
  handleSelectWorkspace,
  baseName,
  newChat,
  handleRemoveWorkspace,
  editingConv,
  setEditingConv,
  handleRenameConv,
  handleSelectConv,
  relTime,
  handleArchiveConv,
  handleDeleteConv,
  archivedOpen,
  setArchivedOpen,
  ledger,
  perms,
  permsOpen,
  setPermsOpen,
  setToolPerm,
  mcpTools,
  activeWsDir,
  setPerms,
  setStore,
  git,
  jobs,
  treeOpen,
  setTreeOpen,
  treeLoading,
  treeNodes,
  loadTree,
  renderTree,
  boundPaths,
  clearBinds,
}) => {
  return (
    <>
      <div className="flex w-72 flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line p-2 text-sm font-semibold">
          <Terminal size={14} /> Conversations
          <button
            className="ml-auto flex items-center gap-1 rounded border border-line px-2 py-0.5 text-[11px] font-normal text-mute hover:bg-panel2 hover:text-ink disabled:opacity-40"
            title="Add a workspace folder"
            onClick={() => setShowDir(true)}
            disabled={wsBusy}
          >
            <FolderPlus size={13} /> Add
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {Object.keys(store.workspaces).length === 0 && (
            <div className="p-3 text-[11px] italic text-faint">
              No workspaces yet — click “Add” to point the coder at a folder.
            </div>
          )}
          {Object.entries(store.workspaces).map(([ws, wsd]) => {
            const isActiveWs = ws === activeWs;
            return (
              <div key={ws} className="border-b border-line/60">
                <div className={cn('group flex items-center gap-1 px-1.5 py-1.5', isActiveWs ? 'bg-accent/10' : 'hover:bg-panel2')}>
                  <button
                    className="shrink-0 text-faint hover:text-ink"
                    onClick={() => handleToggleExpand(ws)}
                    title={wsd.expanded ? 'Collapse' : 'Expand'}
                  >
                    {wsd.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => handleSelectWorkspace(ws)} title={ws}>
                    <Folder size={13} className={cn('shrink-0', isActiveWs ? 'text-accent' : 'text-mute')} />
                    <span className={cn('truncate text-[12px] font-medium', isActiveWs ? 'text-ink' : 'text-mute')}>{baseName(ws)}</span>
                    <span className="shrink-0 rounded-full bg-panel2 px-1.5 text-[9.5px] text-faint">{wsd.order.length}</span>
                  </button>
                  <button
                    className="shrink-0 text-faint opacity-0 hover:text-ink group-hover:opacity-100"
                    title="New conversation in this workspace"
                    onClick={() => newChat(ws)}
                  >
                    <Plus size={13} />
                  </button>
                  <button
                    className="shrink-0 text-faint opacity-0 hover:text-danger group-hover:opacity-100"
                    title="Remove workspace"
                    onClick={() => handleRemoveWorkspace(ws)}
                  >
                    <X size={13} />
                  </button>
                </div>

                {wsd.expanded && (
                  <div className="space-y-0.5 pb-1.5 pl-6 pr-1.5">
                    {wsd.order
                      .filter((cid) => {
                        const c = wsd.conversations[cid];
                        return c && !c.archived;
                      })
                      .map((cid) => {
                        const c = wsd.conversations[cid];
                        if (!c) return null;
                        const isActive = ws === activeWs && cid === activeConv;
                        const isEditing = editingConv?.ws === ws && editingConv?.cid === cid;
                        const isRunning = runConv?.ws === ws && runConv?.convId === cid;
                        return (
                          <div
                            key={cid}
                            className={cn('group flex items-center gap-1 rounded px-1.5 py-1', isActive ? 'bg-accent/15 text-ink' : 'text-mute hover:bg-panel2')}
                          >
                            {isRunning && (
                              <span role="status" aria-label="Run in progress" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" title="Run in progress — this conversation keeps updating in the background" />
                            )}
                            {isEditing ? (
                              <input
                                autoFocus
                                defaultValue={c.title}
                                className="min-w-0 flex-1 rounded border border-line bg-inset px-1 py-0.5 text-[11.5px] outline-none focus:border-accent/50"
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleRenameConv(ws, cid, (e.target as HTMLInputElement).value);
                                  if (e.key === 'Escape') setEditingConv(null);
                                }}
                                onBlur={(e) => handleRenameConv(ws, cid, e.target.value)}
                              />
                            ) : (
                              <button
                                onClick={() => handleSelectConv(ws, cid)}
                                className={cn('min-w-0 flex-1 truncate text-left text-[11.5px]', isActive ? 'font-medium' : '')}
                                title={c.title}
                              >
                                {c.title || 'New conversation'}
                              </button>
                            )}
                            {c.updatedAt && !isEditing ? (
                              <span className="shrink-0 text-[9.5px] text-faint">{relTime(c.updatedAt)}</span>
                            ) : null}
                            {!isEditing && (
                              <div className="flex shrink-0 items-center gap-1 rounded bg-panel2/60 px-1 opacity-60 group-hover:opacity-100">
                                <button
                                  className="rounded p-1 text-faint hover:bg-panel hover:text-ink"
                                  title="Rename conversation"
                                  onClick={() => setEditingConv({ ws, cid })}
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  className="rounded p-1 text-faint hover:bg-panel hover:text-ink"
                                  title="Archive conversation"
                                  onClick={() => handleArchiveConv(ws, cid, true)}
                                >
                                  <Archive size={14} />
                                </button>
                                <button
                                  className="rounded p-1 text-faint hover:bg-panel hover:text-danger"
                                  title="Delete conversation"
                                  onClick={() => handleDeleteConv(ws, cid)}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}

                    {wsd.order.some((cid) => wsd.conversations[cid]?.archived) && (
                      <div className="pt-1">
                        <button
                          onClick={() => setArchivedOpen((o) => ({ ...o, [ws]: !o[ws] }))}
                          className="flex w-full items-center gap-1 px-1.5 py-1 text-[10.5px] text-faint hover:text-ink"
                        >
                          {archivedOpen[ws] ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          Archived ({wsd.order.filter((cid) => wsd.conversations[cid]?.archived).length})
                        </button>
                        {archivedOpen[ws] &&
                          wsd.order
                            .filter((cid) => wsd.conversations[cid]?.archived)
                            .map((cid) => {
                              const c = wsd.conversations[cid];
                              if (!c) return null;
                              const isActive = ws === activeWs && cid === activeConv;
                              return (
                                <div
                                  key={cid}
                                  className={cn('group flex items-center gap-1 rounded px-1.5 py-1', isActive ? 'bg-accent/15 text-ink' : 'text-faint hover:bg-panel2')}
                                >
                                  <button
                                    onClick={() => handleSelectConv(ws, cid)}
                                    className="min-w-0 flex-1 truncate text-left text-[11.5px] line-through"
                                    title={c.title}
                                  >
                                    {c.title || 'New conversation'}
                                  </button>
                                  <div className="flex shrink-0 items-center gap-1 rounded bg-panel2/60 px-1 opacity-60 group-hover:opacity-100">
                                    <button
                                      className="rounded p-1 text-faint hover:bg-panel hover:text-ink"
                                      title="Restore conversation"
                                      onClick={() => handleArchiveConv(ws, cid, false)}
                                    >
                                      <RotateCcw size={14} />
                                    </button>
                                    <button
                                      className="rounded p-1 text-faint hover:bg-panel hover:text-danger"
                                      title="Delete conversation"
                                      onClick={() => handleDeleteConv(ws, cid)}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Session Ledger */}
        <SidebarSection title="Session Ledger" defaultOpen={false}>
          <div className="max-h-44 shrink-0 overflow-auto border-t border-line p-2">
            <div className="space-y-1.5">
              {ledger.map((l) => (
                <div key={l.id} className="flex flex-col gap-0.5 border-l-2 border-line pl-2 ml-1 text-[10.5px]">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-faint">{new Date(l.time).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    <span className={cn(
                      "font-semibold",
                      l.type === 'error' ? 'text-danger' : 
                      l.type === 'bash' ? 'text-[#e5c07b]' : 
                      l.type === 'compact' ? 'text-accent' : 
                      l.type === 'todo' ? 'text-ok' : 'text-accent'
                    )}>{l.label}</span>
                    {l.durationMs !== undefined && <span className="text-faint ml-auto">{l.durationMs}ms</span>}
                  </div>
                  {l.detail && <div className="text-mute truncate font-mono" title={l.detail}>{l.detail}</div>}
                </div>
              ))}
              {ledger.length === 0 && <div className="text-faint italic text-[11px]">No activity yet.</div>}
            </div>
          </div>
        </SidebarSection>

        {/* Permissions */}
        <SidebarSection title="Permissions" icon={<Shield size={13} />} defaultOpen={false}>
          <div className="shrink-0 border-t border-line p-2">
            <div className="mb-1.5 flex items-center">
              <button
                type="button"
                className="ml-auto rounded p-0.5 text-faint hover:text-ink"
                title={permsOpen ? 'Collapse' : 'Expand'}
                onClick={() => setPermsOpen((o) => !o)}
              >
                {permsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
            </div>
            {permsOpen && (
              <>
                {!activeWs ? (
                  <div className="text-[10.5px] italic text-faint">Select a workspace.</div>
                ) : (
                  <>
                    <div className="max-h-36 space-y-1 overflow-auto">
                      {TOOLS.map((t) => {
                        const tier = perms.tools[t.function.name] ?? 'allow';
                        return (
                          <div key={t.function.name} className="flex items-center gap-1">
                            <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mute" title={t.function.description}>{t.function.name}</span>
                            {(['allow', 'ask', 'deny'] as PermTier[]).map((v) => (
                              <button
                                key={v}
                                type="button"
                                onClick={() => setToolPerm(t.function.name, v)}
                                title={`${v} ${t.function.name}`}
                                className={cn(
                                  'rounded px-1.5 py-px text-[10px] font-medium',
                                  tier === v
                                    ? v === 'allow' ? 'bg-ok/20 text-ok' : v === 'ask' ? 'bg-warn/20 text-warn' : 'bg-danger/20 text-danger'
                                    : 'text-faint hover:bg-panel2 hover:text-mute',
                                )}
                              >
                                {v}
                              </button>
                            ))}
                          </div>
                        );
                      })}
                      {mcpTools.length > 0 && (
                        <>
                          {Array.from(new Set(mcpTools.map((t) => mcpServerKey(t.name) ?? t.name))).map((serverKey) => {
                            const serverName = serverKey.replace(/^mcp__/, '');
                            const tools = mcpTools.filter((t) => mcpServerKey(t.name) === serverKey);
                            const serverTier = mcpToolTier(perms, serverKey);
                            return (
                              <div key={serverKey}>
                                <div className="flex items-center gap-1">
                                  <span
                                    className="min-w-0 flex-1 truncate font-mono text-[10.5px] font-semibold text-mute"
                                    title={`MCP server ${serverName} — this tier applies to every tool the server exposes unless a tool below overrides it`}
                                  >
                                    {serverName}
                                  </span>
                                  {(['allow', 'ask', 'deny'] as PermTier[]).map((v) => (
                                    <button
                                      key={v}
                                      type="button"
                                      onClick={() => setToolPerm(serverKey, v)}
                                      title={`${v} every tool from ${serverName}`}
                                      className={cn(
                                        'rounded px-1.5 py-px text-[10px] font-medium',
                                        serverTier === v
                                          ? v === 'allow' ? 'bg-ok/20 text-ok' : v === 'ask' ? 'bg-warn/20 text-warn' : 'bg-danger/20 text-danger'
                                          : 'text-faint hover:bg-panel2 hover:text-mute',
                                      )}
                                    >
                                      {v}
                                    </button>
                                  ))}
                                </div>
                                {tools.map((t) => {
                                  const tier = mcpToolTier(perms, t.name);
                                  const short = splitMcpName(t.name)?.tool ?? t.name;
                                  return (
                                    <div key={t.name} className="flex items-center gap-1 pl-3">
                                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-mute" title={t.description}>{short}</span>
                                      {(['allow', 'ask', 'deny'] as PermTier[]).map((v) => (
                                        <button
                                          key={v}
                                          type="button"
                                          onClick={() => setToolPerm(t.name, v)}
                                          title={`${v} ${t.name}`}
                                          className={cn(
                                            'rounded px-1.5 py-px text-[10px] font-medium',
                                            tier === v
                                              ? v === 'allow' ? 'bg-ok/20 text-ok' : v === 'ask' ? 'bg-warn/20 text-warn' : 'bg-danger/20 text-danger'
                                              : 'text-faint hover:bg-panel2 hover:text-mute',
                                          )}
                                        >
                                          {v}
                                        </button>
                                      ))}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </>
                      )}
                    </div>
                    <input
                      key={activeWs}
                      defaultValue={perms.denyPaths.join(' ')}
                      placeholder="Denied paths, space-separated (e.g. secrets/ .env)"
                      title="Tool calls touching these workspace-relative paths are denied"
                      onBlur={(e) => setPerms({ ...perms, denyPaths: e.target.value.split(/\s+/).map((s) => s.trim()).filter(Boolean) })}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      className="mt-1.5 w-full rounded border border-line bg-inset px-1.5 py-1 font-mono text-[10.5px] outline-none placeholder:text-faint focus:border-accent/50"
                    />
                    <div className="mt-2">
                      <div className="mb-1 text-[10.5px] font-semibold text-mute">Approved risky commands</div>
                      {(perms.approvedCommands || []).length === 0 ? (
                        <div className="text-[10px] italic text-faint">None yet. Risky commands (push, publish, ssh, sudo, docker, cloud/infra mutations…) prompt for approval; choose &quot;Approve &amp; remember&quot; to whitelist them here for this workspace.</div>
                      ) : (
                        <div className="max-h-28 space-y-1 overflow-auto">
                          {(perms.approvedCommands || []).map((c: string) => (
                            <div key={c} className="flex items-center gap-1 rounded border border-line bg-inset px-1.5 py-0.5">
                              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-mute" title={c}>{c}</span>
                              <button
                                type="button"
                                onClick={() => setStore((prev) => {
                                  const wsd = prev.workspaces[activeWs];
                                  if (!wsd) return prev;
                                  const cur = wsd.perms?.approvedCommands || [];
                                  return { ...prev, workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, perms: { ...(wsd.perms || DEFAULT_PERMS), approvedCommands: cur.filter((x) => x !== c) } } } };
                                })}
                                className="shrink-0 rounded p-0.5 text-faint hover:bg-danger/10 hover:text-danger"
                                title="Remove from approved list"
                              >
                                <Trash2 size={12} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </SidebarSection>

        {/* Commit History */}
        <SidebarSection title="Commit History" icon={<GitCommit size={13} />} defaultOpen={false}>
          <CommitsPanel git={git} />
        </SidebarSection>
        {/* Background Jobs */}
        <SidebarSection title="Jobs" icon={<Terminal size={13} />} defaultOpen={false}>
          <div className="shrink-0 border-t border-line p-2">
            <JobsPanel jobs={jobs} activeWsDir={activeWsDir} />
          </div>
        </SidebarSection>
        {/* Server Runs */}
        <SidebarSection title="Runs" icon={<Activity size={13} />} defaultOpen={false}>
          <div className="shrink-0 border-t border-line p-2">
            <RunsPanel />
          </div>
        </SidebarSection>
      </div>

      {/* File Tree panel */}
      {treeOpen ? (
        <div className="flex w-64 flex-col border-r border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line p-2 text-sm font-semibold">
            <Folder size={14} /> Files
            <button type="button" className="ml-auto rounded p-0.5 text-faint hover:text-ink" title="Refresh tree" onClick={() => void loadTree()}>
              <RefreshCw size={12} className={treeLoading ? 'animate-spin' : ''} />
            </button>
            <button type="button" className="rounded p-0.5 text-faint hover:text-ink" title="Collapse file tree" onClick={() => setTreeOpen(false)}>
              <ChevronLeft size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto text-[11.5px]">
            {treeLoading ? (
              <div className="p-3 text-faint">Loading…</div>
            ) : treeNodes.length === 0 ? (
              <div className="p-3 text-faint">No files.</div>
            ) : (
              renderTree(treeNodes, 0)
            )}
          </div>
          <div className="shrink-0 border-t border-line p-2 text-[10.5px] text-faint">
            System prompt follows <span className="text-ink">{boundPaths.length}</span> item{boundPaths.length === 1 ? '' : 's'}.
            {boundPaths.length > 0 && (
              <button type="button" className="ml-1 underline hover:text-ink" onClick={clearBinds}>Clear</button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="flex w-8 shrink-0 flex-col items-center justify-center gap-1 border-r border-line bg-panel text-faint hover:text-ink"
          title="Show file tree"
          onClick={() => { setTreeOpen(true); void loadTree(); }}
        >
          <Folder size={15} />
        </button>
      )}
    </>
  );
};
