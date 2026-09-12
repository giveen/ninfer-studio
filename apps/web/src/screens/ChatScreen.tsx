import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from 'react';
import {
  BrainCircuit,
  ChevronDown,
  ChevronsRight,
  Copy,
  Download,
  Gauge,
  GitBranch,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { coderWebFetch, coderWebSearch, buildChatRequest, frameCompactedSummary, getConversations, saveConversations, streamChat, suggestFollowUps, summarizeConversation } from '../lib/api';
import { effectiveSystemPrompt, effectiveVoice, evaluate, needsHumanize, humanizeRewriteText, HUMANIZE_MAX_DEPTH, VOICE_PROFILES, type VoiceProfile } from '../lib/notai';

// A legacy compaction checkpoint message (raw <compacted-summary> block).
function isCompactedMsg(m: ChatMessage): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.includes('<compacted-summary>');
}

// Build the model context for a conversation. When compacted, prepend the summary
// as leading context and keep only the messages added after compaction; the full
// visible history is preserved separately for browsing. Also drops empty/
// incomplete assistant turns (e.g. an aborted placeholder) so every call site
// gets the same "don't send a blank assistant message" behavior instead of
// each caller having to remember to filter it out itself.
function modelHistory(conv: Conversation): ChatMessage[] {
  const tail = conv.compactedSummary ? conv.messages.slice(conv.compactedCount ?? 0) : conv.messages;
  const filtered = tail.filter((m) => m.role !== 'assistant' || m.meta?.finishReason || m.content);
  if (conv.compactedSummary) {
    const prefix: ChatMessage = { role: 'user', content: frameCompactedSummary(conv.compactedSummary) };
    return [prefix, ...filtered];
  }
  return filtered;
}

// A compacted conversation's summary is only valid as a prefix for a message
// array at least as long as compactedCount. Deleting/branching/regenerating/
// editing/clearing can shorten `messages` back to or past that boundary —
// keeping the old compaction state then makes modelHistory's slice come back
// empty, silently dropping every real message from the next request. Use
// this instead of a raw `{ ...conv, messages }` spread anywhere `messages`
// is being shortened or replaced.
function withMessages(conv: Conversation, messages: ChatMessage[]): Conversation {
  if (conv.compactedSummary && messages.length <= (conv.compactedCount ?? 0)) {
    return { ...conv, messages, compactedSummary: undefined, compactedCount: undefined };
  }
  return { ...conv, messages };
}

// Subtle divider shown in place of the verbose compaction summary.
function CompactDivider() {
  return (
    <div className="my-3 flex items-center gap-2 text-[11px] text-faint">
      <span className="h-px flex-1 bg-line" />
      <span>✂ Context compacted</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
import { formatBytes, formatMs, formatRate, formatTime, formatTokens, uid } from '../lib/format';
import { setLatestRequestMetrics } from '../lib/liveMetrics';
import type { ChatAttachment, ChatMessage, ChatParams, Conversation, EngineStatus, SavedChatParams, StatusPayload } from '../lib/types';
// Dynamically imported: react-markdown + remark-gfm + highlight.js is a
// ~300KB chunk that costs nothing at startup this way, only when the first
// completed (non-streaming) reply actually needs to render.
const Markdown = lazy(() => import('../components/Markdown'));
import { Badge, Button, cn, NumberField, Segmented, SelectField, Toggle } from '../components/ui';


const DEFAULT_PARAMS: ChatParams = {
  thinking: true,
  reasoningEffort: '',
  preserveThinking: true,
  maxTokens: null as unknown as number,
};

/** The chat UI renders full Markdown (images included), but without a
 *  capability statement the model assumes a text-only terminal and refuses
 *  to show pictures. Tell it what the interface can do. */
const CHAT_CAPABILITIES = [
  '# Rendering capabilities',
  '- This chat renders full Markdown, including images: to show a picture inline, emit `![alt](https://direct-image-url)` — the UI displays it as a real image.',
  '- You cannot generate images yourself. When the user attaches images or video, you can see their contents (vision input).',
  '- web_fetch returns a page as text/Markdown and cannot fetch binary image data itself, but its output includes an "## Images on this page" section listing every image URL found on the page (already resolved to absolute URLs) — copy one of those verbatim into a Markdown image tag to actually display it. Do not invent or guess an image URL; if the page has none listed, say so instead of fabricating one.',
].join('\n');
const chatSystemWithCapabilities = (params: Parameters<typeof effectiveSystemPrompt>[0]): string => {
  const base = effectiveSystemPrompt(params);
  return base ? `${base}\n\n${CHAT_CAPABILITIES}` : CHAT_CAPABILITIES;
};

const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch web content (extracts Markdown).",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for up-to-date information.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }
  }
];

// Slash-command palette (type `/` in the composer to see suggestions).
const SLASH_COMMANDS: Array<{ cmd: string; desc: string; needsArg?: boolean }> = [
  { cmd: '/clear', desc: 'Clear the current chat' },
  { cmd: '/retry', desc: 'Regenerate the last reply' },
  { cmd: '/model', desc: 'Switch model', needsArg: true },
  { cmd: '/think', desc: 'Toggle reasoning on|off', needsArg: true },
  { cmd: '/params', desc: 'Open the parameter popover' },
  { cmd: '/compact', desc: 'Summarize chat into a checkpoint' },
];

function pickDefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') (out as any)[k] = v;
  return out;
}

// Normalize persisted params (from the profile dir) into a valid ChatParams,
// filling unset sampling fields with undefined so the UI shows "model preset".
function normalizeParams(raw: unknown): ChatParams {
  if (raw && typeof raw === 'object') {
    const p = raw as Record<string, unknown>;
    return { ...DEFAULT_PARAMS, ...p, maxTokens: undefined, ...pickDefined(p) };
  }
  return { ...DEFAULT_PARAMS, maxTokens: undefined, greedy: undefined, seed: undefined, temperature: undefined, topP: undefined, topK: undefined, minP: undefined, presencePenalty: undefined, frequencyPenalty: undefined };
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------
function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
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

function MessageMeta({ m }: { m: ChatMessage }) {
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

type MsgActions = {
  onCopy: (m: ChatMessage) => void;
  onRegenerate: (convId: string, i: number) => void;
  onEdit: (convId: string, i: number, text: string) => void;
  onDelete: (convId: string, i: number) => void;
  onBranch: (convId: string, i: number) => void;
  onContinue: (convId: string, i: number) => void;
  onFollowUp: (text: string) => void;
};

function ActionBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
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

const MessageRow = memo(function MessageRow({
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

// ---------------------------------------------------------------------------
// Composer parameter popover
// ---------------------------------------------------------------------------
function ParamsPopover({
  params,
  setParams,
  open,
  setOpen,
  disabled,
  presets,
  onSavePreset,
  onLoadPreset,
  onDeletePreset,
}: {
  params: ChatParams;
  setParams: (p: ChatParams) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  disabled?: boolean;
  presets: SavedChatParams[];
  onSavePreset: (name: string) => void;
  onLoadPreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
}) {
  const set = (patch: Partial<ChatParams>) => setParams({ ...params, ...patch });
  const row = 'grid grid-cols-[150px_1fr] items-center gap-3';
  const lab = 'text-[12px] text-mute';
  const num = 'w-24';
  const [presetName, setPresetName] = useState('');
  return (
    <div className="w-[430px] rounded-xl border border-line bg-panel p-4 shadow-2xl">
      <div className="space-y-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Toggle checked={params.thinking} onChange={(v) => set({ thinking: v, ...(v ? {} : { reasoningEffort: '' }) })} label="Thinking" hint="Chain-of-thought before the answer. The engine streams reasoning_content separately from the response text." />
            <Toggle checked={!!params.preserveThinking} onChange={(v) => set({ preserveThinking: v })} label="Preserve reasoning in history" hint="Send closed reasoning from earlier turns back with the request, so follow-ups build on prior thinking." />
          </div>
        </div>
        {params.thinking && (
          <div className={row}>
            <span className={lab}>Reasoning effort</span>
            <SelectField
              value={params.reasoningEffort || ''}
              onChange={(v) => set({ reasoningEffort: v as ChatParams['reasoningEffort'] })}
              options={[
                { value: '', label: 'template default' },
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'xhigh', label: 'xhigh' },
              ]}
            />
          </div>
        )}
        <div className={row}>
          <span className={lab}>Max output tokens</span>
          <div className={num}>
            <NumberField value={params.maxTokens ?? null} onChange={(v) => set({ maxTokens: v })} onEmpty={() => set({ maxTokens: undefined })} min={0} placeholder="engine default" />
          </div>
        </div>
        <div className="h-px bg-line" />
        <div className={row}>
          <span className={lab}>Temperature</span>
          <div className={num}>
            <NumberField value={params.temperature ?? null} onChange={(v) => set({ temperature: v, greedy: false })} onEmpty={() => set({ temperature: undefined, greedy: false })} min={0} max={2} step={0.1} placeholder="model default" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Top-p</span>
          <div className={num}>
            <NumberField value={params.topP ?? null} onChange={(v) => set({ topP: v })} onEmpty={() => set({ topP: undefined })} min={0} max={1} step={0.05} placeholder="model default" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Top-k</span>
          <div className={num}>
            <NumberField value={params.topK ?? null} onChange={(v) => set({ topK: v })} onEmpty={() => set({ topK: undefined })} min={0} max={20} placeholder="model default" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Min-p</span>
          <div className={num}>
            <NumberField value={params.minP ?? null} onChange={(v) => set({ minP: v })} onEmpty={() => set({ minP: undefined })} min={0} max={1} step={0.05} placeholder="model default" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Presence penalty</span>
          <div className={num}>
            <NumberField value={params.presencePenalty ?? null} onChange={(v) => set({ presencePenalty: v })} onEmpty={() => set({ presencePenalty: undefined })} step={0.1} placeholder="model default" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Frequency penalty</span>
          <div className={num}>
            <NumberField value={params.frequencyPenalty ?? null} onChange={(v) => set({ frequencyPenalty: v })} onEmpty={() => set({ frequencyPenalty: undefined })} step={0.1} placeholder="0" />
          </div>
        </div>
        <div className={row}>
          <span className={lab}>Seed (0 = fresh per request)</span>
          <div className={num}>
            <NumberField value={params.seed ?? null} onChange={(v) => set({ seed: v })} onEmpty={() => set({ seed: undefined })} min={0} placeholder="random" />
          </div>
        </div>
        <div className="flex items-center">
          <Toggle checked={!!params.greedy} onChange={(v) => set({ greedy: v, ...(v ? { temperature: 0 } : { temperature: undefined }) })} label="Greedy (exact argmax)" hint="temperature 0 with no sampling — deterministic output. Overrides the other sampling fields while on." />
        </div>
        <div className="h-px bg-line" />
        <div className="flex items-center">
          <Toggle checked={!!params.humanize} onChange={(v) => set({ humanize: v })} label="Humanize replies (Not-Ai)" hint="Rewrite replies to sound human — no em dashes, no buzzwords, no empty framing. Replies that trip the tell-gate are silently re-written." />
        </div>
        <div className={row}>
          <span className={lab}>Voice / style</span>
          <SelectField
            value={(params.voiceProfile as VoiceProfile) || 'personal'}
            onChange={(v) => set({ voiceProfile: v })}
            disabled={!params.humanize}
            options={VOICE_PROFILES.map((p) => ({ value: p.value, label: p.label }))}
          />
        </div>
        <div className="h-px bg-line" />
        <div className={row}>
          <span className={lab} title="Once a reply's usage crosses this share of the model's context window, the conversation is silently folded into a summary checkpoint so the next message doesn't risk truncation.">Auto-compact at %</span>
          <div className={num}>
            <NumberField value={params.compactAt ?? null} onChange={(v) => set({ compactAt: v })} onEmpty={() => set({ compactAt: undefined })} min={20} max={95} placeholder="80" />
          </div>
        </div>
        <div className="h-px bg-line" />
        <div className={row}>
          <span className={lab}>System prompt</span>
          <textarea
            value={params.systemPrompt || ''}
            onChange={(e) => set({ systemPrompt: e.target.value })}
            rows={3}
            placeholder="optional system instructions"
            className="w-full resize-y rounded-lg border border-line bg-inset px-2.5 py-2 text-[12.5px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
          />
        </div>
        <div className="h-px bg-line" />
        <div className="space-y-2">
          <span className={lab}>Presets (sampling + system prompt bundle)</span>
          {presets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1 rounded-md border border-line bg-inset px-2 py-1 text-[11.5px] text-mute">
                  <button type="button" title="Load this preset" onClick={() => onLoadPreset(p.id)} className="hover:text-ink">
                    {p.name}
                  </button>
                  <button type="button" title="Delete preset" onClick={() => onDeletePreset(p.id)} className="text-faint hover:text-danger">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && presetName.trim()) {
                  onSavePreset(presetName);
                  setPresetName('');
                }
              }}
              placeholder="preset name"
              className="min-w-0 flex-1 rounded-lg border border-line bg-inset px-2.5 py-1.5 text-[12px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
            />
            <Button
              size="sm"
              variant="subtle"
              disabled={!presetName.trim()}
              onClick={() => {
                onSavePreset(presetName);
                setPresetName('');
              }}
            >
              <Save size={12} /> save current
            </Button>
          </div>
        </div>
        <div className="flex justify-between">
          <Button size="sm" variant="subtle" onClick={() => set({ ...DEFAULT_PARAMS, maxTokens: undefined })}>
            reset to defaults
          </Button>
          <Button size="sm" onClick={() => setOpen(false)}>
            done
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context-limit indicator — how close the latest request's context is to the
// engine's --max-context, so long sessions don't silently truncate.
// ---------------------------------------------------------------------------
function ContextMeter({ used, limit }: { used: number | null; limit: number | null }) {
  if (limit == null) {
    return (
      <div className="flex items-center gap-1.5 text-[10.5px] text-faint">
        <Gauge size={11} /> context limit not reported — set --max-context to track usage
      </div>
    );
  }
  const pct = used ? Math.min(100, (used / limit) * 100) : 0;
  const pctLabel = `${pct.toFixed(0)}% of max-context`;
  const bar = pct > 90 ? 'bg-danger' : pct > 75 ? 'bg-warn' : 'bg-accent';
  // Proactive awareness: warn before the engine silently truncates older
  // context once the running total bumps into --max-context.
  const warn =
    pct > 90
      ? 'context nearly full — older messages will be truncated'
      : pct > 75
        ? `${pctLabel}: approaching the limit, start a new chat soon`
        : null;
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-[10.5px]',
        pct > 90 ? 'text-danger' : pct > 75 ? 'text-warn' : 'text-faint',
      )}
      title={used != null ? `${formatTokens(used)} / ${formatTokens(limit)} tokens` : 'no requests yet'}
    >
      <Gauge size={11} className={pct > 75 ? '' : 'text-faint'} />
      <span className="text-faint">ctx</span>
      <span className="relative h-1 w-20 overflow-hidden rounded-full bg-line">
        <span className={cn('absolute inset-y-0 left-0 rounded-full transition-[width] duration-300', bar)} style={{ width: `${pct}%` }} />
      </span>
      <span className="font-mono">{pctLabel}</span>
      {used != null && <span className="font-mono text-faint">{formatTokens(used)} / {formatTokens(limit)}</span>}
      {warn && <span className="ml-1 truncate text-[10px]">{warn}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export function ChatScreen({ status, onNavigate }: { status: StatusPayload | null; onNavigate: (s: 'chat' | 'engine' | 'models' | 'settings') => void }) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [params, setParamsState] = useState<ChatParams>(() => ({ ...DEFAULT_PARAMS, maxTokens: undefined }));
  const [presets, setPresets] = useState<SavedChatParams[]>([]);
  const [convSearch, setConvSearch] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  // Which conversation actually owns the in-flight stream — `streaming` alone
  // is a global one-at-a-time engine lock (a single AbortController/engine
  // slot), so viewing a DIFFERENT idle conversation must not render it (or
  // its composer) as if it were the one generating.
  const [streamingConvId, setStreamingConvId] = useState<string | null>(null);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [model, setModel] = useState<string>(status?.engine?.modelId || '');
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Latest conversations snapshot for use inside stable callbacks (avoids stale closures).
  const convsRef = useRef(convs);
  convsRef.current = convs;

  const engine = status?.engine;
  // every engine Studio knows about (primary + discovered on other ports)
  const allEngines: EngineStatus[] = status?.engines?.length ? status.engines : engine ? [engine] : [];
  const upEngines = allEngines.filter((e) => e.state === 'running' || e.state === 'external');
  const engineUp = upEngines.length > 0;
  const runningModel = upEngines[0]?.modelId || '';

  // Hydrate conversations + chat params from the user's profile dir on the
  // control plane (survives a fresh install / AppImage run). Then keep them in
  // sync: any change is written back through the API.
  useEffect(() => {
    let cancelled = false;
    getConversations()
      .then((s) => {
        if (cancelled) return;
        const list = Array.isArray(s.conversations) ? s.conversations : [];
        setConvs(list);
        setActiveId((cur) => cur ?? list[0]?.id ?? null);
        if (s.params) setParamsState(normalizeParams(s.params));
        if (Array.isArray(s.presets)) setPresets(s.presets);
        setLoaded(true);
      })
      .catch(() => cancelled || setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Keep the selector pointed at the running engine's actual id. The engine
    // only answers to the id it was started with (e.g. "qwen-coder"); never leave
    // a stale catalog fallback (e.g. "qwen3.8-27b") selected, which 404s.
    if (runningModel && !model) setModel(runningModel);
  }, [runningModel, model]);

  useEffect(() => {
    if (!loaded) return;
    // Persist on a quiet-period debounce: token deltas keep resetting the timer
    // during active generation (no per-delta POST thrashing), and the moment
    // generation pauses or ends — including the silent Not-Ai rewrite pass —
    // the turn is saved. Gating on `streaming` instead skipped the save
    // entirely when the user navigated away mid-rewrite, so the whole turn was
    // lost on return (hydration restored the pre-turn snapshot).
    const t = setTimeout(() => {
      saveConversations({ conversations: convs.slice(0, 200), params, presets }).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(t);
  }, [convs, params, presets, loaded]);
  const setParams = useCallback((p: ChatParams) => setParamsState(p), []);

  const active = convs.find((c) => c.id === activeId) || null;

  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  // Driven by a ResizeObserver on the actual content (not a [messages]
  // dependency) so it re-sticks to the bottom no matter WHY the content grew —
  // a new token, a message added, or the lazy-loaded Markdown chunk's Suspense
  // boundary resolving after the initial paint (which changes layout without
  // ever changing the `messages` array reference, so a dependency-gated effect
  // would run once too early and never fire again for that growth).
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Switching conversations always starts scrolled to the bottom of the new
  // one, regardless of where the user had scrolled in the previous one.
  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
  }, [activeId]);

  const runCompact = useCallback(async () => {
    if (compacting) return;
    setNotice(null);
    if (!engineUp) {
      onNavigate('engine');
      return;
    }
    const conv = convs.find((c) => c.id === activeId);
    if (!conv || conv.messages.length === 0) {
      setNotice({ tone: 'warn', text: 'Nothing to compact in this chat yet.' });
      return;
    }
    const useModel = model || runningModel;
    if (!useModel) return;

    setCompacting(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // On a re-compaction, prepend the prior checkpoint so the engine can merge
      // it instead of discarding everything compacted earlier. This is what keeps
      // the summary (and the context it carries) injected back into the model
      // after the visible context is cleared.
      const prior: ChatMessage[] = conv.compactedSummary
        ? [{ role: 'user', content: frameCompactedSummary(conv.compactedSummary) }]
        : [];
      const summary = await summarizeConversation({
        model: useModel,
        systemPrompt: params.systemPrompt,
        history: [...prior, ...conv.messages],
        signal: ac.signal,
      });
      if (!summary) throw new Error('compaction produced no summary');
      const compacted: Conversation = { ...conv, compactedSummary: summary, compactedCount: conv.messages.length };
      setConvs((cs) => cs.map((c) => (c.id === compacted.id ? compacted : c)));
      setNotice({ tone: 'ok', text: 'Conversation compacted — prior messages stay on screen and the summary is injected as context. Keep chatting from here.' });
    } catch (e) {
      // A deliberate Stop mid-compaction throws AbortError (see
      // summarizeConversation) — that's the user's own action, not a failure.
      if (e instanceof DOMException && e.name === 'AbortError') {
        setNotice({ tone: 'warn', text: 'Compaction stopped.' });
      } else {
        setNotice({ tone: 'danger', text: e instanceof Error ? e.message : 'compaction failed' });
      }
    } finally {
      setCompacting(false);
      abortRef.current = null;
    }
  }, [compacting, engineUp, convs, activeId, model, runningModel, params, onNavigate]);

  // Stream an assistant reply into the LAST message of `convId`, given the prior
  // `history` (everything before the placeholder). Shared by send / regenerate /
  // edit-and-resend so they stay in lockstep.
  const runStream = useCallback(
    async (convId: string, history: ChatMessage[], depth = 0, placeholderId?: string) => {
      if (!engineUp) {
        onNavigate('engine');
        return;
      }
      const useModel = model || runningModel;
      if (!useModel) return;
      setStreaming(true);
      setStreamingConvId(convId);
      const ac = new AbortController();
      abortRef.current = ac;

      // Target the streaming placeholder by stable id when available; fall back to
      // the last message only when no id was assigned (C2).
      const isTarget = (m: ChatMessage, i: number, len: number): boolean =>
        placeholderId ? m.id === placeholderId : i === len - 1;

      let capturedToolCalls: import('../lib/types').AgentToolCall[] = [];

      await streamChat(
        buildChatRequest(useModel, chatSystemWithCapabilities(params), history, params, { tools: CHAT_TOOLS }),
        ac.signal,
        {
          onReasoningDelta: (d) => {
            setConvs((cs) =>
              cs.map((c) =>
                c.id !== convId
                  ? c
                  : { ...c, messages: c.messages.map((m, i) => (isTarget(m, i, c.messages.length) ? { ...m, reasoning: (m.reasoning || '') + d } : m)) },
              ),
            );
          },
          onContentDelta: (d) => {
            setConvs((cs) =>
              cs.map((c) =>
                c.id !== convId
                  ? c
                  : { ...c, messages: c.messages.map((m, i) => (isTarget(m, i, c.messages.length) ? { ...m, content: m.content + d } : m)) },
              ),
            );
          },
          onUsage: (_u, meta) => {
            setConvs((cs) =>
              cs.map((c) => (c.id !== convId ? c : { ...c, messages: c.messages.map((m, i) => (isTarget(m, i, c.messages.length) ? { ...m, meta } : m)) })),
            );
            setLatestRequestMetrics(meta, useModel);
          },
          onToolCalls: (calls) => {
            capturedToolCalls = calls;
            setConvs((cs) =>
              cs.map((c) => (c.id !== convId ? c : { ...c, messages: c.messages.map((m, i) => (isTarget(m, i, c.messages.length) ? { ...m, tool_calls: calls } : m)) })),
            );
          },
          onDone: (meta) => {
            setConvs((cs) =>
              cs.map((c) => (c.id !== convId ? c : { ...c, messages: c.messages.map((m, i) => (isTarget(m, i, c.messages.length) ? { ...m, meta } : m)) })),
            );
            setLatestRequestMetrics(meta, useModel);
          },
          onError: (msg) => {
            setConvs((cs) =>
              cs.map((c) =>
                c.id !== convId
                  ? c
                  : {
                      ...c,
                      messages: c.messages.map((m, i) =>
                        isTarget(m, i, c.messages.length) ? { ...m, error: true, content: m.content || msg, meta: { finishReason: 'error' } } : m,
                      ),
                    },
              ),
            );
          },
        },
      );

      // Not-Ai auto-rewrite: when humanize is on and this was a plain content
      // reply (no tool calls), run the deterministic tell-gate and silently
      // re-write the reply if it trips a high-signal tell (em dashes, buzzwords,
      // mechanical transitions, participial openers). The whole pass is
      // best-effort: any failure must degrade to keeping the original reply,
      // never skip the setStreaming(false) below (which is what froze the chat
      // "streaming" with a dead STOP button when the gate once threw).
      try {
        if (!ac.signal.aborted && params.humanize && capturedToolCalls.length === 0) {
        const convNow = convsRef.current.find((c) => c.id === convId);
        if (convNow) {
          const msgs = convNow.messages;
          const idx = placeholderId ? msgs.findIndex((m) => m.id === placeholderId) : msgs.length - 1;
          const target = msgs[idx];
          if (target && target.role === 'assistant' && target.content.trim()) {
            // Retry up to HUMANIZE_MAX_DEPTH times: a rewrite can itself trip
            // the gate (the model doesn't always follow the rewrite rules),
            // so re-check each attempt and feed the best-so-far text back in
            // rather than accepting the first pass unconditionally.
            let current = target.content;
            let gateRes = evaluate(current, effectiveVoice(params), {});
            for (let attempt = 0; attempt < HUMANIZE_MAX_DEPTH && needsHumanize(gateRes) && !ac.signal.aborted; attempt++) {
              try {
                const rewritten = await humanizeRewriteText({
                  model: useModel,
                  baseSystem: effectiveSystemPrompt(params) || params.systemPrompt || '',
                  priorMessages: msgs.slice(0, idx),
                  originalText: current,
                  params,
                  signal: ac.signal,
                });
                if (!rewritten || !rewritten.trim() || rewritten.trim() === current.trim()) break;
                current = rewritten.trim();
                gateRes = evaluate(current, effectiveVoice(params), {});
              } catch {
                break; // keep the best rewrite obtained so far (or the original)
              }
            }
            if (!ac.signal.aborted && current.trim() !== target.content.trim()) {
              setConvs((cs) => cs.map((c) => c.id !== convId ? c : {
                ...c, messages: c.messages.map((m, i) => (i === idx ? { ...m, content: current } : m)),
              }));
            }
          }
        }
      }
      } catch (humanizeError) {
        // The gate or rewrite must never take the whole run down — the reply
        // is already complete and shown; keep it and release the UI.
        console.warn('[chat] humanize pass skipped (gate/rewrite failed)', humanizeError);
      }

      if (capturedToolCalls.length > 0 && !ac.signal.aborted) {
         if (depth >= 12) {
           setConvs((cs) => cs.map((c) => c.id !== convId ? c : { ...c, messages: c.messages.map((m, i) => isTarget(m, i, c.messages.length) ? { ...m, content: m.content + `\n\n[System: Tool execution limit reached after 12 steps — the agent could not finish. Try a more specific request, e.g. "give me an image URL of a golden retriever puppy".]`, error: true } : m) }));
           setStreaming(false);
           setStreamingConvId(null);
           return;
         }
         const toolResults: ChatMessage[] = [];
         for (const call of capturedToolCalls) {
             let result = '';
             try {
                const args = JSON.parse(call.arguments);
                if (call.name === 'web_fetch') result = JSON.stringify(await coderWebFetch(args.url));
                else if (call.name === 'web_search') result = JSON.stringify(await coderWebSearch(args.query));
                else result = JSON.stringify({ error: `unknown tool: ${call.name}` });
             } catch(e) {
                result = JSON.stringify({error: String(e)});
             }
             toolResults.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result });
         }
         
         const asstMsg: ChatMessage = { role: 'assistant', content: '', id: uid(), model: useModel, meta: {} };
         setConvs(cs => cs.map(c => c.id !== convId ? c : { ...c, messages: [...c.messages, ...toolResults, asstMsg] }));
         const updatedConv = convsRef.current.find(c => c.id === convId);
         if (updatedConv && !ac.signal.aborted) {
             const newHistory = [...updatedConv.messages, ...toolResults];
             await runStream(convId, modelHistory({ ...updatedConv, messages: newHistory }), depth + 1, asstMsg.id);
         }
         return;
      }
      
      // Auto-compact: once this turn's usage crosses the configured share of
      // the model's context window, silently fold the conversation into a
      // summary checkpoint so the next message doesn't risk truncation.
      // Reactive (checked after each reply) rather than Coder's proactive
      // per-step check, since Chat turns are user-initiated, not an
      // autonomous loop — the natural checkpoint is right after a reply
      // lands, before the user's next message.
      if (!ac.signal.aborted) {
        try {
          // Look up the engine actually serving `useModel`, not just the
          // first/primary one — matters when multiple engines with different
          // context sizes are running (same fix as ctxLimit above).
          const limit = allEngines.find((e) => e.modelId === useModel)?.maxContext ?? status?.engine?.maxContext ?? null;
          const convForCompact = convsRef.current.find((c) => c.id === convId);
          const msgsForCompact = convForCompact?.messages ?? [];
          const idxForCompact = placeholderId ? msgsForCompact.findIndex((m) => m.id === placeholderId) : msgsForCompact.length - 1;
          const finalMsg = msgsForCompact[idxForCompact];
          const usedTok = finalMsg?.meta ? (finalMsg.meta.promptTokens ?? 0) + (finalMsg.meta.completionTokens ?? 0) : 0;
          const thresholdPct = params.compactAt ?? 80;
          if (convForCompact && limit && usedTok > 0 && usedTok >= (thresholdPct / 100) * limit) {
            const prior: ChatMessage[] = convForCompact.compactedSummary
              ? [{ role: 'user', content: frameCompactedSummary(convForCompact.compactedSummary) }]
              : [];
            const summary = await summarizeConversation({
              model: useModel,
              systemPrompt: params.systemPrompt,
              history: [...prior, ...convForCompact.messages],
              signal: ac.signal,
            });
            if (summary) {
              const compacted: Conversation = { ...convForCompact, compactedSummary: summary, compactedCount: convForCompact.messages.length };
              setConvs((cs) => cs.map((c) => (c.id === compacted.id ? compacted : c)));
              setNotice({ tone: 'ok', text: `Auto-compacted at ${thresholdPct}% of context — prior messages stay on screen, summary injected as context.` });
            }
          }
        } catch (compactError) {
          // Best-effort like the humanize pass above: never take the turn
          // down over this — the reply is already complete and shown.
          console.warn('[chat] auto-compact skipped', compactError);
        }
      }

      // Suggested follow-ups: a fast, best-effort pass offering 3 one-click
      // next questions so the user isn't stuck staring at a blank composer.
      // Skipped on a truncated reply (Continue is the more useful action there).
      if (!ac.signal.aborted) {
        try {
          const convForFollowUps = convsRef.current.find((c) => c.id === convId);
          const msgsForFollowUps = convForFollowUps?.messages ?? [];
          const idxForFollowUps = placeholderId ? msgsForFollowUps.findIndex((m) => m.id === placeholderId) : msgsForFollowUps.length - 1;
          const finalMsgForFollowUps = msgsForFollowUps[idxForFollowUps];
          if (
            convForFollowUps &&
            finalMsgForFollowUps &&
            !finalMsgForFollowUps.error &&
            finalMsgForFollowUps.content.trim() &&
            finalMsgForFollowUps.meta?.finishReason !== 'length'
          ) {
            const followUps = await suggestFollowUps({
              model: useModel,
              history: modelHistory({ ...convForFollowUps, messages: msgsForFollowUps.slice(0, idxForFollowUps + 1) }),
              signal: ac.signal,
            });
            if (!ac.signal.aborted && followUps.length) {
              setConvs((cs) =>
                cs.map((c) =>
                  c.id !== convId ? c : { ...c, messages: c.messages.map((m, i) => (i === idxForFollowUps ? { ...m, followUps } : m)) },
                ),
              );
            }
          }
        } catch (followUpError) {
          // Best-effort like the passes above: never take the turn down over this.
          console.warn('[chat] follow-up suggestions skipped', followUpError);
        }
      }

      setStreaming(false);
      setStreamingConvId(null);
      abortRef.current = null;
    },
    [engineUp, model, runningModel, params, onNavigate, status],
  );

  const send = useCallback(async () => {
    const content = text.trim();
    if (!content && !attachments.length) return;
    if (content.startsWith('/') && runCommand(content)) {
      setText('');
      setAttachments([]);
      return;
    }
    if (!engineUp) {
      onNavigate('engine');
      return;
    }
    const useModel = model || runningModel;
    if (!useModel) return;

    let conv = convs.find((c) => c.id === activeId);
    const userMsg: ChatMessage = { role: 'user', content, attachments: attachments.length ? attachments : undefined };
    const asstMsg: ChatMessage = { role: 'assistant', content: '', id: uid(), model: useModel, meta: {} };
    if (!conv) {
      conv = {
        id: uid(),
        title: content ? content.slice(0, 48) : attachments[0]?.name || 'New chat',
        model: useModel,
        createdAt: Date.now(),
        messages: [],
      };
    }
    const base: Conversation = { ...conv, messages: [...conv.messages, userMsg, asstMsg] };
    const newId = conv.id;
    const idx = convs.findIndex((c) => c.id === newId);
    const withConv = [...convs];
    if (idx >= 0) withConv[idx] = base;
    else withConv.unshift(base);
    setConvs(withConv);
    setActiveId(newId);
    setText('');
    setAttachments([]);
    stick.current = true;
    setAtBottom(true);

    const history: ChatMessage[] = modelHistory(base);
    await runStream(newId, history, 0, asstMsg.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, attachments, engineUp, model, runningModel, convs, activeId, params, onNavigate, runStream]);

  // Send a suggested follow-up question straight away (bypassing the composer) —
  // always appends to the active conversation, which is the only one a
  // follow-up chip can ever be shown against.
  const sendFollowUp = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || streaming || compacting) return;
      if (!engineUp) {
        onNavigate('engine');
        return;
      }
      const useModel = model || runningModel;
      if (!useModel) return;
      const conv = convs.find((c) => c.id === activeId);
      if (!conv) return;
      const userMsg: ChatMessage = { role: 'user', content: trimmed };
      const asstMsg: ChatMessage = { role: 'assistant', content: '', id: uid(), model: useModel, meta: {} };
      const base: Conversation = { ...conv, messages: [...conv.messages, userMsg, asstMsg] };
      setConvs((cs) => cs.map((c) => (c.id === conv.id ? base : c)));
      stick.current = true;
    setAtBottom(true);
      const history: ChatMessage[] = modelHistory(base);
      await runStream(conv.id, history, 0, asstMsg.id);
    },
    [streaming, compacting, engineUp, model, runningModel, convs, activeId, runStream, onNavigate],
  );

  // --- message-level actions (hover toolbar) ---
  const copyMessage = useCallback((m: ChatMessage) => {
    const text = m.role === 'assistant' && m.reasoning ? `> reasoning\n\n${m.reasoning}\n\n${m.content}` : m.content;
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);

  // Delete this message and everything after it (a chat is a strict linear context).
  const deleteFrom = useCallback((convId: string, msgIndex: number) => {
    setConvs((cs) => cs.map((c) => (c.id !== convId ? c : withMessages(c, c.messages.slice(0, msgIndex)))));
  }, []);

  // Fork the conversation up to and including this message into a new chat.
  const branchAt = useCallback((convId: string, msgIndex: number) => {
    const conv = convsRef.current.find((c) => c.id === convId);
    if (!conv) return;
    const forkMessages = conv.messages.slice(0, msgIndex + 1).map((m) => ({ ...m }));
    const fork: Conversation = {
      ...withMessages(conv, forkMessages),
      id: uid(),
      title: conv.title ? `${conv.title} (branch)` : 'Branch',
      createdAt: Date.now(),
    };
    setConvs((cs) => [fork, ...cs]);
    setActiveId(fork.id);
  }, []);

  // Replace the assistant reply at `msgIndex` (and drop everything after) with a fresh one.
  const regenerate = useCallback(
    (convId: string, msgIndex: number) => {
      const conv = convsRef.current.find((c) => c.id === convId);
      if (!conv) return;
      const prior = conv.messages.slice(0, msgIndex);
      const base = withMessages(conv, prior);
      const asst: ChatMessage = { role: 'assistant', content: '', id: uid(), model: model || runningModel, meta: {} };
      setConvs((cs) => cs.map((c) => (c.id !== convId ? c : { ...base, messages: [...prior, asst] })));
      runStream(convId, modelHistory(base), 0, asst.id).catch((e) =>
        console.error('[chat] resend run failed', e));
    },
    [model, runningModel, runStream],
  );

  // Edit a user message in place, then re-stream its assistant reply.
  const editMessage = useCallback(
    (convId: string, msgIndex: number, newText: string) => {
      const conv = convsRef.current.find((c) => c.id === convId);
      if (!conv) return;
      const msgs = conv.messages.slice();
      msgs[msgIndex] = { ...msgs[msgIndex], content: newText };
      const prior = msgs.slice(0, msgIndex + 1);
      const base = withMessages(conv, prior);
      const asst: ChatMessage = { role: 'assistant', content: '', id: uid(), model: model || runningModel, meta: {} };
      setConvs((cs) => cs.map((c) => (c.id !== convId ? c : { ...base, messages: [...prior, asst] })));
      runStream(convId, modelHistory(base), 0, asst.id).catch((e) =>
        console.error('[chat] resend run failed', e));
    },
    [model, runningModel, runStream],
  );

  // Extend a reply that hit the token limit: replay the context up to and
  // including the truncated message, plus a hidden nudge to pick up exactly
  // where it left off, and stream new deltas into the SAME message (no fresh
  // placeholder) so the bubble grows in place instead of duplicating.
  const continueMessage = useCallback(
    (convId: string, msgIndex: number) => {
      const conv = convsRef.current.find((c) => c.id === convId);
      if (!conv) return;
      const target = conv.messages[msgIndex];
      if (!target || target.role !== 'assistant') return;
      const upTo = withMessages(conv, conv.messages.slice(0, msgIndex + 1));
      const history: ChatMessage[] = [
        ...modelHistory(upTo),
        { role: 'user', content: 'Continue your previous response exactly where it left off. Do not repeat any text you already wrote, and do not add any preamble or acknowledgement.' },
      ];
      runStream(convId, history, 0, target.id).catch((e) => console.error('[chat] continue run failed', e));
    },
    [runStream],
  );

  const msgActions = useMemo(
    () => ({ onCopy: copyMessage, onRegenerate: regenerate, onEdit: editMessage, onDelete: deleteFrom, onBranch: branchAt, onContinue: continueMessage, onFollowUp: sendFollowUp }),
    [copyMessage, regenerate, editMessage, deleteFrom, branchAt, continueMessage, sendFollowUp],
  );

  // Presets: named, reusable bundles of sampling + system prompt + thinking.
  const savePreset = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setPresets((ps) => [...ps.filter((p) => p.name !== trimmed), { id: uid(), name: trimmed, params }]);
  }, [params]);

  const loadPreset = useCallback(
    (id: string) => {
      const p = presets.find((x) => x.id === id);
      if (p) setParams({ ...p.params });
    },
    [presets, setParams],
  );

  const deletePreset = useCallback((id: string) => {
    setPresets((ps) => ps.filter((p) => p.id !== id));
  }, []);

  // Sidebar search: match the conversation title or any message's content.
  const filteredConvs = useMemo(() => {
    const q = convSearch.trim().toLowerCase();
    const matched = q
      ? convs.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
      : convs;
    // Stable sort: pinned conversations rise to the top without disturbing
    // relative order within each group.
    return [...matched].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  }, [convs, convSearch]);

  // Slash-command interpreter. Returns true if `raw` was a recognized command
  // (so the caller can skip sending it to the engine as a normal message).
  const runCommand = useCallback(
    (raw: string): boolean => {
      const parts = raw.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ').trim();
      switch (cmd) {
        case '/clear':
          if (activeId) setConvs((cs) => cs.map((c) => (c.id === activeId ? withMessages(c, []) : c)));
          else setActiveId(null);
          return true;
        case '/retry': {
          const conv = convsRef.current.find((c) => c.id === activeId);
          if (conv) {
            for (let i = conv.messages.length - 1; i >= 0; i--) {
              if (conv.messages[i].role === 'assistant') {
                regenerate(activeId!, i);
                break;
              }
            }
          }
          return true;
        }
        case '/model':
          if (arg) setModel(arg);
          else setNotice({ tone: 'warn', text: 'usage: /model <id>' });
          return true;
        case '/think':
          if (arg === 'on') setParams({ thinking: true });
          else if (arg === 'off') setParams({ thinking: false });
          else setNotice({ tone: 'warn', text: 'usage: /think on|off' });
          return true;
        case '/params':
          setParamsOpen(true);
          return true;
        case '/compact':
          runCompact();
          return true;
        default:
          return false;
      }
    },
    [activeId, regenerate, runCompact, setModel, setParams, setParamsOpen, setNotice],
  );

  const stop = () => abortRef.current?.abort();

  const newChat = useCallback(() => {
    setActiveId(null);
    setText('');
    setAttachments([]);
    textareaRef.current?.focus();
  }, []);

  // Ctrl/Cmd+K: jump to a fresh chat from anywhere in the screen.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        newChat();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [newChat]);

  const deleteConv = (id: string) => {
    setConvs((cs) => cs.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  };

  const renameConv = (id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
  };

  const togglePin = (id: string) => {
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));
  };

  const exportConv = (conv: Conversation) => {
    const lines = [`# ${conv.title || 'Untitled'}`, '', `_${conv.model} · ${new Date(conv.createdAt).toLocaleString()}_`];
    for (const m of conv.messages) {
      if (isCompactedMsg(m) || (!m.content && !m.reasoning)) continue;
      if (m.role === 'user') lines.push('', '### You', '', m.content);
      else if (m.role === 'assistant') lines.push('', '### Ninfer', '', m.content);
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(conv.title || 'chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    for (const f of Array.from(files).slice(0, 4)) {
      if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) continue;
      if (f.size > 16 * 1024 * 1024) continue;
      const kind: 'image' | 'video' = f.type.startsWith('video') ? 'video' : 'image';
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments((a) => [...a, { kind, name: f.name, dataUrl: String(reader.result) }]);
      };
      reader.readAsDataURL(f);
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const messages = active?.messages || [];
  const last = messages[messages.length - 1];

  // Context-limit indicator: token usage of the latest completed request vs
  // the --max-context of the engine actually serving this chat's model (not
  // just the first/primary engine) — matters once more than one engine with
  // a different context size is running. Falls back to the primary engine
  // when the model isn't found among the known engines yet.
  const ctxLimit = allEngines.find((e) => e.modelId === (model || runningModel))?.maxContext ?? status?.engine?.maxContext ?? null;
  // A backward scan instead of `[...messages].reverse().find(...)` — the
  // spread+reverse copied the whole conversation's message array on every
  // single streamed token (onContentDelta re-renders this component per
  // delta), which gets expensive fast in a long-running conversation.
  const lastMeta = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && m.meta && (m.meta.promptTokens || m.meta.completionTokens)) return m.meta;
    }
    return null;
  }, [messages]);
  const ctxUsed = lastMeta ? (lastMeta.promptTokens ?? 0) + (lastMeta.completionTokens ?? 0) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
          <>
            {/* conversation rail */}
            <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
        <div className="p-2.5">
          <Button variant="primary" size="sm" className="w-full" onClick={newChat} title="New chat (Ctrl/Cmd+K)">
            <Plus size={14} /> new chat
          </Button>
        </div>
        {convs.length > 0 && (
          <div className="px-2.5 pb-2">
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                value={convSearch}
                onChange={(e) => setConvSearch(e.target.value)}
                placeholder="Search chats…"
                className="w-full rounded-lg border border-line bg-inset py-1.5 pl-7 pr-2.5 text-[12px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
              />
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {filteredConvs.length === 0 && (
            <p className="px-2 py-3 text-[12px] leading-relaxed text-faint">
              {convs.length === 0 ? 'No conversations yet. Start one below — everything runs locally against the NInfer engine.' : 'No chats match your search.'}
            </p>
          )}
          {filteredConvs.map((c) => (
            <div
              key={c.id}
              tabIndex={0}
              role="button"
              aria-current={c.id === activeId || undefined}
              onClick={() => renamingId !== c.id && setActiveId(c.id)}
              onKeyDown={(e) => {
                // Ignore keydowns bubbling up from the rename input or the
                // pin/rename/export/delete buttons — only act when the row
                // itself is the focused element.
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveId(c.id);
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
                }
              }}
              className={cn(
                'group mb-1 cursor-pointer rounded-lg border px-2.5 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-accent/60',
                c.id === activeId ? 'border-accent/30 bg-accent/8' : 'border-transparent hover:border-line hover:bg-panel2',
              )}
            >
              <div className="flex items-center gap-1.5">
                {renamingId === c.id ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => {
                      renameConv(c.id, renameDraft);
                      setRenamingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        renameConv(c.id, renameDraft);
                        setRenamingId(null);
                      } else if (e.key === 'Escape') {
                        setRenamingId(null);
                      }
                    }}
                    className="min-w-0 flex-1 rounded border border-accent/40 bg-inset px-1.5 py-0.5 text-[12.5px] font-medium text-ink focus:outline-none"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
                    {c.pinned && <Pin size={10} className="mr-1 inline text-accent" />}
                    {c.title || 'Untitled'}
                  </span>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePin(c.id);
                  }}
                  className={cn(
                    'rounded p-0.5 text-faint hover:text-accent',
                    c.pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}
                  title={c.pinned ? 'Unpin conversation' : 'Pin conversation'}
                  aria-label={c.pinned ? 'Unpin conversation' : 'Pin conversation'}
                >
                  {c.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenameDraft(c.title || '');
                    setRenamingId(c.id);
                  }}
                  className="rounded p-0.5 text-faint opacity-0 hover:text-ink group-hover:opacity-100"
                  title="Rename conversation"
                  aria-label="Rename conversation"
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    exportConv(c);
                  }}
                  className="rounded p-0.5 text-faint opacity-0 hover:text-ink group-hover:opacity-100"
                  title="Export conversation (Markdown)"
                  aria-label="Export conversation as Markdown"
                >
                  <Download size={12} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteConv(c.id);
                  }}
                  className="rounded p-0.5 text-faint opacity-0 hover:text-danger group-hover:opacity-100"
                  title="Delete conversation"
                  aria-label="Delete conversation"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-faint">
                <span>{formatTime(c.createdAt)}</span>
                <span>·</span>
                <span className="text-accent/80">{c.model}</span>
                <span>·</span>
                <span>{c.messages.length} msgs</span>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* chat column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {(params.maxTokens || params.greedy) && (
          <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line bg-panel/60 px-4">
            <div className="ml-auto flex items-center gap-1.5">
              {params.maxTokens ? <Badge tone="neutral">max {formatTokens(params.maxTokens)}</Badge> : null}
              {params.greedy && <Badge tone="info">greedy</Badge>}
            </div>
          </div>
        )}

        {!engineUp && (
          <div className="flex shrink-0 items-center gap-3 border-b border-warn/20 bg-warn/8 px-4 py-2 text-[12.5px] text-warn">
            <span>
              The engine is {engine?.state === 'starting' ? 'starting' : 'not running'} — messages will be sent once it is ready.
            </span>
            <Button size="sm" variant="ghost" onClick={() => onNavigate('engine')}>
              <Play size={12} /> open engine
            </Button>
          </div>
        )}

        <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const s = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            stick.current = s;
            setAtBottom(s);
          }}
          className="h-full overflow-y-auto px-5 py-4"
        >
          <div ref={contentRef}>
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-accent/30 bg-accent/10">
                <span className="font-mono text-xl font-bold text-accent">N</span>
              </div>
              <h2 className="text-[15px] font-semibold">Local inference, zero cloud</h2>
              <p className="max-w-sm text-[13px] leading-relaxed text-mute">
                Chat with {model || 'the loaded model'} on your RTX 5090. Attach images or video for multimodal prompts, and tune sampling per message.
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {['Explain speculative decoding in one paragraph.', 'What is the difference between prefill and decode?', 'Write a haiku about GPU kernels.'].map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setText(s);
                      textareaRef.current?.focus();
                    }}
                    className="rounded-full border border-line bg-panel px-3 py-1.5 text-[12px] text-mute hover:border-accent/40 hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <Suspense fallback={null}>
              <div className="mx-auto flex max-w-3xl flex-col gap-5">
                {messages.map((m, i) => {
                  if (isCompactedMsg(m)) return <CompactDivider key={`div-${i}`} />;
                  const showDivider = !!active?.compactedSummary && i === (active.compactedCount ?? 0);
                  return (
                    <Fragment key={i}>
                      {showDivider && <CompactDivider />}
                      <MessageRow
                        m={m}
                        convId={activeId ?? ''}
                        index={i}
                        isLast={i === messages.length - 1}
                        streaming={streaming && streamingConvId === activeId && i === messages.length - 1}
                        locked={streaming || compacting}
                        actions={msgActions}
                      />
                    </Fragment>
                  );
                })}
              </div>
            </Suspense>
          )}
          </div>
        </div>
        {!atBottom && messages.length > 0 && (
          <button
            type="button"
            onClick={() => {
              stick.current = true;
              setAtBottom(true);
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            title="Jump to latest"
            aria-label="Jump to latest message"
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1.5 text-[11.5px] text-mute shadow-lg transition-colors hover:border-accent/40 hover:text-ink"
          >
            <ChevronDown size={13} /> jump to latest
          </button>
        )}
        </div>

        {/* composer */}
        <div className="shrink-0 border-t border-line bg-panel p-3">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5 px-1">
              {attachments.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-inset px-2 py-1 text-[11.5px] text-mute">
                  {a.kind === 'image' && a.dataUrl ? (
                    <img src={a.dataUrl} alt="" className="h-7 w-7 rounded border border-line object-cover" />
                  ) : a.kind === 'image' ? '🖼' : '🎞'}
                  <span className="max-w-[140px] truncate">{a.name}</span>
                  <button type="button" onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))} aria-label={`Remove attachment ${a.name}`} className="text-faint hover:text-danger">
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {notice && (
            <div
              className={cn(
                'mb-2 rounded-lg border px-3 py-2 text-[12.5px]',
                notice.tone === 'ok' && 'border-ok/30 bg-ok/8 text-ok',
                notice.tone === 'warn' && 'border-warn/30 bg-warn/8 text-warn',
                notice.tone === 'danger' && 'border-danger/30 bg-danger/8 text-danger',
              )}
            >
              {notice.text}
              <button className="ml-3 opacity-60 hover:opacity-100" onClick={() => setNotice(null)}>
                ✕
              </button>
            </div>
          )}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              onFiles(e.dataTransfer.files);
            }}
            className={cn(
              'relative rounded-xl border bg-inset transition-colors focus-within:border-accent/50',
              dragOver ? 'border-accent/60' : 'border-line',
            )}
          >
            {text.startsWith('/') &&
              (() => {
                const token = text.split(/\s/)[0].toLowerCase();
                const matches = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(token));
                if (!matches.length) return null;
                return (
                  <div className="absolute bottom-full left-2 z-30 mb-2 w-80 rounded-xl border border-line bg-panel p-1.5 shadow-2xl">
                    {matches.map((c) => (
                      <button
                        key={c.cmd}
                        type="button"
                        onClick={() => {
                          setText(c.needsArg ? `${c.cmd} ` : c.cmd);
                          textareaRef.current?.focus();
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-panel2"
                      >
                        <span className="font-mono text-accent">{c.cmd}</span>
                        <span className="truncate text-faint">{c.desc}</span>
                      </button>
                    ))}
                  </div>
                );
              })()}
            <textarea
              ref={textareaRef}
              value={text}
              rows={1}
              onChange={(e) => {
                setText(e.target.value);
                autoGrow();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!streaming && !compacting) send();
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.items || [])
                  .filter((it) => it.kind === 'file')
                  .map((it) => it.getAsFile())
                  .filter((f): f is File => !!f);
                if (files.length) {
                  e.preventDefault();
                  onFiles(files);
                }
              }}
              placeholder={engineUp ? `Message ${model || 'engine'}…  (Enter to send, Shift+Enter for newline)` : 'Engine is offline — open the Engine tab to start it'}
              className="max-h-[220px] w-full resize-none bg-transparent px-3.5 pt-3 text-[13.5px] leading-relaxed text-ink placeholder:text-faint focus:outline-none"
            />
            <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
              <input ref={fileRef} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                title="Attach image or video (vision must be enabled on the engine)"
                aria-label="Attach image or video"
                className="rounded-md p-1.5 text-mute hover:bg-panel2 hover:text-ink"
              >
                <Paperclip size={15} />
              </button>
              <button
                type="button"
                onClick={() => setParamsOpen(!paramsOpen)}
                className={cn('flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium hover:bg-panel2', paramsOpen ? 'text-accent' : 'text-mute hover:text-ink')}
              >
                <SlidersHorizontal size={14} /> params
              </button>
              {params.thinking && (
                <button
                  type="button"
                  onClick={() => setParams({ ...params, thinking: false })}
                  title="Disable thinking for this chat"
                  className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[11.5px] text-faint hover:bg-panel2 hover:text-mute"
                >
                  <BrainCircuit size={13} /> thinking on
                </button>
              )}
              <span className="ml-auto" />
              {streamingConvId && streamingConvId !== activeId ? (
                <Button variant="ghost" size="sm" disabled title="The engine is generating a reply in another chat">
                  <Square size={12} /> busy elsewhere
                </Button>
              ) : streaming || compacting ? (
                <Button variant="danger" size="sm" onClick={stop}>
                  <Square size={12} /> {compacting ? 'stop compact' : 'stop'}
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={send} disabled={(!text.trim() && !attachments.length) || !engineUp}>
                  <Send size={13} /> send
                </Button>
              )}
            </div>
            {paramsOpen && (
              <div className="absolute bottom-full left-2 mb-2 z-30">
                <ParamsPopover
                  params={params}
                  setParams={setParams}
                  open={paramsOpen}
                  setOpen={setParamsOpen}
                  disabled={streaming}
                  presets={presets}
                  onSavePreset={savePreset}
                  onLoadPreset={loadPreset}
                  onDeletePreset={deletePreset}
                />
              </div>
            )}
          </div>
          <div className="mt-1.5 flex items-center justify-between px-1 text-[10.5px] text-faint">
            <ContextMeter used={ctxUsed} limit={ctxLimit} />
            <span>
              last msg: {last?.meta?.decodeTokPerSec ? formatRate(last.meta.decodeTokPerSec) : '—'}
            </span>
          </div>
        </div>
      </div>
          </>
      </div>
    </div>
  );
}
