import { Suspense, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react';
import {
  BrainCircuit,
  ChevronDown,
  ChevronUp,
  Download,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Search,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { coderWebFetch, coderWebSearch, frameCompactedSummary, getConversations, saveConversations, suggestFollowUps, summarizeConversation } from '../lib/api';
import { effectiveSystemPrompt, effectiveVoice, humanizeRewriteText, VOICE_PROFILES, type VoiceProfile } from '../lib/notai';
import { isCompactedMsg, runToolLoop, humanizePassText, type ToolRegistry } from '../lib/agentLoop';
import { formatRate, formatTime, formatTokens, uid } from '../lib/format';
import type { MessageMeta } from '../lib/types';
import { setLatestRequestMetrics } from '../lib/liveMetrics';
import type { ChatAttachment, ChatMessage, ChatParams, Conversation, EngineStatus, SavedChatParams, StatusPayload } from '../lib/types';
import { Badge, Button, cn } from '../components/ui';
import { ActionBtn, CompactDivider, MessageRow } from '../components/chatMessage';
import { ParamsPopover, ContextMeter } from '../components/chatParams';
import { modelHistory, withMessages, RECENT_MESSAGE_WINDOW, DEFAULT_PARAMS, chatSystemWithCapabilities, CHAT_TOOLS, SLASH_COMMANDS, normalizeParams } from '../lib/chatHelpers';

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
  const [pendingDelete, setPendingDelete] = useState<{ conv: Conversation; index: number }[] | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
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
    setFindOpen(false);
    setFindQuery('');
    setShowAllMessages(false);
  }, [activeId]);

  useEffect(() => () => { if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current); }, []);

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
    async (convId: string, history: ChatMessage[], _depth = 0, placeholderId?: string) => {
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

      // Live target for streamed deltas: the caller's placeholder for turn 0;
      // each later tool turn appends its own placeholder (onTurnStart) and
      // re-points this target. Falls back to the last message only when no id
      // was assigned (C2).
      let liveTargetId: string | undefined = placeholderId;
      const patchTarget = (updater: (m: ChatMessage) => ChatMessage) => {
        setConvs((cs) =>
          cs.map((c) =>
            c.id !== convId ? c : {
              ...c,
              messages: c.messages.map((m, i, arr) =>
                (liveTargetId ? m.id === liveTargetId : i === arr.length - 1) ? updater(m) : m),
            }),
        );
      };

      // Chat tools as a registry for the shared runner: two read-only web
      // tools under the same ToolRegistry contract the coder loops use.
      const registry: ToolRegistry = {
        web_fetch: (args, signal) => coderWebFetch(String(args.url ?? ''), signal).then((r) => JSON.stringify(r)),
        web_search: (args, signal) => coderWebSearch(String(args.query ?? ''), signal).then((r) => JSON.stringify(r)),
      };
      // The runner owns the turn messages; these events mirror each turn into
      // the conversation store so streaming stays live.
      let lastTurnMeta: MessageMeta | undefined;
      const res = await runToolLoop({
        model: useModel,
        system: chatSystemWithCapabilities(params),
        messages: history,
        params,
        tools: CHAT_TOOLS,
        registry,
        maxSteps: 12,
        signal: ac.signal,
        onTurnStart: (turn) => {
          if (turn === 0 || ac.signal.aborted) return;
          const next: ChatMessage = { role: 'assistant', content: '', id: uid(), model: useModel, meta: {} };
          liveTargetId = next.id;
          setConvs((cs) => cs.map((c) => (c.id !== convId ? c : { ...c, messages: [...c.messages, next] })));
        },
        onDelta: (kind, text) => {
          if (kind === 'content') patchTarget((m) => ({ ...m, content: m.content + text }));
          else patchTarget((m) => ({ ...m, reasoning: (m.reasoning || '') + text }));
        },
        onStreamError: (msg) => {
          patchTarget((m) => ({ ...m, error: true, content: m.content || msg, meta: { finishReason: 'error' } }));
        },
        onAppended: (appended) => {
          const [first, ...rest] = appended;
          if (first && first.role === 'assistant') {
            patchTarget((m) => ({
              ...m,
              content: first.content,
              reasoning: first.reasoning ?? m.reasoning,
              tool_calls: first.tool_calls,
              model: useModel,
              meta: lastTurnMeta ?? m.meta,
            }));
          } else if (first) {
            setConvs((cs) => cs.map((c) => (c.id !== convId ? c : { ...c, messages: [...c.messages, first] })));
          }
          if (rest.length) {
            setConvs((cs) => cs.map((c) => (c.id !== convId ? c : { ...c, messages: [...c.messages, ...rest] })));
          }
        },
        onAssistantTurn: async (msg, info) => {
          lastTurnMeta = info.meta;
          setLatestRequestMetrics(info.meta, useModel);
          // Not-Ai auto-rewrite: plain content replies run the deterministic
          // tell-gate (best-effort — any failure keeps the original reply and
          // never strands the streaming state).
          if (ac.signal.aborted || !params.humanize || (msg.tool_calls?.length ?? 0) > 0 || !msg.content.trim()) return;
          try {
            const humanized = await humanizePassText(msg.content, {
              voice: effectiveVoice(params),
              signal: ac.signal,
              rewrite: (current) => humanizeRewriteText({
                model: useModel,
                baseSystem: effectiveSystemPrompt(params) || params.systemPrompt || '',
                priorMessages: history,
                originalText: current,
                params,
                signal: ac.signal,
              }),
            });
            if (!ac.signal.aborted && humanized.trim() !== msg.content.trim()) return { content: humanized };
          } catch (humanizeError) {
            // The gate or rewrite must never take the whole run down — the reply
            // is already complete and shown; keep it and release the UI.
            console.warn('[chat] humanize pass skipped (gate/rewrite failed)', humanizeError);
          }
        },
      });

      // Tool-step budget: the runner stops after 12 tool cycles without a
      // final reply, same guard the old depth>=12 recursion carried.
      if (res.stop === 'steps' && !ac.signal.aborted) {
        patchTarget((m) => ({
          ...m,
          content: m.content + `\n\n[System: Tool execution limit reached after 12 steps — the agent could not finish. Try a more specific request, e.g. "give me an image URL of a golden retriever puppy".]`,
          error: true,
        }));
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
          // The final reply is the last assistant message (past the original
          // placeholder once tool turns ran), not necessarily the placeholder.
          const finalMsg = [...msgsForCompact].reverse().find((m) => m.role === 'assistant');
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
          let idxForFollowUps = msgsForFollowUps.length - 1;
          while (idxForFollowUps >= 0 && msgsForFollowUps[idxForFollowUps].role !== 'assistant') idxForFollowUps--;
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
  // Ctrl/Cmd+F: open find-in-conversation instead of the browser's own find.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        newChat();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
        setFindIndex(0);
        requestAnimationFrame(() => findInputRef.current?.focus());
      } else if (e.key === 'Escape' && findOpen) {
        setFindOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [newChat, findOpen]);

  // Delete is soft for 5s: the conversation(s) leave `convs` immediately (so
  // the sidebar/persistence reflect it right away) but are held in
  // `pendingDelete` so a misclick (or a bulk delete) can be undone before
  // they're really gone.
  const softDelete = (ids: string[]) => {
    const idSet = new Set(ids);
    const removed: { conv: Conversation; index: number }[] = [];
    convs.forEach((c, i) => {
      if (idSet.has(c.id)) removed.push({ conv: c, index: i });
    });
    if (removed.length === 0) return;
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    setConvs((cs) => cs.filter((c) => !idSet.has(c.id)));
    if (activeId && idSet.has(activeId)) setActiveId(null);
    setPendingDelete(removed);
    deleteTimerRef.current = setTimeout(() => setPendingDelete(null), 5000);
  };

  const deleteConv = (id: string) => softDelete([id]);

  const undoDelete = () => {
    if (!pendingDelete) return;
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    setConvs((cs) => {
      const next = cs.slice();
      // Ascending original-index order so relative positions stay sane.
      [...pendingDelete]
        .sort((a, b) => a.index - b.index)
        .forEach(({ conv, index }) => next.splice(Math.min(index, next.length), 0, conv));
      return next;
    });
    if (pendingDelete.length === 1) setActiveId(pendingDelete[0].conv.id);
    setPendingDelete(null);
  };

  const renameConv = (id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
  };

  const togglePin = (id: string) => {
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));
  };

  const conversationToMarkdown = (conv: Conversation): string => {
    const lines = [`# ${conv.title || 'Untitled'}`, '', `_${conv.model} · ${new Date(conv.createdAt).toLocaleString()}_`];
    for (const m of conv.messages) {
      if (isCompactedMsg(m) || (!m.content && !m.reasoning)) continue;
      if (m.role === 'user') lines.push('', '### You', '', m.content);
      else if (m.role === 'assistant') lines.push('', '### Ninfer', '', m.content);
    }
    return lines.join('\n');
  };

  const downloadText = (filename: string, text: string) => {
    const blob = new Blob([text + '\n'], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const safeFilename = (title: string) => (title || 'chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);

  const exportConv = (conv: Conversation) => downloadText(`${safeFilename(conv.title)}.md`, conversationToMarkdown(conv));

  const exportConvs = (ids: string[]) => {
    const selected = convs.filter((c) => ids.includes(c.id));
    if (selected.length === 0) return;
    if (selected.length === 1) return exportConv(selected[0]);
    const text = selected.map(conversationToMarkdown).join('\n\n---\n\n');
    downloadText(`chats-export-${selected.length}.md`, text);
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

  // Find-in-conversation always sees the full list (a match outside the
  // rendered window would have no DOM node for scrollIntoView to find), so
  // opening it bypasses windowing entirely rather than needing special-cased
  // "expand to reveal this match" logic.
  const windowingActive = !showAllMessages && !findOpen && messages.length > RECENT_MESSAGE_WINDOW;
  const visibleStart = windowingActive ? messages.length - RECENT_MESSAGE_WINDOW : 0;
  const hiddenMessageCount = visibleStart;

  // Find-in-conversation: indices of messages whose content matches the
  // query, cycled through by findIndex. Message-level, not sub-string
  // highlighting — injecting <mark> into rendered markdown isn't worth the
  // complexity for jumping to the right message in a long conversation.
  const findMatches = useMemo(() => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return [] as number[];
    const out: number[] = [];
    messages.forEach((m, i) => {
      if (m.content.toLowerCase().includes(q)) out.push(i);
    });
    return out;
  }, [messages, findQuery]);

  const jumpToFindMatch = (dir: 1 | -1) => {
    if (findMatches.length === 0) return;
    const next = (((findIndex + dir) % findMatches.length) + findMatches.length) % findMatches.length;
    setFindIndex(next);
    document.getElementById(`msg-${findMatches[next]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // A fresh query always starts back at its first match.
  useEffect(() => {
    setFindIndex(0);
    if (findMatches.length > 0) {
      document.getElementById(`msg-${findMatches[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery]);

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
            <div className="flex items-center gap-1.5">
              <div className="relative min-w-0 flex-1">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  value={convSearch}
                  onChange={(e) => setConvSearch(e.target.value)}
                  placeholder="Search chats…"
                  className="w-full rounded-lg border border-line bg-inset py-1.5 pl-7 pr-2.5 text-[12px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectMode((v) => !v);
                  setSelectedIds(new Set());
                }}
                className="shrink-0 rounded-md px-2 py-1.5 text-[11.5px] font-medium text-faint hover:bg-panel2 hover:text-ink"
              >
                {selectMode ? 'Cancel' : 'Select'}
              </button>
            </div>
          </div>
        )}
        {selectMode && selectedIds.size > 0 && (
          <div className="mx-2.5 mb-2 flex items-center justify-between gap-2 rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-[11.5px] text-mute">
            <span>{selectedIds.size} selected</span>
            <div className="flex items-center gap-2.5">
              <button type="button" onClick={() => exportConvs([...selectedIds])} className="font-medium text-ink hover:text-accent">
                Export
              </button>
              <button
                type="button"
                onClick={() => {
                  softDelete([...selectedIds]);
                  setSelectedIds(new Set());
                  setSelectMode(false);
                }}
                className="font-medium text-danger hover:underline"
              >
                Delete
              </button>
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
              onClick={() => {
                if (renamingId === c.id) return;
                if (selectMode) {
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(c.id)) next.delete(c.id);
                    else next.add(c.id);
                    return next;
                  });
                } else {
                  setActiveId(c.id);
                }
              }}
              onKeyDown={(e) => {
                // Ignore keydowns bubbling up from the rename input or the
                // pin/rename/export/delete buttons — only act when the row
                // itself is the focused element.
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.currentTarget.click();
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
                {selectMode && (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(c.id)}
                    onChange={() => {}}
                    className="shrink-0 accent-accent"
                    aria-label={`Select ${c.title || 'Untitled'}`}
                  />
                )}
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
                {!selectMode && (
                  <>
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
                  </>
                )}
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
        {pendingDelete && (
          <div className="m-2 flex items-center justify-between gap-2 rounded-lg border border-line bg-panel2 px-2.5 py-2 text-[11.5px] text-mute">
            <span className="truncate">
              {pendingDelete.length === 1 ? `Deleted "${pendingDelete[0].conv.title || 'Untitled'}"` : `Deleted ${pendingDelete.length} conversations`}
            </span>
            <button type="button" onClick={undoDelete} className="shrink-0 font-medium text-accent hover:underline">
              Undo
            </button>
          </div>
        )}
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
        {findOpen && (
          <div className="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2 py-1.5 shadow-lg">
            <Search size={13} className="text-faint" />
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  jumpToFindMatch(e.shiftKey ? -1 : 1);
                } else if (e.key === 'Escape') {
                  setFindOpen(false);
                }
              }}
              placeholder="Find in conversation…"
              className="w-48 bg-transparent text-[12.5px] text-ink placeholder:text-faint focus:outline-none"
            />
            <span className="whitespace-nowrap text-[11px] text-faint">
              {findQuery.trim() ? (findMatches.length > 0 ? `${findIndex + 1}/${findMatches.length}` : '0/0') : ''}
            </span>
            <ActionBtn title="Previous match" onClick={() => jumpToFindMatch(-1)} disabled={findMatches.length === 0}>
              <ChevronUp size={13} />
            </ActionBtn>
            <ActionBtn title="Next match" onClick={() => jumpToFindMatch(1)} disabled={findMatches.length === 0}>
              <ChevronDown size={13} />
            </ActionBtn>
            <ActionBtn title="Close find" onClick={() => setFindOpen(false)}>
              <X size={13} />
            </ActionBtn>
          </div>
        )}
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
                {hiddenMessageCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAllMessages(true)}
                    className="mx-auto rounded-full border border-line bg-panel px-3 py-1.5 text-[11.5px] text-mute hover:border-accent/40 hover:text-ink"
                  >
                    Show {hiddenMessageCount} earlier message{hiddenMessageCount === 1 ? '' : 's'}
                  </button>
                )}
                {messages.slice(visibleStart).map((m, sliceI) => {
                  const i = visibleStart + sliceI;
                  if (isCompactedMsg(m)) return <CompactDivider key={`div-${i}`} />;
                  const showDivider = !!active?.compactedSummary && i === (active.compactedCount ?? 0);
                  return (
                    <Fragment key={i}>
                      {showDivider && <CompactDivider />}
                      <div id={`msg-${i}`}>
                        <MessageRow
                          m={m}
                          convId={activeId ?? ''}
                          index={i}
                          isLast={i === messages.length - 1}
                          streaming={streaming && streamingConvId === activeId && i === messages.length - 1}
                          locked={streaming || compacting}
                          actions={msgActions}
                        />
                      </div>
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
