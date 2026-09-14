import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react';
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
  Shield,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { HitlDialog } from '../components/HitlDialog';
import { coderWebFetch, coderWebSearch, frameCompactedSummary, getConversations, saveConversations, suggestFollowUps, summarizeConversation, coderRead, coderWrite, coderEdit, coderPatch, coderExec, coderJob, coderGrep, coderGlob, coderDirs, coderSearch } from '../lib/api';
import { GIT_BRANCH_LIST_CMD, parseBranchList } from '../lib/gitStatus';
import { effectiveSystemPrompt, effectiveVoice, humanizeRewriteText, VOICE_PROFILES, type VoiceProfile } from '../lib/notai';
import { isCompactedMsg, runToolLoop, humanizePassText, type ToolHandler, type ToolRegistry } from '../lib/agentLoop';
import { formatRate, formatTime, formatTokens, uid } from '../lib/format';
import type { MessageMeta } from '../lib/types';
import { setLatestRequestMetrics } from '../lib/liveMetrics';
import type { ChatAttachment, ChatMessage, ChatParams, Conversation, EngineStatus, SavedChatParams, StatusPayload } from '../lib/types';
import { Badge, Button, cn } from '../components/ui';
import { ActionBtn, CompactDivider, MessageRow } from '../components/chatMessage';
import { ParamsPopover, ContextMeter } from '../components/chatParams';
import { modelHistory, withMessages, RECENT_MESSAGE_WINDOW, DEFAULT_PARAMS, chatSystemWithCapabilities, CHAT_TOOLS, CHAT_BROWSER_TOOL, CHAT_MEMORY_TOOL, COMPUTER_USE_TOOLS, checkComputerUsePerm, dedupeTools, SLASH_COMMANDS, normalizeParams } from '../lib/chatHelpers';
import { knownResponsesSupport, paramsSupportedByResponses, probeResponsesSupport, streamResponses } from '../lib/api/responses';
import { useChatAgent } from '../lib/chatAgent';
import { coderBrowser, chatMemoryAddLearning, chatMemoryGet, critiqueChatReply, regenerateChatReply, coderPermsApprove, mcpToolsGet, mcpCall, type CoderLearningKind, type McpToolInfo } from '../lib/api';
import { readRecallChunk } from '../lib/observationPack';
import { filterToolAllowList, mcpToolTier, mcpToolSchema, MCP_NAME_PREFIX } from '../lib/coderTools';
import { runDeepResearch } from '../lib/deepResearch';
import { engineMaxConcurrency } from '../lib/engineInfo';

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
function ChatScreenImpl({ status, onNavigate }: { status: StatusPayload | null; onNavigate: (s: 'chat' | 'engine' | 'models' | 'settings') => void }) {
  const {
    agentResearch, memoryEnabled, memoryRef, adoptMemory, reflectionEnabled, deepResearchEnabled, reflectionModel, browserTier, memoryToolTier,
    deepResearchMaxAngles, deepResearchMaxSteps, reflectionCritiqueMaxTokens,
    computerUseEnabled, computerUseDirRef, computerUsePerms, setComputerUseDir, computerUseDir,
  } = useChatAgent();
  // A tool call awaiting the user's approve/deny decision (permission tier `ask`) —
  // mirrors Coder's checkPerm/requestApproval/pendingApproval pattern.
  const [pendingApproval, setPendingApproval] = useState<{ name: string; detail: string } | null>(null);
  const approvalResolveRef = useRef<((ok: boolean) => void) | null>(null);
  // Computer Use's `todo_write`: a scratch plan the model can record/update
  // mid-conversation. No dedicated panel (unlike Coder) — just enough state
  // for the tool to have somewhere to write, so the model isn't calling into
  // a black hole.
  const cuTodosRef = useRef<Array<{ content: string; status: string }>>([]);
  // MCP tools (mcp__<server>__<tool>) exposed to Chat's agent when Computer
  // Use is on — the control plane owns the server connections
  // (desktop/control/src/mcp.rs). The catalog is keyed by the same directory
  // the tiers and calls are scoped by, so it refreshes when either changes.
  const mcpToolsRef = useRef<McpToolInfo[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolInfo[]>([]);
  useEffect(() => {
    if (!computerUseEnabled || !computerUseDir) {
      mcpToolsRef.current = [];
      setMcpTools([]);
      return;
    }
    let live = true;
    mcpToolsGet(computerUseDir)
      .then((r) => { if (live) { mcpToolsRef.current = r.tools; setMcpTools(r.tools); } })
      .catch(() => { if (live) { mcpToolsRef.current = []; setMcpTools([]); } });
    return () => { live = false; };
  }, [computerUseEnabled, computerUseDir]);
  const requestApproval = useCallback((name: string, detail: string): Promise<boolean> => {
    setPendingApproval({ name, detail });
    return new Promise<boolean>((resolve) => {
      approvalResolveRef.current = (ok: boolean) => {
        approvalResolveRef.current = null;
        setPendingApproval(null);
        resolve(ok);
      };
    });
  }, []);
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
  /** Messages typed while THIS conversation is streaming — in-memory only
   *  (like the draft `text` itself), auto-sent one at a time once the
   *  current turn finishes (see runStream's tail) or left queued if the user
   *  hits Stop. Ref-mirrored so runStream's closure (captured whenever that
   *  useCallback was last recreated) sees items queued after that, not a
   *  stale snapshot. */
  type QueuedItem = { text: string; attachments: ChatAttachment[] };
  const queuedRef = useRef<Record<string, QueuedItem[]>>({});
  const [queued, setQueuedState] = useState<Record<string, QueuedItem[]>>({});
  const setQueued = (updater: Record<string, QueuedItem[]> | ((prev: Record<string, QueuedItem[]>) => Record<string, QueuedItem[]>)) => {
    setQueuedState((prev) => {
      const next = typeof updater === 'function' ? (updater as (p: Record<string, QueuedItem[]>) => Record<string, QueuedItem[]>)(prev) : updater;
      queuedRef.current = next;
      return next;
    });
  };
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

  // Tracks the last runningModel we synced from, so the effect below can
  // tell "the engine's model actually changed" apart from "nothing changed,
  // don't re-render". Deliberately not just `model !== runningModel`: after
  // a manual /model override, model and runningModel legitimately disagree
  // (multi-engine setups), and that disagreement must NOT keep resetting.
  const syncedRunningModelRef = useRef('');
  useEffect(() => {
    // Keep the selector pointed at the running engine's actual id. The engine
    // only answers to the id it was started with — if it changes underneath
    // us (the user restarts it with a different model/artifact), a selection
    // still pointed at the old id 404s on every turn, forever, until this
    // fires. Comparing against the *previous* runningModel (not the current
    // `model`) is what makes this fire again after such a restart, not just
    // on the very first engine-up.
    if (runningModel && runningModel !== syncedRunningModelRef.current) {
      setModel(runningModel);
      syncedRunningModelRef.current = runningModel;
    }
  }, [runningModel]);

  // Probe once per engine readiness change whether /v1/responses is
  // implemented (community forks may not have it) — cached, so `send` can
  // check it synchronously per turn without blocking on a fresh request.
  useEffect(() => {
    if (engineUp) void probeResponsesSupport();
  }, [engineUp]);

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

      // Deep research: concurrency-gated fan-out over the user's latest
      // question, run BEFORE the main turn so the findings are already in
      // context for the synthesis reply — same shape as Scout's
      // fan-out-then-inject-report pre-pass. The report is both appended to
      // `effectiveHistory` (for this call's model context) AND spliced into
      // the visible conv.messages as a collapsed "Deep Research" report
      // (ReportBlock, via MessageRow's displayName+collapsed branch) — same
      // treatment Coder gives Scout, so the findings are auditable instead
      // of only ever reaching the model invisibly.
      let effectiveHistory = history;
      const maxConcurrency = engineMaxConcurrency(status);
      if (deepResearchEnabled && maxConcurrency > 1 && !ac.signal.aborted) {
        const question = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
        if (question.trim()) {
          const maxAngles = Math.min(maxConcurrency, deepResearchMaxAngles);
          setNotice({ tone: 'ok', text: `Deep research: fanning out across up to ${maxAngles} angle${maxAngles === 1 ? '' : 's'}…` });
          try {
            const { angles, report } = await runDeepResearch({ model: useModel, question, maxAngles, maxStepsPerAngle: deepResearchMaxSteps, signal: ac.signal });
            if (report && !ac.signal.aborted) {
              const researchMsg: ChatMessage = {
                role: 'user',
                id: uid(),
                displayName: 'Deep Research',
                collapsed: true,
                content: `# Deep Research (${angles.length} parallel angle${angles.length === 1 ? '' : 's'})\n${angles.map((a, i) => `## ${i + 1}. ${a}`).join('\n\n')}\n\n---\n\n${report}`,
              };
              effectiveHistory = [...history, researchMsg];
              setConvs((cs) => cs.map((c) => {
                if (c.id !== convId) return c;
                const idx = placeholderId ? c.messages.findIndex((m) => m.id === placeholderId) : c.messages.length;
                const insertAt = idx >= 0 ? idx : c.messages.length;
                return { ...c, messages: [...c.messages.slice(0, insertAt), researchMsg, ...c.messages.slice(insertAt)] };
              }));
            }
          } catch (deepResearchError) {
            // Best-effort — a fan-out failure falls back to the main turn
            // researching unaided rather than blocking the reply entirely.
            console.warn('[chat] deep research skipped (fan-out failed)', deepResearchError);
          } finally {
            if (!ac.signal.aborted) setNotice(null);
          }
        }
      }

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

      // Chat tools as a registry for the shared runner: the same ToolRegistry
      // contract the coder loops use. Three independent, overlapping
      // surfaces can all define `browser`/`memory_update` (Agent Mode,
      // Memory, and Computer Use's own fallback for when the dedicated
      // toggle is off) — the merged `tools` schema list below is
      // de-duplicated by name (first entry wins), and the object-spread
      // order here is deliberately the MIRROR of that (Computer Use spreads
      // first, the dedicated toggles last) so whichever schema actually won
      // is backed by the matching handler, never the other one.
      const computerUseOn = computerUseEnabled && !!computerUseDirRef.current;
      const cuOuterCheck = async (name: string, args: Record<string, unknown>, detail: string): Promise<string | null> => {
        const verdict = checkComputerUsePerm(computerUsePerms, name, args);
        if (verdict === null) return null;
        if (verdict === 'ask') {
          const ok = await requestApproval(name, detail);
          return ok ? null : `Denied by the user (${name}). Ask for an alternative or proceed without it.`;
        }
        return verdict;
      };
      // One MCP tool (mcp__<server>__<tool>) — the control plane executes it
      // (desktop/control/src/mcp.rs) and re-checks the tier server-side
      // (per-tool row over the mcp__<server> row). Unlike the CU built-ins
      // above, an `ask` approval here mints a real token, so an ask-tiered
      // MCP tool can't 403 at the endpoint after the human approved.
      const mcpToolHandler = (toolName: string): ToolHandler => async (args, signal) => {
        const detail = JSON.stringify(args).slice(0, 160);
        const verdict = checkComputerUsePerm(computerUsePerms, toolName, args);
        if (typeof verdict === 'string' && verdict !== 'ask') return JSON.stringify({ error: verdict });
        let token: string | undefined;
        if (verdict === 'ask') {
          const ok = await requestApproval(toolName, detail);
          if (!ok) return JSON.stringify({ error: `Denied by the user (${toolName}). Ask for an alternative or proceed without it.` });
          try {
            token = (await coderPermsApprove(toolName, undefined, computerUseDirRef.current)).token;
          } catch { /* no token — the endpoint's ask re-check will reject; surfaced to the model */ }
        }
        const res = await mcpCall({ name: toolName, arguments: args, scope: computerUseDirRef.current, approvalToken: token }, signal);
        return res.ok ? res.output : JSON.stringify({ error: res.output });
      };
      // Always-on baseline (today's default, unchanged) — gated by Computer
      // Use's own tiers only once that's turned on, since it's the only
      // surface offering a permission control for these two. Hoisted out of
      // the `registry` object literal (not inline methods on it) so
      // `delegate`'s read-only nested loop can reuse the exact same
      // closures without referencing `registry` before it finishes
      // initializing (a TDZ error — `registry` isn't assigned yet while its
      // own initializer, including the Computer Use IIFE below, is still
      // running).
      const webFetchHandler: ToolHandler = async (args, signal) => {
        if (computerUseOn) {
          const err = await cuOuterCheck('web_fetch', args, String(args.url ?? ''));
          if (err) return JSON.stringify({ error: err });
        }
        return JSON.stringify(await coderWebFetch(String(args.url ?? ''), signal));
      };
      const webSearchHandler: ToolHandler = async (args, signal) => {
        if (computerUseOn) {
          const err = await cuOuterCheck('web_search', args, String(args.query ?? ''));
          if (err) return JSON.stringify({ error: err });
        }
        return JSON.stringify(await coderWebSearch(String(args.query ?? ''), signal));
      };
      const registry: ToolRegistry = {
        web_fetch: webFetchHandler,
        web_search: webSearchHandler,
        // Computer Use: general file/shell/search/git/subagent tools, scoped
        // to computerUseDirRef.current (independent of Coder's own
        // workspace — see chatAgent.tsx). Gated client-side by
        // checkComputerUsePerm and, server-side, by the same directory as
        // the enforce_perm scope key. Reads the ref fresh in every handler
        // (not a captured const) so `set_directory` takes effect for the
        // rest of THIS turn too, not just the next message. Also backs
        // `browser`/`memory_update` as a fallback for when Agent Mode /
        // Memory (below) aren't the ones providing them.
        ...(computerUseOn
          ? (() => {
              const cuCheck = cuOuterCheck;
              const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
              // Built first (without delegate/subagent) so those two can
              // safely reuse it as the nested loop's own registry — a
              // subagent's tool list is exactly "everything Computer Use
              // can do, minus spawning further subagents" (no recursion).
              const cuRegistry: ToolRegistry = {
                set_directory: async (args) => {
                  const requested = String(args.path ?? '').trim();
                  if (!requested) return JSON.stringify({ error: 'set_directory requires a non-empty `path`.' });
                  const err = await cuCheck('set_directory', args, requested);
                  if (err) return JSON.stringify({ error: err });
                  try {
                    const res = await coderDirs(requested);
                    if (!res.exists || !res.isDir) {
                      return JSON.stringify({ error: `${res.root || requested} does not exist or is not a directory.` });
                    }
                    computerUseDirRef.current = res.root;
                    setComputerUseDir(res.root);
                    return JSON.stringify({ ok: true, directory: res.root });
                  } catch (e) {
                    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
                  }
                },
                read: async (args, signal) => {
                  const err = await cuCheck('read', args, String(args.path ?? ''));
                  if (err) return JSON.stringify({ error: err });
                  return JSON.stringify(await coderRead(String(args.path ?? ''), args.offset as number | undefined, args.limit as number | undefined, signal, computerUseDirRef.current));
                },
                write: async (args, signal) => {
                  const err = await cuCheck('write', args, String(args.path ?? ''));
                  if (err) return JSON.stringify({ error: err });
                  return JSON.stringify(await coderWrite(String(args.path ?? ''), String(args.content ?? ''), signal, computerUseDirRef.current));
                },
                edit: async (args, signal) => {
                  const err = await cuCheck('edit', args, String(args.path ?? ''));
                  if (err) return JSON.stringify({ error: err });
                  return JSON.stringify(await coderEdit(String(args.path ?? ''), String(args.old ?? ''), String(args.new ?? ''), Boolean(args.replaceAll), signal, computerUseDirRef.current));
                },
                apply_patch: async (args, signal) => {
                  const err = await cuCheck('apply_patch', args, String(args.path ?? ''));
                  if (err) return JSON.stringify({ error: err });
                  const edits = Array.isArray(args.edits) ? args.edits as { old: string; new: string; replaceAll?: boolean }[] : [];
                  return JSON.stringify(await coderPatch(String(args.path ?? ''), edits, signal, computerUseDirRef.current));
                },
                bash: async (args, signal) => {
                  const command = String(args.command ?? '');
                  const err = await cuCheck('bash', args, command);
                  if (err) return JSON.stringify({ error: err });
                  const cuDir = computerUseDirRef.current;
                  return JSON.stringify(await coderExec(command, undefined, args.timeoutMs as number | undefined, cuDir, args.background === true, signal, cuDir));
                },
                bash_poll: async (args, signal) => {
                  try {
                    return JSON.stringify(await coderJob(String(args.jobId ?? ''), signal));
                  } catch (e) {
                    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
                  }
                },
                grep: async (args, signal) => {
                  const err = await cuCheck('grep', args, String(args.pattern ?? ''));
                  if (err) return JSON.stringify({ error: err });
                  return JSON.stringify(await coderGrep(String(args.pattern ?? ''), undefined, args.include as string | undefined, Boolean(args.ignoreCase), Number(args.offset) || 0, Number(args.limit) || 200, signal, computerUseDirRef.current));
                },
                glob: async (args, signal) => {
                  const err = await cuCheck('glob', args, String(args.pattern ?? ''));
                  if (err) return JSON.stringify({ error: err });
                  return JSON.stringify(await coderGlob(String(args.pattern ?? ''), undefined, Number(args.offset) || 0, Number(args.limit) || 200, signal, computerUseDirRef.current));
                },
                git_commit: async (args, signal) => {
                  const message = String(args.message ?? 'Agent commit');
                  const err = await cuCheck('git_commit', args, message);
                  if (err) return JSON.stringify({ error: err });
                  const fileTokens = args.files && String(args.files).trim() ? String(args.files).trim().split(/\s+/) : ['-A'];
                  const fileArgs = fileTokens.map((t) => (t.startsWith('-') ? t : q(t))).join(' ');
                  const cuDir = computerUseDirRef.current;
                  return JSON.stringify(await coderExec(`git add ${fileArgs} && git commit -m ${q(message)} && git rev-parse HEAD`, undefined, 30000, cuDir, false, signal, cuDir));
                },
                git_diff: async (args, signal) => {
                  const ref = String(args.ref ?? '').trim();
                  const pathTokens = String(args.path ?? '').trim().split(/\s+/).filter(Boolean);
                  const cmd = `git --no-pager diff ${ref ? q(ref) : ''} ${pathTokens.map(q).join(' ')}`.replace(/\s+/g, ' ').trim();
                  const cuDir = computerUseDirRef.current;
                  return JSON.stringify(await coderExec(cmd, undefined, 30000, cuDir, false, signal, cuDir));
                },
                ast_grep: async (args, signal) => {
                  const err = await cuCheck('ast_grep', args, String(args.pattern ?? ''));
                  if (err) return JSON.stringify({ error: err });
                  const cuDir = computerUseDirRef.current;
                  const pattern = String(args.pattern ?? '').replace(/'/g, "'\\''");
                  return JSON.stringify(await coderExec(`sg -p '${pattern}' -l ${args.lang}`, undefined, 15000, cuDir, false, signal, cuDir));
                },
                repo_search: async (args, signal) => {
                  const err = await cuCheck('repo_search', args, String(args.query ?? ''));
                  if (err) return JSON.stringify({ error: err });
                  return JSON.stringify(await coderSearch(String(args.query ?? ''), typeof args.limit === 'number' ? args.limit : 15, signal, computerUseDirRef.current));
                },
                git_branch: async (args, signal) => {
                  const action = String(args.action || 'list');
                  const err = await cuCheck('git_branch', args, `${action}${args.name ? ` ${args.name}` : ''}`);
                  if (err) return JSON.stringify({ error: err });
                  const cuDir = computerUseDirRef.current;
                  if (action === 'list') {
                    const r = await coderExec(GIT_BRANCH_LIST_CMD, undefined, 15000, cuDir, false, signal, cuDir);
                    const { current, branches } = parseBranchList(r.stdout || '');
                    return JSON.stringify({ current, branches, ...r });
                  }
                  if (action === 'create' || action === 'switch') {
                    const name = String(args.name || '').trim();
                    if (!name) return JSON.stringify({ error: `branch name required for action '${action}'` });
                    if (!/^[A-Za-z0-9._/-]+$/.test(name)) return JSON.stringify({ error: `invalid branch name: ${name}` });
                    const cmd = action === 'create' ? `git checkout -b ${q(name)}` : `git switch ${q(name)}`;
                    return JSON.stringify(await coderExec(cmd, undefined, 30000, cuDir, false, signal, cuDir));
                  }
                  return JSON.stringify({ error: `unknown action: ${action} (use list, create, or switch)` });
                },
                git_worktree: async (args, signal) => {
                  const action = String(args.action || 'list');
                  const err = await cuCheck('git_worktree', args, `${action}${args.path ? ` ${args.path}` : ''}`);
                  if (err) return JSON.stringify({ error: err });
                  const cuDir = computerUseDirRef.current;
                  if (action === 'list') {
                    const r = await coderExec('git worktree list', undefined, 15000, cuDir, false, signal, cuDir);
                    const lines = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
                    return JSON.stringify({ worktrees: lines, ...r });
                  }
                  if (action === 'add') {
                    const p = String(args.path || '').trim();
                    const b = String(args.branch || '').trim();
                    if (!p || !b) return JSON.stringify({ error: "path and branch required for action 'add'" });
                    if (!/^[A-Za-z0-9._/-]+$/.test(b) || !/^\.\.\/[A-Za-z0-9._/-]+$/.test(p)) {
                      return JSON.stringify({ error: "invalid branch or path (path must start with '../' to keep it out of the main worktree)" });
                    }
                    const cmd = `git worktree add -B ${q(b)} ${q(p)} ${q(b)} || git worktree add -b ${q(b)} ${q(p)}`;
                    return JSON.stringify(await coderExec(cmd, undefined, 30000, cuDir, false, signal, cuDir));
                  }
                  return JSON.stringify({ error: `unknown action: ${action} (use list or add)` });
                },
                git_pr: async (args, signal) => {
                  const err = await cuCheck('git_pr', args, String(args.title ?? '').slice(0, 40));
                  if (err) return JSON.stringify({ error: err });
                  const cuDir = computerUseDirRef.current;
                  const gitRemoteToWeb = (url: string, base: string, head: string): string => {
                    if (!url) return '';
                    let host: string | undefined; let repo: string | undefined;
                    const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
                    if (ssh) { host = ssh[1]; repo = ssh[2]; }
                    else {
                      try { const u = new URL(url); host = u.host; repo = u.pathname.replace(/^\//, '').replace(/\.git$/, ''); } catch { return ''; }
                    }
                    return host && repo ? `https://${host}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}` : '';
                  };
                  const br = await coderExec('git rev-parse --abbrev-ref HEAD', undefined, 10000, cuDir, false, signal, cuDir);
                  const branch = (br.stdout || '').trim();
                  if (!branch || branch === 'HEAD') {
                    return JSON.stringify({ ok: false, error: 'Cannot open a PR from a detached HEAD. Create or check out a branch first.' });
                  }
                  const st = await coderExec('git status --porcelain', undefined, 10000, cuDir, false, signal, cuDir);
                  if ((st.stdout || '').trim()) {
                    return JSON.stringify({ ok: false, error: 'Working tree is not clean — commit (or stash) your changes before opening a PR.' });
                  }
                  const rm = await coderExec('git remote', undefined, 10000, cuDir, false, signal, cuDir);
                  const remote = (rm.stdout || '').trim().split('\n')[0];
                  if (!remote) {
                    return JSON.stringify({ ok: false, error: 'No git remote configured. Add one (git remote add origin <url>) before opening a PR.' });
                  }
                  const base = String(args.base || '').trim()
                    || (await coderExec(`git rev-parse --abbrev-ref ${q(remote)}/HEAD 2>/dev/null || true`, undefined, 10000, cuDir, false, signal, cuDir)).stdout.trim()
                    || 'main';
                  const push = await coderExec(`git push -u ${q(remote)} ${q(branch)}`, undefined, 60000, cuDir, false, signal, cuDir);
                  if (push.exitCode !== 0) {
                    return JSON.stringify({ ok: false, error: 'push failed', stderr: push.stderr, stdout: push.stdout });
                  }
                  const gh = await coderExec('command -v gh >/dev/null 2>&1 && echo yes || echo no', undefined, 10000, cuDir, false, signal, cuDir);
                  if ((gh.stdout || '').trim() === 'yes') {
                    let cmd = `gh pr create --title ${q(String(args.title ?? ''))} --body ${q(String(args.body ?? ''))}`;
                    if (base) cmd += ` --base ${q(base)}`;
                    const pr = await coderExec(cmd, undefined, 60000, cuDir, false, signal, cuDir);
                    const url = (pr.stdout || '').match(/https?:\/\/\S+/)?.[0] || '';
                    return JSON.stringify({ ok: pr.exitCode === 0, url, stdout: pr.stdout, stderr: pr.stderr });
                  }
                  const urlOut = await coderExec(`git remote get-url ${q(remote)}`, undefined, 10000, cuDir, false, signal, cuDir);
                  const compare = gitRemoteToWeb((urlOut.stdout || '').trim(), base, branch);
                  return JSON.stringify({ ok: true, pushed: true, remote, branch, base, compareUrl: compare, note: 'gh CLI not found — open the PR manually at the compare URL (or install gh).' });
                },
                ask_user: async (args) => {
                  return JSON.stringify({ question: args.question, status: 'awaiting_user' });
                },
                todo_write: async (args) => {
                  const todos = Array.isArray(args.todos) ? args.todos as Array<{ content: string; status: string }> : [];
                  cuTodosRef.current = todos;
                  return JSON.stringify({ ok: true, count: todos.length });
                },
                obs_recall: async (args) => {
                  return JSON.stringify(await readRecallChunk(String(args.id ?? ''), Number(args.offset) || 0));
                },
                // Fallback for when the dedicated Agent Mode / Memory toggle
                // below isn't the one providing this tool (see the schema
                // dedup note above) — same underlying implementation either
                // way, just gated by computerUsePerms instead of
                // browserTier/memoryToolTier.
                browser: async (args, signal) => {
                  const detail = String(args.action ?? 'status');
                  const err = await cuCheck('browser', args, detail);
                  if (err) return JSON.stringify({ error: err });
                  const r = await coderBrowser(
                    detail,
                    { url: args.url, selector: args.selector, value: args.value, key: args.key, expression: args.expression, wait_until: args.wait_until, timeout: args.timeout } as Record<string, string | number>,
                    signal,
                  );
                  return JSON.stringify(r);
                },
                memory_update: async (args, signal) => {
                  const text = String(args.text || '').trim();
                  const rawKind = String(args.kind || 'tip');
                  const kind: CoderLearningKind = rawKind === 'success' || rawKind === 'avoid' ? rawKind : 'tip';
                  if (!text) return JSON.stringify({ error: 'memory_update requires non-empty `text`.' });
                  const err = await cuCheck('memory_update', args, text);
                  if (err) return JSON.stringify({ error: err });
                  const m = await chatMemoryAddLearning({ text, kind, provenance: 'tool' }, signal);
                  adoptMemory(m);
                  return JSON.stringify({ ok: true, kind, learnings: m.learnings.length });
                },
                memory_recall: async (args) => {
                  const query = String(args.query ?? '').trim().toLowerCase();
                  if (!query) return JSON.stringify({ error: 'memory_recall requires a non-empty `query`.' });
                  const err = await cuCheck('memory_recall', args, query);
                  if (err) return JSON.stringify({ error: err });
                  const kind = typeof args.kind === 'string' ? args.kind : undefined;
                  const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 30) : 10;
                  try {
                    const m = await chatMemoryGet();
                    const matches = m.learnings
                      .filter((l) => (!kind || l.kind === kind) && (l.text.toLowerCase().includes(query) || (l.task ?? '').toLowerCase().includes(query)))
                      .slice(-limit)
                      .reverse();
                    return JSON.stringify({ matches, total: matches.length });
                  } catch (e) {
                    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
                  }
                },
              };
              // A subagent's own tool loop: no streaming, no chat capability
              // blocks, no memory injection — just the task and a bounded
              // step budget. `registryFor`/`toolNames` decide how much of
              // cuRegistry it can see; delegate/subagent are never included
              // (they aren't in cuRegistry to begin with), so recursion is
              // ruled out by construction rather than a depth counter.
              const runNested = async (task: string, registryFor: ToolRegistry, toolNames: string[], maxSteps: number, model: string, roleHint: string, signal: AbortSignal): Promise<string> => {
                const toolsFor = COMPUTER_USE_TOOLS.filter((t) => toolNames.includes(t.function.name));
                try {
                  const res = await runToolLoop({
                    model,
                    system: `You are a focused subagent working in the directory ${computerUseDirRef.current}. ${roleHint}\n\nTask: ${task}\n\nWhen finished, reply with a concise final summary — you cannot ask the user anything.`,
                    messages: [{ role: 'user', content: task }],
                    params,
                    tools: toolsFor,
                    registry: registryFor,
                    maxSteps,
                    signal,
                  });
                  if (signal.aborted || res.stop === 'aborted') return '(subagent aborted)';
                  if (res.stop === 'steps') return '(subagent step budget reached)';
                  const last = [...res.messages].reverse().find((m) => m.role === 'assistant');
                  return last?.content.trim() || '(no findings)';
                } catch (e) {
                  return `(subagent failed: ${e instanceof Error ? e.message : String(e)})`;
                }
              };
              const readOnlyNames = ['read', 'grep', 'glob', 'ast_grep', 'repo_search', 'git_diff', 'web_fetch', 'web_search', 'browser'];
              const nestedReadOnlyRegistry: ToolRegistry = {
                web_fetch: webFetchHandler,
                web_search: webSearchHandler,
                read: cuRegistry.read, grep: cuRegistry.grep, glob: cuRegistry.glob,
                ast_grep: cuRegistry.ast_grep, repo_search: cuRegistry.repo_search,
                git_diff: cuRegistry.git_diff, browser: cuRegistry.browser,
              };
              return {
                ...cuRegistry,
                delegate: async (args, signal) => {
                  const task = String(args.task ?? '');
                  const err = await cuCheck('delegate', args, task.slice(0, 60));
                  if (err) return JSON.stringify({ error: err });
                  const names = filterToolAllowList(args.tools, new Set(readOnlyNames)) ?? readOnlyNames;
                  const summary = await runNested(task, nestedReadOnlyRegistry, names, 6, useModel, 'You are a read-only investigator — do not write files or run mutating commands.', signal);
                  return JSON.stringify({ summary });
                },
                subagent: async (args, signal) => {
                  const task = String(args.task ?? '');
                  const err = await cuCheck('subagent', args, task.slice(0, 60));
                  if (err) return JSON.stringify({ error: err });
                  const cuNames = Object.keys(cuRegistry);
                  const names = filterToolAllowList(args.tools, new Set(cuNames)) ?? cuNames;
                  const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : useModel;
                  const summary = await runNested(task, cuRegistry, names, 20, model, 'You can read, write, and edit files and run shell commands to complete the task.', signal);
                  return JSON.stringify({ summary });
                },
              } satisfies ToolRegistry;
            })()
          : {}),
        ...(agentResearch
          ? {
              browser: async (args, signal) => {
                if (browserTier === 'deny') {
                  return JSON.stringify({ error: 'Denied by Agent Mode settings (browser is set to deny).' });
                }
                if (browserTier === 'ask' && !(await requestApproval('browser', String(args.action ?? 'status')))) {
                  return JSON.stringify({ error: 'Denied by the user (browser). Ask for an alternative or proceed without it.' });
                }
                const r = await coderBrowser(
                  String(args.action ?? 'status'),
                  { url: args.url, selector: args.selector, value: args.value, key: args.key, expression: args.expression, wait_until: args.wait_until, timeout: args.timeout } as Record<string, string | number>,
                  signal,
                );
                return JSON.stringify(r);
              },
            }
          : {}),
        ...(memoryEnabled
          ? {
              memory_update: async (args, signal) => {
                const text = String(args.text || '').trim();
                const rawKind = String(args.kind || 'tip');
                const kind: CoderLearningKind = rawKind === 'success' || rawKind === 'avoid' ? rawKind : 'tip';
                if (!text) return JSON.stringify({ error: 'memory_update requires non-empty `text`.' });
                if (memoryToolTier === 'deny') {
                  return JSON.stringify({ error: 'Denied by Agent Mode settings (memory_update is set to deny).' });
                }
                if (memoryToolTier === 'ask' && !(await requestApproval('memory_update', text))) {
                  return JSON.stringify({ error: 'Denied by the user (memory_update). Ask for an alternative or proceed without it.' });
                }
                const m = await chatMemoryAddLearning({ text, kind, provenance: 'tool' }, signal);
                adoptMemory(m);
                return JSON.stringify({ ok: true, kind, learnings: m.learnings.length });
              },
            }
          : {}),
        // MCP tools — Computer Use gated like every other mutating tool
        // (their schemas land in `tools` only when it's on, below).
        ...(computerUseOn
          ? Object.fromEntries(
              mcpToolsRef.current
                .filter((t) => mcpToolTier(computerUsePerms, t.name) !== 'deny')
                .map((t) => [t.name, mcpToolHandler(t.name)] as const)
            )
          : {}),
      };
      // De-duplicated by name, first entry wins — agentResearch/memoryEnabled
      // come before Computer Use so their dedicated schema (and, per the
      // mirrored registry spread order above, their dedicated handler) is
      // what the model actually gets when both are on.
      const tools = dedupeTools([
        ...CHAT_TOOLS,
        ...(agentResearch ? [CHAT_BROWSER_TOOL] : []),
        ...(memoryEnabled ? [CHAT_MEMORY_TOOL] : []),
        ...(computerUseOn ? COMPUTER_USE_TOOLS : []),
        // MCP tools ride on Computer Use — they're external, potentially
        // mutating actions, so they never ship without its permission gate.
        ...(computerUseOn
          ? mcpToolsRef.current
              .filter((t) => mcpToolTier(computerUsePerms, t.name) !== 'deny')
              .map(mcpToolSchema)
          : []),
      ]);
      // The runner owns the turn messages; these events mirror each turn into
      // the conversation store so streaming stays live.
      let lastTurnMeta: MessageMeta | undefined;
      const res = await runToolLoop({
        model: useModel,
        system: chatSystemWithCapabilities(params, memoryEnabled ? memoryRef.current : undefined, computerUseEnabled ? computerUseDirRef.current : undefined, tools.map((t) => t.function.name)),
        messages: effectiveHistory,
        params,
        tools,
        registry,
        maxSteps: 12,
        signal: ac.signal,
        // Route through the engine's /v1/responses transport when it's
        // available AND this turn's sampling params are fully expressible
        // there (see responses.ts) — never silently drop a knob the user
        // set (top_k/min_p/penalties/seed aren't accepted on that endpoint
        // on this engine build). Falls back to the proven Chat Completions
        // path (streamTurn's own default) otherwise.
        stream: knownResponsesSupport() && paramsSupportedByResponses(params) ? streamResponses : undefined,
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
          // Both passes below only apply to the final content-only turn (no
          // pending tool calls) — an intermediate tool-call turn is left
          // untouched either way.
          if (ac.signal.aborted || (msg.tool_calls?.length ?? 0) > 0 || !msg.content.trim()) return;

          let content = msg.content;

          // Reflection: Generate → Reflect → Refine, bounded to one
          // regenerate (never a loop). Best-effort — any failure at either
          // step keeps the original reply and never strands the turn.
          if (reflectionEnabled) {
            setNotice({ tone: 'ok', text: 'Reflection: reviewing reply…' });
            try {
              const critique = await critiqueChatReply({ model: reflectionModel.trim() || useModel, history, reply: content, maxTokens: reflectionCritiqueMaxTokens, signal: ac.signal });
              if (critique && !ac.signal.aborted) {
                setNotice({ tone: 'ok', text: 'Reflection: revising reply…' });
                const revised = await regenerateChatReply({
                  model: useModel,
                  system: chatSystemWithCapabilities(params, memoryEnabled ? memoryRef.current : undefined, computerUseEnabled ? computerUseDirRef.current : undefined, tools.map((t) => t.function.name)),
                  history,
                  originalReply: content,
                  critique,
                  params,
                  signal: ac.signal,
                });
                if (revised && !ac.signal.aborted) content = revised;
              }
            } catch (reflectionError) {
              console.warn('[chat] reflection pass skipped (critique/regenerate failed)', reflectionError);
            } finally {
              if (!ac.signal.aborted) setNotice(null);
            }
          }

          // Not-Ai auto-rewrite: plain content replies run the deterministic
          // tell-gate (best-effort — any failure keeps the reply so far and
          // never strands the streaming state).
          if (!params.humanize) return content !== msg.content ? { content } : undefined;
          try {
            const humanized = await humanizePassText(content, {
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
            if (!ac.signal.aborted && humanized.trim() !== content.trim()) return { content: humanized };
          } catch (humanizeError) {
            console.warn('[chat] humanize pass skipped (gate/rewrite failed)', humanizeError);
          }
          return content !== msg.content ? { content } : undefined;
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
      // Auto-drain: if this turn finished naturally (not a user Stop) and the
      // user queued a message for this conversation while it was streaming,
      // send it next — that's the whole point of queuing instead of blocking.
      if (!ac.signal.aborted) {
        const pending = queuedRef.current[convId];
        if (pending && pending.length > 0) {
          const [item, ...rest] = pending;
          setQueued((q) => ({ ...q, [convId]: rest }));
          const queuedConv = convsRef.current.find((c) => c.id === convId);
          if (queuedConv) {
            const userMsg: ChatMessage = { role: 'user', content: item.text, attachments: item.attachments.length ? item.attachments : undefined };
            const asstMsg: ChatMessage = { role: 'assistant', content: '', id: uid(), model: useModel, meta: {} };
            const nextBase: Conversation = { ...queuedConv, messages: [...queuedConv.messages, userMsg, asstMsg] };
            setConvs((cs) => cs.map((c) => (c.id === convId ? nextBase : c)));
            await runStream(convId, modelHistory(nextBase), 0, asstMsg.id);
          }
        }
      }
    },
    [engineUp, model, runningModel, params, onNavigate, status, agentResearch, memoryEnabled, adoptMemory, reflectionEnabled, deepResearchEnabled, reflectionModel, browserTier, memoryToolTier, requestApproval, deepResearchMaxAngles, deepResearchMaxSteps, reflectionCritiqueMaxTokens, computerUseEnabled, computerUsePerms],
  );

  const send = useCallback(async () => {
    const content = text.trim();
    if (!content && !attachments.length) return;
    if (content.startsWith('/') && runCommand(content)) {
      setText('');
      setAttachments([]);
      return;
    }
    // Busy on THIS conversation (streaming or compacting) — queue instead of
    // blocking; it auto-sends once the current turn finishes. A different
    // conversation streaming elsewhere is handled by the composer's own
    // disabled state (this function is simply not reachable then).
    if (activeId && ((streaming && streamingConvId === activeId) || compacting)) {
      const item: QueuedItem = { text: content, attachments: [...attachments] };
      setQueued((q) => ({ ...q, [activeId]: [...(q[activeId] ?? []), item] }));
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
  }, [text, attachments, engineUp, model, runningModel, convs, activeId, params, onNavigate, runStream, streaming, streamingConvId, compacting]);

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
                  // Busy-elsewhere is the one case send() can't handle itself
                  // (there's nothing sensible to queue against a conversation
                  // that isn't even the one on screen streaming).
                  if (!(streamingConvId && streamingConvId !== activeId)) send();
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
                <>
                  <Button variant="ghost" size="sm" onClick={send} disabled={!text.trim() && !attachments.length} title="Queue this for when the current turn finishes">
                    <Plus size={12} /> queue
                  </Button>
                  <Button variant="danger" size="sm" onClick={stop}>
                    <Square size={12} /> {compacting ? 'stop compact' : 'stop'}
                  </Button>
                </>
              ) : (
                <Button variant="primary" size="sm" onClick={send} disabled={(!text.trim() && !attachments.length) || !engineUp}>
                  <Send size={13} /> send
                </Button>
              )}
            </div>
            {activeId && (queued[activeId]?.length ?? 0) > 0 && (
              <div className="space-y-1 px-2.5 pb-2">
                {queued[activeId].map((item, i) => (
                  <div key={i} className="flex items-center gap-2 rounded border border-line bg-inset px-2 py-1 text-[11.5px] text-mute">
                    <span className="shrink-0 font-mono text-[10px] text-faint">#{i + 1} queued</span>
                    <span className="min-w-0 flex-1 truncate">{item.text}</span>
                    <button
                      type="button"
                      title="Remove from queue"
                      onClick={() => setQueued((q) => ({ ...q, [activeId]: q[activeId].filter((_, j) => j !== i) }))}
                      className="shrink-0 rounded p-0.5 text-faint hover:bg-panel hover:text-danger"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
          {pendingApproval && (
            <HitlDialog
              tone="warn"
              width={480}
              icon={<Shield size={15} />}
              title="Agent requests approval"
              subtitle={<span><span className="font-mono text-accent">{pendingApproval.name}</span> is set to <span className="font-mono">ask</span> in Agent Mode settings.</span>}
              footer={
                <>
                  <Button variant="ghost" size="sm" onClick={() => approvalResolveRef.current?.(false)}>
                    Deny
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => approvalResolveRef.current?.(true)}>
                    Approve once
                  </Button>
                </>
              }
            >
              <pre className="m-0 whitespace-pre-wrap break-all font-mono text-[12px] text-ink">{pendingApproval.detail || '(no details)'}</pre>
            </HitlDialog>
          )}
          </>
      </div>
    </div>
  );
}

// ChatScreen only reads status.engine/status.engines — never gpu/vram/downloads/etc,
// which tick on every 2.5s status poll while the engine is running. Without this,
// the heaviest screen (full history, streaming, message rendering) re-renders on
// every GPU utilization blip regardless of what the user is doing.
function sameRelevantStatus(a: StatusPayload | null, b: StatusPayload | null): boolean {
  if (a === b) return true;
  return JSON.stringify(a?.engine) === JSON.stringify(b?.engine) && JSON.stringify(a?.engines) === JSON.stringify(b?.engines);
}

export const ChatScreen = memo(
  ChatScreenImpl,
  (prev, next) => prev.onNavigate === next.onNavigate && sameRelevantStatus(prev.status, next.status),
);
