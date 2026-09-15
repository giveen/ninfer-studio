import React, { Suspense, lazy } from 'react';
import { MessageSquare, Image, File, X } from 'lucide-react';
import { cn } from '../ui';
import { useFileTabs, GIT_BADGE_CLASS } from '../editor/tabModel';

const LazyEditorPane = lazy(() => import('../editor/EditorPane'));

export interface CoderWorkspaceTabsProps {
  tabs: ReturnType<typeof useFileTabs>;
  running: boolean;
  setFileDiffPath: (path: string | null) => void;
  children: React.ReactNode;
}

export function CoderWorkspaceTabs({
  tabs,
  running,
  setFileDiffPath,
  children,
}: CoderWorkspaceTabsProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* tab strip */}
      <div className="flex h-8 shrink-0 items-center overflow-x-auto border-b border-line bg-panel">
        <button
          type="button"
          className={cn('flex h-full shrink-0 items-center gap-1.5 border-r border-line px-3 text-[11.5px]', !tabs.activeTabId ? 'bg-panel2 text-ink' : 'text-mute hover:text-ink')}
          onClick={() => tabs.setActive(null)}
          title="Chat"
        >
          <MessageSquare size={12} className="shrink-0" /> Chat
          {running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" title="agent run in flight" />}
        </button>
        {tabs.tabs.map((t) => (
          <div key={t.id} className="flex h-full shrink-0 items-center border-r border-line">
            <button
              type="button"
              className={cn('flex h-full min-w-0 items-center gap-1.5 px-2.5 text-[11.5px]', tabs.activeTabId === t.id ? 'bg-panel2 text-ink' : 'text-mute hover:text-ink')}
              onClick={() => tabs.setActive(t.id)}
              title={t.path}
            >
              {t.kind === 'image' ? <Image size={12} className="shrink-0" /> : <File size={12} className="shrink-0" />}
              <span className="max-w-32 truncate font-mono text-[11px]">{t.path.split(/[\/]/).pop()}</span>
              {t.gitStatus && (
                <span className={cn('shrink-0 font-mono text-[10px] font-bold', GIT_BADGE_CLASS[t.gitStatus])} title={`git status: ${t.gitStatus}`}>
                  {t.gitStatus}
                </span>
              )}
              {t.status === 'conflict' && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="changed elsewhere since you opened it" />}
              {t.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="unsaved changes" />}
            </button>
            <button type="button" className="shrink-0 px-1 text-faint hover:text-ink" onClick={() => tabs.closeTab(t.id)} title={`Close ${t.path}`}>
              <X size={12} />
            </button>
          </div>
        ))}
        {tabs.notice && <span className="ml-2 shrink-0 text-[10.5px] text-warn">{tabs.notice}</span>}
      </div>
      <div className="min-h-0 flex-1">
        {/* Chat panel: always mounted, hidden while a file tab is active */}
        <div style={{ display: tabs.activeTabId ? 'none' : undefined }} className="flex h-full min-h-0 flex-col">
          {children}
        </div>
        {tabs.tabs.map((t) => (
          <div key={t.id} style={{ display: tabs.activeTabId === t.id ? undefined : 'none' }} className="flex h-full min-h-0 flex-col">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-[11.5px] text-faint">Loading editor…</div>}>
              <LazyEditorPane
                tab={t}
                active={tabs.activeTabId === t.id}
                onDocChange={(id, doc) => tabs.onDocChange(id, doc)}
                onSave={(id) => { void tabs.saveTab(id); }}
                onReload={(id) => { void tabs.reloadTab(id); }}
                onUndo={() => tabs.undoEdit(t.id)}
                onDiff={(path) => setFileDiffPath(path)}
                onResolve={(id, kind) => tabs.resolveConflict(id, kind)}
                undoDisabled={running}
              />
            </Suspense>
          </div>
        ))}
      </div>
    </div>
  );
}
