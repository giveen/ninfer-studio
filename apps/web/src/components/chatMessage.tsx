// Message-list rendering: the compaction divider, the collapsible reasoning
// block, per-message timing/usage badges, the row action toolbar, and the
// memoized message row itself (user/tool/assistant variants).

import { lazy, memo, useState, type ReactNode } from 'react';
import { BrainCircuit, ChevronDown, ChevronsRight, Copy, GitBranch, Pencil, RefreshCw, Trash2, Zap, Clock, ArrowDownRight, ArrowUpRight, Cpu, Database } from 'lucide-react';
import type { ChatMessage } from '../lib/types';
import { formatBytes, formatMs, formatRate, formatTokens } from '../lib/format';
import { Button, cn } from './ui';
import { ReportBlock, CollapsibleToolResult, CollapsibleToolCalls } from './toolResults';

import { useChatAgent } from '../lib/chatAgent';

// Dynamically imported: react-markdown + remark-gfm + highlight.js is a
// ~300KB chunk that costs nothing at startup this way, only when the first
// completed (non-streaming) reply actually needs to render. Same shared
// lazy module as ChatScreen.tsx / CoderScreen.tsx / components/toolResults.tsx
// — every consumer must use dynamic import or Rollup folds the chunk back
// into the eager bundle for all of them.
const Markdown = lazy(() => import('./Markdown'));

// Subtle divider shown in place of the verbose compaction summary.
export function CompactDivider() {
  return (
    <div className="my-3 flex items-center gap-2 text-[11px] text-faint">
      <span className="h-px flex-1 bg-line" />
      <span>✂ Context compacted</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------
function ReasoningInline({ text, streaming, workspace }: { text: string; streaming?: boolean; workspace?: string }) {
  const [open, setOpen] = useState(false);
  const { showThinkingPreview } = useChatAgent();
  if (!text) return null;

  const preview = !open && showThinkingPreview ? text.replace(/\s+/g, ' ').trim().slice(0, 120) : '';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-faint hover:text-mute transition-colors"
      >
        <span className="text-faint/60">·</span>
        <span className="lowercase">thinking</span>
        {streaming ? (
          <span className="inline-flex items-center gap-0.5 font-bold text-accent">
            <span className="dot-wave-1">.</span>
            <span className="dot-wave-2">.</span>
            <span className="dot-wave-3">.</span>
          </span>
        ) : null}
        <ChevronDown size={11} className={cn('transition-transform text-faint', !open && '-rotate-90')} />
      </button>

      {!open && preview ? (
        <div className="my-1.5 w-full rounded-lg border border-line bg-inset/50 px-3 py-1.5 text-[12px] leading-snug text-faint line-clamp-2">
          {preview}…
        </div>
      ) : null}

      {open && (
        <div className={cn('my-1.5 w-full rounded-xl border border-line bg-inset/60 px-3 py-2 text-[12.5px] leading-relaxed text-mute', streaming && 'stream-caret')}>
          {streaming ? (
            <div className="whitespace-pre-wrap break-words">{text}</div>
          ) : (
            <Markdown workspace={workspace}>{text}</Markdown>
          )}
        </div>
      )}
    </>
  );
}

export function MessageMeta({ m }: { m: ChatMessage }) {
  const t = m.meta;
  if (!t) return null;

  const badges: Array<{ label: string; value: string; icon?: ReactNode }> = [];

  if (t.ttftMs !== undefined) {
    badges.push({ label: 'TTFT', value: formatMs(t.ttftMs), icon: <Clock size={11} className="text-info/80" /> });
  }
  if (t.promptTokPerSec !== undefined) {
    badges.push({ label: 'prompt', value: formatRate(t.promptTokPerSec), icon: <Zap size={11} className="text-accent" /> });
  }
  if (t.decodeTokPerSec !== undefined) {
    badges.push({ label: 'decode', value: formatRate(t.decodeTokPerSec), icon: <Cpu size={11} className="text-ok" /> });
  }
  if (t.cachedTokens) {
    badges.push({ label: 'cache', value: `${formatTokens(t.cachedTokens)} reused`, icon: <Database size={11} className="text-warn" /> });
  }
  if (t.promptTokens) {
    badges.push({ label: 'in', value: formatTokens(t.promptTokens), icon: <ArrowDownRight size={11} className="text-faint" /> });
  }
  if (t.completionTokens) {
    badges.push({ label: 'out', value: formatTokens(t.completionTokens), icon: <ArrowUpRight size={11} className="text-faint" /> });
  }
  if (t.reasoningTokens) {
    badges.push({ label: 'think', value: formatTokens(t.reasoningTokens), icon: <BrainCircuit size={11} className="text-accent" /> });
  }

  if (!badges.length && !t.finishReason) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-faint">
      {t.finishReason && (
        <span className="rounded-md border border-line bg-panel2/80 px-2 py-0.5 font-sans font-medium text-mute shadow-2xs">
          {t.finishReason}
        </span>
      )}
      {badges.map((b, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-md border border-line bg-panel2/80 px-2 py-0.5 transition-colors hover:border-line2"
        >
          {b.icon}
          <span className="text-faint">{b.label}</span>
          <span className="font-semibold text-mute">{b.value}</span>
        </span>
      ))}
    </div>
  );
}

export type MsgActions = {
  onCopy: (m: ChatMessage) => void;
  onRegenerate: (convId: string, i: number) => void;
  onEdit: (convId: string, i: number, text: string) => void;
  onDelete: (convId: string, i: number) => void;
  onBranch: (convId: string, i: number) => void;
  onContinue: (convId: string, i: number) => void;
  onFollowUp: (text: string) => void;
};

export function ActionBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-1 text-faint transition-colors hover:bg-panel2 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export const MessageRow = memo(function MessageRow({
  m,
  streaming,
  locked,
  convId,
  index,
  isLast,
  actions,
  workspace,
}: {
  m: ChatMessage;
  streaming?: boolean;
  /** A stream is in flight somewhere in this conversation — Regenerate/Edit
   *  are disabled so a second runStream can't race the first over the
   *  shared abortRef/streaming state (see runStream's placeholderId). */
  locked?: boolean;
  convId: string;
  index: number;
  /** Only the last message in the conversation can offer Continue — extending
   *  a truncated reply anywhere else would orphan the messages after it. */
  isLast?: boolean;
  actions: MsgActions;
  workspace?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const startEdit = () => {
    setDraft(m.content);
    setEditing(true);
  };
  const commitEdit = () => {
    const t = draft.trim();
    if (t) actions.onEdit(convId, index, t);
    setEditing(false);
  };

  const toolbar = (
    <div className="absolute right-1 top-1 z-10 flex items-center gap-0.5 rounded-md border border-line bg-panel/90 p-0.5 opacity-0 transition-opacity group-hover:opacity-100">
      <ActionBtn title="Copy" onClick={() => actions.onCopy(m)}>
        <Copy size={13} />
      </ActionBtn>
      {m.role === 'assistant' && (
        <ActionBtn title="Regenerate" onClick={() => actions.onRegenerate(convId, index)} disabled={locked}>
          <RefreshCw size={13} />
        </ActionBtn>
      )}
      {m.role === 'user' && (
        <ActionBtn title="Edit" onClick={startEdit} disabled={locked}>
          <Pencil size={13} />
        </ActionBtn>
      )}
      <ActionBtn title="Branch from here" onClick={() => actions.onBranch(convId, index)} disabled={locked}>
        <GitBranch size={13} />
      </ActionBtn>
      <ActionBtn title="Delete from here" onClick={() => actions.onDelete(convId, index)} disabled={locked}>
        <Trash2 size={13} />
      </ActionBtn>
    </div>
  );

  // Harness-injected reports (Deep Research findings) get a labeled,
  // collapsed-by-default block instead of showing up as a plain "user" wall
  // of text — same treatment Coder gives its Scout/Verify/Critic messages
  // (no row toolbar either: Edit/Regenerate don't apply to a report).
  if (m.displayName && m.collapsed) {
    return <ReportBlock message={m} workspace={workspace} />;
  }

  if (m.role === 'user') {
    return (
      <div className="group relative flex justify-end">
        {toolbar}
        <div className="max-w-[78%] rounded-2xl rounded-br-xs border border-line2 bg-panel2/90 px-4 py-3 shadow-xs">
          {editing ? (
            <div className="w-72 max-w-full">
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitEdit();
                  } else if (e.key === 'Escape') {
                    setEditing(false);
                  }
                }}
                rows={3}
                className="w-full resize-y rounded-lg border border-line bg-inset px-2.5 py-2 text-[13.5px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
              />
              <div className="mt-1 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  cancel
                </Button>
                <Button size="sm" onClick={commitEdit}>
                  save
                </Button>
              </div>
            </div>
          ) : (
            <>
              {m.attachments && m.attachments.length > 0 && (
                <div className="mb-2 flex flex-wrap items-start gap-2">
                  {m.attachments.map((a, i) =>
                    a.kind === 'image' && a.dataUrl ? (
                      <figure key={i} className="max-w-[280px]">
                        <img
                          src={a.dataUrl}
                          alt={a.name}
                          className="max-h-64 w-auto max-w-full rounded-md border border-line bg-panel2 object-contain"
                          loading="lazy"
                        />
                        <figcaption className="mt-0.5 truncate text-[10.5px] text-faint">{a.name}</figcaption>
                      </figure>
                    ) : a.kind === 'video' && a.dataUrl ? (
                      <figure key={i} className="max-w-[280px]">
                        <video src={a.dataUrl} controls className="max-h-64 w-auto max-w-full rounded-md border border-line bg-black" />
                        <figcaption className="mt-0.5 truncate text-[10.5px] text-faint">{a.name}</figcaption>
                      </figure>
                    ) : (
                      <span key={i} className="inline-flex items-center gap-1 rounded-md border border-line bg-inset px-2 py-1 text-[11px] text-mute">
                        {a.kind === 'image' ? '🖼' : a.kind === 'video' ? '🎞' : '📄'} {a.name}
                        {a.dataUrl && <span className="text-faint">{formatBytes(a.dataUrl.length * 0.75)}</span>}
                      </span>
                    ),
                  )}
                </div>
              )}
              {m.content && <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{m.content}</div>}
            </>
          )}
        </div>
      </div>
    );
  }

  if (m.role === 'tool') {
    return <CollapsibleToolResult name={m.name || 'tool'} content={m.content} />;
  }

  return (
    <div className="group relative max-w-full">
      {toolbar}
      <div className="max-w-full">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">ninfer</span>
          {m.model && <span className="font-mono text-[10.5px] text-faint">{m.model}</span>}
          {streaming && !m.reasoning && <span className="h-1.5 w-1.5 rounded-full bg-accent pulse-dot" />}
          <ReasoningInline text={m.reasoning || ''} streaming={streaming && !m.content} workspace={workspace} />
        </div>
        {(m.content || m.error || (m.tool_calls && m.tool_calls.length > 0) || (!streaming && !m.reasoning)) && (
          <div className={cn('rounded-2xl rounded-tl-xs border border-line bg-panel/90 px-4 py-3 shadow-xs', streaming && m.content && 'stream-caret')}>
            {m.error ? (
              <div>
                <div className="text-[13px] text-danger">{m.content}</div>
                <Button size="sm" variant="subtle" className="mt-2" onClick={() => actions.onRegenerate(convId, index)} disabled={locked}>
                  <RefreshCw size={12} /> retry
                </Button>
              </div>
            ) : m.content ? (
              // Plain text while streaming (see ReasoningBlock): avoids re-parsing the
              // growing answer through react-markdown on every token. Rendered to
              // proper markdown once the turn completes (streaming === false).
              streaming ? (
                <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{m.content}</div>
              ) : (
                <div className="markdown text-[13.5px] leading-relaxed">
                  <Markdown workspace={workspace}>{m.content}</Markdown>
                </div>
              )
            ) : !streaming && !m.reasoning && !m.tool_calls ? (
              <span className="text-[13px] text-faint">—</span>
            ) : null}
            {m.tool_calls && m.tool_calls.length > 0 && (
              <CollapsibleToolCalls toolCalls={m.tool_calls} />
            )}
          </div>
        )}
        {isLast && !m.error && !streaming && m.meta?.finishReason === 'length' && (
          <Button size="sm" variant="subtle" className="mt-1.5" onClick={() => actions.onContinue(convId, index)} disabled={locked}>
            <ChevronsRight size={12} /> continue
          </Button>
        )}
        {isLast && !streaming && m.followUps && m.followUps.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.followUps.map((q, qi) => (
              <button
                key={qi}
                type="button"
                onClick={() => actions.onFollowUp(q)}
                disabled={locked}
                className="rounded-full border border-line bg-panel px-3 py-1.5 text-left text-[12px] text-mute transition-colors hover:border-accent/40 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        <MessageMeta m={m} />
      </div>
    </div>
  );
});
