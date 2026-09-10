import { memo, useCallback, useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from 'react';
import {
  BrainCircuit,
  ChevronDown,
  Copy,
  Gauge,
  GitBranch,
  Paperclip,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { coderWebFetch, coderWebSearch, buildChatRequest, frameCompactedSummary, getConversations, saveConversations, streamChat, summarizeConversation } from '../lib/api';
import { effectiveSystemPrompt, effectiveVoice, evaluate, needsHumanize, humanizeRewriteText, VOICE_PROFILES, type VoiceProfile } from '../lib/notai';

// A legacy compaction checkpoint message (raw <compacted-summary> block).
function isCompactedMsg(m: ChatMessage): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.includes('<compacted-summary>');
}

// Build the model context for a conversation. When compacted, prepend the summary
// as leading context and keep only the messages added after compaction; the full
// visible history is preserved separately for browsing.
function modelHistory(conv: Conversation): ChatMessage[] {
  if (conv.compactedSummary) {
    const prefix: ChatMessage = { role: 'user', content: frameCompactedSummary(conv.compactedSummary) };
    return [prefix, ...conv.messages.slice(conv.compactedCount ?? 0)];
  }
  return conv.messages;
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
import type { ChatAttachment, ChatMessage, ChatParams, Conversation, EngineStatus, StatusPayload } from '../lib/types';
import { Markdown } from '../components/Markdown';
import { Badge, Button, cn, NumberField, Segmented, SelectField, Toggle } from '../components/ui';


const DEFAULT_PARAMS: ChatParams = {
  thinking: true,
  reasoningEffort: '',
  preserveThinking: true,
  maxTokens: null as unknown as number,
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
};

function ActionBtn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-1 text-faint transition-colors hover:bg-panel2 hover:text-ink"
    >
      {children}
    </button>
  );
}

const MessageRow = memo(function MessageRow({
  m,
  streaming,
  convId,
  index,
  actions,
}: {
  m: ChatMessage;
  streaming?: boolean;
  convId: string;
  index: number;
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
        <ActionBtn title="Regenerate" onClick={() => actions.onRegenerate(convId, index)}>
          <RefreshCw size={13} />
        </ActionBtn>
      )}
      {m.role === 'user' && (
        <ActionBtn title="Edit" onClick={startEdit}>
          <Pencil size={13} />
        </ActionBtn>
      )}
      <ActionBtn title="Branch from here" onClick={() => actions.onBranch(convId, index)}>
        <GitBranch size={13} />
      </ActionBtn>
      <ActionBtn title="Delete from here" onClick={() => actions.onDelete(convId, index)}>
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
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {m.attachments.map((a, i) => (
                    <span key={i} className="inline-flex items-center gap-1 rounded-md border border-line bg-inset px-2 py-1 text-[11px] text-mute">
                      {a.kind === 'image' ? '🖼' : a.kind === 'video' ? '🎞' : '📄'} {a.name}
                      {a.dataUrl && <span className="text-faint">{formatBytes(a.dataUrl.length * 0.75)}</span>}
                    </span>
                  ))}
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
              <Button size="sm" variant="subtle" className="mt-2" onClick={() => actions.onRegenerate(convId, index)}>
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
}: {
  params: ChatParams;
  setParams: (p: ChatParams) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
  disabled?: boolean;
}) {
  const set = (patch: Partial<ChatParams>) => setParams({ ...params, ...patch });
  const row = 'grid grid-cols-[150px_1fr] items-center gap-3';
  const lab = 'text-[12px] text-mute';
  const num = 'w-24';
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
          <span className={lab}>System prompt</span>
          <textarea
            value={params.systemPrompt || ''}
            onChange={(e) => set({ systemPrompt: e.target.value })}
            rows={3}
            placeholder="optional system instructions"
            className="w-full resize-y rounded-lg border border-line bg-inset px-2.5 py-2 text-[12.5px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
          />
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
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-panel/40 px-4 text-[11px] text-faint">
        <Gauge size={12} /> context limit not reported — set --max-context to track usage
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
        'flex h-7 shrink-0 items-center gap-2 border-b border-line bg-panel/40 px-4 text-[11px]',
        pct > 90 ? 'text-danger' : pct > 75 ? 'text-warn' : 'text-faint',
      )}
      title={used != null ? `${formatTokens(used)} / ${formatTokens(limit)} tokens` : 'no requests yet'}
    >
      <Gauge size={12} className={pct > 75 ? '' : 'text-faint'} />
      <span className="text-faint">ctx</span>
      <span className="relative h-1.5 w-28 overflow-hidden rounded-full bg-line">
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
  const [loaded, setLoaded] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [model, setModel] = useState<string>(status?.engine?.modelId || '');
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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
  const modelOptions = upEngines
    .map((e) => ({ value: e.modelId || '', port: e.port }))
    .filter((e) => e.value)
    .filter((e, i, arr) => arr.findIndex((x) => x.value === e.value) === i);

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
      saveConversations({ conversations: convs.slice(0, 200), params }).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(t);
  }, [convs, params, loaded]);
  const setParams = useCallback((p: ChatParams) => setParamsState(p), []);

  const active = convs.find((c) => c.id === activeId) || null;

  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

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
      setNotice({ tone: 'danger', text: e instanceof Error ? e.message : 'compaction failed' });
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
      const ac = new AbortController();
      abortRef.current = ac;

      // Target the streaming placeholder by stable id when available; fall back to
      // the last message only when no id was assigned (C2).
      const isTarget = (m: ChatMessage, i: number, len: number): boolean =>
        placeholderId ? m.id === placeholderId : i === len - 1;

      let capturedToolCalls: import('../lib/types').AgentToolCall[] = [];

      await streamChat(
        buildChatRequest(useModel, effectiveSystemPrompt(params), history, params, { tools: CHAT_TOOLS }),
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
            const gateRes = evaluate(target.content, effectiveVoice(params), {});
            if (needsHumanize(gateRes)) {
              try {
                const rewritten = await humanizeRewriteText({
                  model: useModel,
                  baseSystem: effectiveSystemPrompt(params) || params.systemPrompt || '',
                  priorMessages: msgs.slice(0, idx),
                  originalText: target.content,
                  params,
                  signal: ac.signal,
                });
                if (!ac.signal.aborted && rewritten && rewritten.trim() && rewritten.trim() !== target.content.trim()) {
                  setConvs((cs) => cs.map((c) => c.id !== convId ? c : {
                    ...c, messages: c.messages.map((m, i) => (i === idx ? { ...m, content: rewritten } : m)),
                  }));
                }
              } catch {
                /* keep the original reply if the rewrite fails */
              }
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
      
      setStreaming(false);
      abortRef.current = null;
    },
    [engineUp, model, runningModel, params, onNavigate],
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

    const history: ChatMessage[] = modelHistory(base).filter((m) => m.role !== 'assistant' || m.meta?.finishReason || m.content);
    await runStream(newId, history, 0, asstMsg.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, attachments, engineUp, model, runningModel, convs, activeId, params, onNavigate, runStream]);

  // --- message-level actions (hover toolbar) ---
  const copyMessage = useCallback((m: ChatMessage) => {
    const text = m.role === 'assistant' && m.reasoning ? `> reasoning\n\n${m.reasoning}\n\n${m.content}` : m.content;
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }, []);

  // Delete this message and everything after it (a chat is a strict linear context).
  const deleteFrom = useCallback((convId: string, msgIndex: number) => {
    setConvs((cs) => cs.map((c) => (c.id !== convId ? c : { ...c, messages: c.messages.slice(0, msgIndex) })));
  }, []);

  // Fork the conversation up to and including this message into a new chat.
  const branchAt = useCallback((convId: string, msgIndex: number) => {
    const conv = convsRef.current.find((c) => c.id === convId);
    if (!conv) return;
    const fork: Conversation = {
      ...conv,
      id: uid(),
      title: conv.title ? `${conv.title} (branch)` : 'Branch',
      createdAt: Date.now(),
      messages: conv.messages.slice(0, msgIndex + 1).map((m) => ({ ...m })),
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
      const asst: ChatMessage = { role: 'assistant', content: '', model: model || runningModel, meta: {} };
      setConvs((cs) => cs.map((c) => (c.id !== convId ? c : { ...c, messages: [...prior, asst] })));
      runStream(convId, modelHistory({ ...conv, messages: prior })).catch((e) =>
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
      const asst: ChatMessage = { role: 'assistant', content: '', model: model || runningModel, meta: {} };
      setConvs((cs) => cs.map((c) => (c.id !== convId ? c : { ...c, messages: [...prior, asst] })));
      runStream(convId, modelHistory({ ...conv, messages: prior })).catch((e) =>
        console.error('[chat] resend run failed', e));
    },
    [model, runningModel, runStream],
  );

  const msgActions = useMemo(
    () => ({ onCopy: copyMessage, onRegenerate: regenerate, onEdit: editMessage, onDelete: deleteFrom, onBranch: branchAt }),
    [copyMessage, regenerate, editMessage, deleteFrom, branchAt],
  );

  // Slash-command interpreter. Returns true if `raw` was a recognized command
  // (so the caller can skip sending it to the engine as a normal message).
  const runCommand = useCallback(
    (raw: string): boolean => {
      const parts = raw.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ').trim();
      switch (cmd) {
        case '/clear':
          if (activeId) setConvs((cs) => cs.map((c) => (c.id === activeId ? { ...c, messages: [] } : c)));
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

  const newChat = () => {
    setActiveId(null);
    setText('');
    setAttachments([]);
    textareaRef.current?.focus();
  };

  const deleteConv = (id: string) => {
    setConvs((cs) => cs.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  };

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files).slice(0, 4)) {
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

  // Context-limit indicator: token usage of the latest completed request vs the
  // running engine's --max-context (surfaced on the status payload).
  const ctxLimit = status?.engine?.maxContext ?? null;
  const lastMeta =
    [...messages].reverse().find((m) => m.role === 'assistant' && m.meta && (m.meta.promptTokens || m.meta.completionTokens))?.meta ?? null;
  const ctxUsed = lastMeta ? (lastMeta.promptTokens ?? 0) + (lastMeta.completionTokens ?? 0) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
          <>
            {/* conversation rail */}
            <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel">
        <div className="p-2.5">
          <Button variant="primary" size="sm" className="w-full" onClick={newChat}>
            <Plus size={14} /> new chat
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {convs.length === 0 && <p className="px-2 py-3 text-[12px] leading-relaxed text-faint">No conversations yet. Start one below — everything runs locally against the NInfer engine.</p>}
          {convs.map((c) => (
            <div
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={cn(
                'group mb-1 cursor-pointer rounded-lg border px-2.5 py-2 transition-colors',
                c.id === activeId ? 'border-accent/30 bg-accent/8' : 'border-transparent hover:border-line hover:bg-panel2',
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{c.title || 'Untitled'}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteConv(c.id);
                  }}
                  className="rounded p-0.5 text-faint opacity-0 hover:text-danger group-hover:opacity-100"
                  title="Delete conversation"
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
        <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel/60 px-4">
          <SelectField
            value={model}
            onChange={setModel}
            disabled={streaming}
            className="h-7 w-48 text-[12px]"
            options={
              modelOptions.length
                ? Array.from(new Set([model, ...modelOptions.map((o) => o.value)].filter(Boolean))).map((v) => {
                    const hit = modelOptions.find((o) => o.value === v);
                    return { value: v, label: hit && upEngines.length > 1 ? `${v} · :${hit.port}` : v };
                  })
                : Array.from(new Set([runningModel, model].filter(Boolean))).map((v) => ({ value: v, label: v }))
            }
          />
          <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
            {engineUp ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-ok" /> {upEngines.length > 1 ? `${upEngines.length} engines ready` : 'engine ready'}
              </>
            ) : (
              <>
                <span className={cn('h-1.5 w-1.5 rounded-full', engine?.state === 'starting' ? 'bg-warn pulse-dot' : 'bg-faint')} />
                {engine?.state === 'starting' ? 'engine starting…' : 'engine offline'}
              </>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {params.thinking && (
              <Badge tone="accent">
                <BrainCircuit size={11} /> thinking{params.reasoningEffort ? `:${params.reasoningEffort}` : ''}
              </Badge>
            )}
            {params.maxTokens ? <Badge tone="neutral">max {formatTokens(params.maxTokens)}</Badge> : null}
            {params.greedy && <Badge tone="info">greedy</Badge>}
          </div>
        </div>

        <ContextMeter used={ctxUsed} limit={ctxLimit} />

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

        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
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
                      streaming={streaming && i === messages.length - 1}
                      actions={msgActions}
                    />
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>

        {/* composer */}
        <div className="shrink-0 border-t border-line bg-panel p-3">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5 px-1">
              {attachments.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-inset px-2 py-1 text-[11.5px] text-mute">
                  {a.kind === 'image' ? '🖼' : '🎞'} {a.name}
                  <button type="button" onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))} className="text-faint hover:text-danger">
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
          <div className="relative rounded-xl border border-line bg-inset focus-within:border-accent/50">
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
              placeholder={engineUp ? `Message ${model || 'engine'}…  (Enter to send, Shift+Enter for newline)` : 'Engine is offline — open the Engine tab to start it'}
              className="max-h-[220px] w-full resize-none bg-transparent px-3.5 pt-3 text-[13.5px] leading-relaxed text-ink placeholder:text-faint focus:outline-none"
            />
            <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
              <input ref={fileRef} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                title="Attach image or video (vision must be enabled on the engine)"
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
              {streaming || compacting ? (
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
                <ParamsPopover params={params} setParams={setParams} open={paramsOpen} setOpen={setParamsOpen} disabled={streaming} />
              </div>
            )}
          </div>
          <div className="mt-1.5 flex items-center justify-end px-1 text-[10.5px] text-faint">
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
