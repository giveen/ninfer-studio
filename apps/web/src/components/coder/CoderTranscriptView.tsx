import React, { Suspense, useState } from 'react';
import { BrainCircuit, Image, File, ArrowDown } from 'lucide-react';
import { cn } from '../ui';
import { ChatMessage } from '../../lib/types';

export type MessageGroup = {
  type: 'message' | 'trajectory' | 'compact';
  items: ChatMessage[];
};

export interface CoderTranscriptViewProps {
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  tabsActiveTabId: string | null;
  transcriptStick: React.MutableRefObject<boolean>;
  planMode: boolean;
  coderSafeMode: boolean;
  activeWs: string;
  activeWsDir?: string;
  messageGroups: MessageGroup[];
  running: boolean;
  pendingQuestion: string | null;
  onFollowUp: (q: string) => void;
  TrajectoryBlock: React.ComponentType<{ items: ChatMessage[]; workspace?: string }>;
  ReportBlock: React.ComponentType<{ message: ChatMessage; workspace?: string }>;
  Markdown: React.ComponentType<{ children: string; workspace?: string }>;
}

export const CoderTranscriptView: React.FC<CoderTranscriptViewProps> = ({
  transcriptRef,
  tabsActiveTabId,
  transcriptStick,
  planMode,
  coderSafeMode,
  activeWs,
  activeWsDir,
  messageGroups,
  running,
  pendingQuestion,
  onFollowUp,
  TrajectoryBlock,
  ReportBlock,
  Markdown,
}) => {
  const ws = activeWsDir ?? activeWs;
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const scrollToBottom = () => {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      transcriptStick.current = true;
      setShowScrollBottom(false);
    }
  };

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={transcriptRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (tabsActiveTabId) return;
          const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          transcriptStick.current = isAtBottom;
          setShowScrollBottom(!isAtBottom);
        }}
        className="flex-1 overflow-auto bg-panel2 space-y-4 p-4"
      >
        {planMode && (
          <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[11.5px] text-accent flex items-center gap-2">
            <BrainCircuit size={13} className="shrink-0" />
            <span>Plan mode is on — the agent investigates read-only and cannot write files or run commands. Turn it off to apply changes.</span>
          </div>
        )}
        {coderSafeMode && (
          <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[11.5px] text-warn flex items-center gap-2">
            <span>🛡</span>
            <span>Safe mode is on — destructive commands (e.g. <code className="font-mono">rm -rf /</code>, <code className="font-mono">git push --force</code>, piping a download into a shell) are blocked. Turn it off in Settings &gt; Safety &amp; Permissions only for trusted workspaces.</span>
          </div>
        )}
        {!activeWs ? (
          <div className="flex h-full items-center justify-center text-center text-[13px] text-faint">
            <div>
              <p>No workspace selected.</p>
              <p className="mt-1 text-[12px]">Click “Add” to point the coder at a folder.</p>
            </div>
          </div>
        ) : (
          messageGroups.map((g, i) => (
            <React.Fragment key={i}>
              {g.type === 'compact' ? (
                <ReportBlock message={{ ...g.items[0], displayName: g.items[0].displayName || 'Compaction Summary', collapsed: g.items[0].collapsed ?? true }} workspace={ws} />
              ) : g.type === 'trajectory' ? (
                <TrajectoryBlock items={g.items} workspace={ws} />
              ) : g.items[0].displayName && g.items[0].collapsed ? (
                <ReportBlock message={g.items[0]} workspace={ws} />
              ) : (
                <div className={cn("p-3 rounded-lg border mb-4", g.items[0].role === 'user' ? 'bg-panel border-line' : 'bg-panel border-accent/30')}>
                  <div className="font-semibold text-xs text-faint mb-1">{g.items[0].displayName ?? (g.items[0].role === 'assistant' ? 'Garrulous' : g.items[0].role)}</div>
                  {g.items[0].attachments?.length ? (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {g.items[0].attachments.map((a, i) => (
                        <span key={i} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel2 px-2 py-0.5 text-[11.5px] text-ink">{a.kind === 'image' ? <Image size={11} /> : <File size={11} />} {a.name}</span>
                      ))}
                    </div>
                  ) : null}
                  {g.items[0].content && (
                    g.items[0].role === 'assistant' || g.items[0].displayName
                      ? <div className="markdown text-[13.5px] leading-relaxed"><Suspense fallback={null}><Markdown workspace={ws}>{g.items[0].content}</Markdown></Suspense></div>
                      : <div className="text-sm whitespace-pre-wrap">{g.items[0].content}</div>
                  )}
                  {i === messageGroups.length - 1 && !running && !pendingQuestion && g.items[0].followUps && g.items[0].followUps.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {g.items[0].followUps.map((q, qi) => (
                        <button key={qi} type="button" onClick={() => onFollowUp(q)} className="rounded-full border border-line bg-panel px-2.5 py-1 text-[11.5px] text-mute hover:border-accent/40 hover:text-ink">
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
          ))
        )}
      </div>
      {showScrollBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 right-6 z-20 flex items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1.5 text-[11.5px] font-medium text-ink shadow-lg hover:bg-panel2 hover:border-accent/40 transition-all animate-bounce"
          title="Scroll to latest output"
        >
          <ArrowDown size={13} className="text-accent" />
          <span>Scroll to bottom</span>
        </button>
      )}
    </div>
  );
};
