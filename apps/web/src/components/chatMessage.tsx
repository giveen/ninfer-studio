// Message-list rendering: the compaction divider, the collapsible reasoning
// block, per-message timing/usage badges, the row action toolbar, and the
// memoized message row itself (user/tool/assistant variants).

import { lazy, memo, useState, type ReactNode } from 'react';
import { BrainCircuit, ChevronDown, ChevronsRight, Copy, GitBranch, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { ChatMessage } from '../lib/types';
import { formatBytes, formatMs, formatRate, formatTokens } from '../lib/format';
import { Button, cn } from './ui';

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
export function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  // Collapsed by default — long chains-of-thought shouldn't dominate the view.
  // A live pulse shows while it's actively thinking; a short preview is shown so
  // the gist is visible without expanding.
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const preview = !open ? text.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-line bg-inset/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[11.5px] font-medium uppercase tracking-wider text-faint hover:text-mute"
      >
        <BrainCircuit size={13} className={open ? 'text-accent' : 'text-faint'} />
        thinking
        {streaming && !open && <span className="h-1.5 w-1.5 rounded-full bg-accent pulse-dot" />}
        <ChevronDown size={13} className={cn('ml-auto transition-transform', !open && '-rotate-90')} />
      </button>
      {!open && preview && (
        <div className="border-t border-line px-3 py-1.5 text-[12px] leading-snug text-faint line-clamp-2">
          {preview}…
        </div>
      )}
      {open && (
        <div className={cn('border-t border-line px-3 py-2 text-[12.5px] leading-relaxed text-mute', streaming && 'stream-caret')}>
          {/* While streaming, render reasoning as plain pre-wrapped text instead of
              re-parsing the whole (growing) markdown on every token — that O(n²)
              reparse is what froze the chat view on long thinking traces. */}
          {streaming ? (
            <div className="whitespace-pre-wrap break-words">{text}</div>
          ) : (
            <Markdown>{text}</Markdown>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageMeta({ m }: { m: ChatMessage }) {
  const t = m.meta;
  if (!t) return null;
  const items: Array<[string, string]> = [];
  if (t.finishReason) items.push([t.finishReason, '']);
  if (t.ttftMs !== undefined) items.push(['TTFT', formatMs(t.ttftMs)]);
  if (t.promptTokPerSec !== undefined) items.push(['prompt', formatRate(t.promptTokPerSec)]);
  if (t.decodeTokPerSec !== undefined) items.push(['decode', formatRate(t.decodeTokPerSec)]);
  if (t.cachedTokens) items.push(['cache', `${formatTokens(t.cachedTokens)} reused`]);
  if (t.promptTokens) items.push(['in', formatTokens(t.promptTokens)]);
  if (t.completionTokens) items.push(['out', formatTokens(t.completionTokens)]);
  if (t.reasoningTokens) items.push(['think', formatTokens(t.reasoningTokens)]);
  if (t.draftNAccepted !== undefined && t.draftN) {
    items.push(['draft', `${t.draftNAccepted}/${t.draftN} (${Math.round((t.draftNAccepted / t.draftN) * 100)}%)`]);
  }
  if (!items.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-faint">
      {items.map(([k, v], i) =>
        k === items[0][0] && v === '' ? (
          <span key={i} className="rounded border border-line bg-panel2 px-1.5 py-px text-mute">
            {k}
          </span>
        ) : (
          <span key={i} className="rounded border border-line bg-panel2 px-1.5 py-px">
            <span className="text-faint">{k}</span> <span className="text-mute">{v}</span>
          </span>
        ),
      )}
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

  if (m.role === 'user') {
    return (
      <div className="group relative flex justify-end">
        {toolbar}
        <div className="max-w-[78%] rounded-xl rounded-br-sm border border-line bg-panel2 px-3.5 py-2.5">
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
    return (
      <div className="group relative max-w-full my-2">
        <div className="flex items-center gap-2 mb-1">
           <span className="text-[10px] font-mono text-faint uppercase bg-inset px-1.5 py-0.5 rounded border border-line">Tool Result</span>
           <span className="text-[11px] font-semibold text-accent">{m.name}</span>
        </div>
        <div className="text-[12px] font-mono whitespace-pre-wrap bg-panel2 border border-line rounded p-2 overflow-auto max-h-48 text-mute">
           {m.content}
        </div>
      </div>
    );
  }

  return (
    <div className="group relative max-w-full">
      {toolbar}
      <div className="max-w-full">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">ninfer</span>
          {m.model && <span className="font-mono text-[10.5px] text-faint">{m.model}</span>}
          {streaming && <span className="h-1.5 w-1.5 rounded-full bg-accent pulse-dot" />}
        </div>
        <ReasoningBlock text={m.reasoning || ''} streaming={streaming && !m.content} />
        <div className={cn('rounded-xl rounded-tl-sm border border-line bg-panel px-3.5 py-2.5', streaming && m.content && 'stream-caret')}>
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
                <Markdown>{m.content}</Markdown>
              </div>
            )
          ) : !streaming && !m.reasoning && !m.tool_calls ? (
            <span className="text-[13px] text-faint">—</span>
          ) : null}
          {m.tool_calls && m.tool_calls.length > 0 && (
            <div className="mt-3 space-y-1.5 border-t border-line pt-2">
              <div className="text-[10px] font-semibold text-faint uppercase tracking-wider">Tool Calls</div>
              {m.tool_calls.map((tc, j) => (
                <div key={j} className="text-[11.5px] font-mono text-accent bg-accent/10 p-1.5 rounded-md flex items-start gap-1">
                  <span className="mt-0.5">⚡</span>
                  <span className="break-all">{tc.name}({tc.arguments})</span>
                </div>
              ))}
            </div>
          )}
        </div>
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
