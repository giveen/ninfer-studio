import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BrainCircuit,
  ChevronDown,
  Gauge,
  Paperclip,
  Play,
  Plus,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { buildChatRequest, frameCompactedSummary, getConversations, saveConversations, streamChat, summarizeConversation } from '../lib/api';
import { formatBytes, formatMs, formatRate, formatTime, formatTokens, uid } from '../lib/format';
import { setLatestRequestMetrics } from '../lib/liveMetrics';
import type { ChatAttachment, ChatMessage, ChatParams, Conversation, EngineStatus, StatusPayload } from '../lib/types';
import { Markdown } from '../components/Markdown';
import { Badge, Button, cn, NumberField, SelectField, Toggle } from '../components/ui';

const DEFAULT_PARAMS: ChatParams = {
  thinking: true,
  reasoningEffort: '',
  preserveThinking: true,
  maxTokens: null as unknown as number,
};

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
  const [open, setOpen] = useState(true);
  if (!text) return null;
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-line bg-inset/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-[11.5px] font-medium uppercase tracking-wider text-faint hover:text-mute"
      >
        <BrainCircuit size={13} className={open ? 'text-accent' : 'text-faint'} />
        thinking
        <ChevronDown size={13} className={cn('ml-auto transition-transform', !open && '-rotate-90')} />
      </button>
      {open && (
        <div className={cn('border-t border-line px-3 py-2 text-[12.5px] leading-relaxed text-mute', streaming && 'stream-caret')}>
          <Markdown>{text}</Markdown>
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

function MessageRow({ m, streaming }: { m: ChatMessage; streaming?: boolean }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-xl rounded-br-sm border border-line bg-panel2 px-3.5 py-2.5">
          {m.attachments && m.attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {m.attachments.map((a, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md border border-line bg-inset px-2 py-1 text-[11px] text-mute">
                  {a.kind === 'image' ? '🖼' : '🎞'} {a.name}
                  <span className="text-faint">{formatBytes(a.dataUrl.length * 0.75)}</span>
                </span>
              ))}
            </div>
          )}
          {m.content && <div className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{m.content}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-full">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-accent">ninfer</span>
        {m.model && <span className="font-mono text-[10.5px] text-faint">{m.model}</span>}
        {streaming && <span className="h-1.5 w-1.5 rounded-full bg-accent pulse-dot" />}
      </div>
      <ReasoningBlock text={m.reasoning || ''} streaming={streaming && !m.content} />
      <div className={cn('rounded-xl rounded-tl-sm border border-line bg-panel px-3.5 py-2.5', streaming && m.content && 'stream-caret')}>
        {m.error ? (
          <div className="text-[13px] text-danger">{m.content}</div>
        ) : m.content ? (
          <div className="markdown text-[13.5px] leading-relaxed">
            <Markdown>{m.content}</Markdown>
          </div>
        ) : !streaming && !m.reasoning ? (
          <span className="text-[13px] text-faint">—</span>
        ) : null}
      </div>
      <MessageMeta m={m} />
    </div>
  );
}

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
  const [model, setModel] = useState<string>(status?.engine?.modelId || 'qwen3.8-27b');
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    if (runningModel && !convs.length) setModel(runningModel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningModel]);

  useEffect(() => {
    if (!loaded) return;
    saveConversations({ conversations: convs.slice(0, 200), params }).catch(() => undefined);
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
      const summary = await summarizeConversation({
        model: useModel,
        systemPrompt: params.systemPrompt,
        history: conv.messages,
        signal: ac.signal,
      });
      if (!summary) throw new Error('compaction produced no summary');
      const compacted: Conversation = { ...conv, messages: [{ role: 'user', content: frameCompactedSummary(summary) }] };
      setConvs((cs) => cs.map((c) => (c.id === compacted.id ? compacted : c)));
      setNotice({ tone: 'ok', text: 'Conversation compacted — context preserved as a checkpoint. Keep chatting from here.' });
    } catch (e) {
      setNotice({ tone: 'danger', text: e instanceof Error ? e.message : 'compaction failed' });
    } finally {
      setCompacting(false);
      abortRef.current = null;
    }
  }, [compacting, engineUp, convs, activeId, model, runningModel, params, onNavigate]);

  const send = useCallback(async () => {
    const content = text.trim();
    if (!content && !attachments.length) return;
    if (content === '/compact') {
      await runCompact();
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
    const asstMsg: ChatMessage = { role: 'assistant', content: '', model: useModel, meta: {} };
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
    setStreaming(true);

    const history: ChatMessage[] = base.messages.filter((m) => m.role !== 'assistant' || m.meta?.finishReason || m.content);
    const ac = new AbortController();
    abortRef.current = ac;

    await streamChat(
      buildChatRequest(useModel, params.systemPrompt, history, params),
      ac.signal,
      {
        onReasoningDelta: (d) => {
          setConvs((cs) =>
            cs.map((c) =>
              c.id !== newId
                ? c
                : {
                    ...c,
                    messages: c.messages.map((m, i) =>
                      i === c.messages.length - 1 ? { ...m, reasoning: (m.reasoning || '') + d } : m,
                    ),
                  },
            ),
          );
        },
        onContentDelta: (d) => {
          setConvs((cs) =>
            cs.map((c) =>
              c.id !== newId
                ? c
                : {
                    ...c,
                    messages: c.messages.map((m, i) => (i === c.messages.length - 1 ? { ...m, content: m.content + d } : m)),
                  },
            ),
          );
        },
        onUsage: (_u, meta) => {
          setConvs((cs) => cs.map((c) => (c.id !== newId ? c : { ...c, messages: c.messages.map((m, i) => (i === c.messages.length - 1 ? { ...m, meta } : m)) })));
          setLatestRequestMetrics(meta, useModel);
        },
        onDone: (meta) => {
          setConvs((cs) => cs.map((c) => (c.id !== newId ? c : { ...c, messages: c.messages.map((m, i) => (i === c.messages.length - 1 ? { ...m, meta } : m)) })));
          setLatestRequestMetrics(meta, useModel);
          setStreaming(false);
        },
        onError: (msg) => {
          setConvs((cs) =>
            cs.map((c) =>
              c.id !== newId
                ? c
                : {
                    ...c,
                    messages: c.messages.map((m, i) =>
                      i === c.messages.length - 1 ? { ...m, error: true, content: m.content || msg, meta: { finishReason: 'error' } } : m,
                    ),
                  },
            ),
          );
          setStreaming(false);
        },
      },
    );
    abortRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, attachments, engineUp, model, runningModel, convs, activeId, params, onNavigate]);

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
    <div className="flex h-full">
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
              {messages.map((m, i) => (
                <MessageRow key={i} m={m} streaming={streaming && i === messages.length - 1} />
              ))}
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
    </div>
  );
}
