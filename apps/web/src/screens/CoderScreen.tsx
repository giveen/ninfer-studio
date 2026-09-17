import React, { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import { Play, Square, X, BrainCircuit, Terminal, CheckSquare, Plus, Folder, ChevronRight, ChevronDown, ChevronLeft, FolderPlus, Pencil, Archive, Trash2, RotateCcw, File, Paperclip, Image, GitCommit, GitBranch, RefreshCw, Shield, HelpCircle, Undo2, SlidersHorizontal, GitFork, Download, BookmarkPlus, MessageSquare, Activity } from 'lucide-react';
import { CoderWorkspace, AgentToolCall, ChatMessage, ChatParams, ChatAttachment, FileNode } from '../lib/types';
import { Button, CodeBlock, NumberField, Toggle, SelectField, cn } from '../components/ui';
import { loadStore, baseName, relTime, CoderStore, ConvMeta, LogEntry, TodoItem, newConvId, emptyConv, WsData, loadDefaultPerms, detectCommands, todoSystemBlock, CONV_KEY, saveStoreDebounced } from '../lib/coderStore';

import { DirBrowser } from '../components/DirBrowser';
// Dynamically imported: react-markdown + remark-gfm + highlight.js is a
// ~300KB chunk that costs nothing at startup this way, only when the first
// completed reply actually needs to render (see ChatScreen.tsx, which shares
// this same lazy module — both must use dynamic import or Rollup folds the
// chunk back into the eager bundle for both).
const Markdown = lazy(() => import('../components/Markdown'));
import { DiffReviewModal } from '../components/DiffReviewModal';
import { FilePickerModal } from '../components/coder/FilePickerModal';
import { useCoderMemory } from '../components/coder/useCoderMemory';
import { useCoderJobs } from '../components/coder/useCoderJobs';
import { JobsPanel } from '../components/coder/JobsPanel';
import { RunsPanel } from '../components/coder/RunsPanel';
import { useCoderGit } from '../components/coder/useCoderGit';
import { CommitsPanel } from '../components/coder/CommitsPanel';
import { useConversationHandlers } from '../components/coder/useCoderConversations';
import { MemoryModal } from '../components/MemoryModal';
import { HitlDialog } from '../components/HitlDialog';
import { isImagePath } from '../lib/fileKind';
import { parseDiagnostics } from '../lib/diagnostics';
import { fetchFileDiff, GIT_BRANCH_LIST_CMD, parseBranchList } from '../lib/gitStatus';
import { useFileTabs, GIT_BADGE_CLASS } from '../components/editor/tabModel';
import { coderTree, coderRepoMap, coderRead, coderReadBase64, coderWrite, coderEdit, coderPatch, coderExec, coderJob, coderGrep, coderGlob, coderSearch, coderWebFetch, coderWebSearch, coderBrowser, streamChat, buildChatRequest, getConfig, setCoderWorkspace, getStatus, getEngineContextSize, summarizeConversation, frameCompactedSummary, coderPermsSet, coderPermsApprove, coderDiff, coderMemoryAddLearning, coderMemoryDropLearning, summarizeOutputVerified, renderOutputReceipt, formatSummarizedOutput, suggestFollowUps, mcpToolsGet, mcpCall, type McpToolInfo, type CoderDiffResult, type CoderLearningKind, type CoderLearning, type ChatStreamCallbacks } from '../lib/api';
import { useCoderSafety } from '../lib/coderSafety';
import { NOT_AI_CONTRACT, voiceSnippet, effectiveVoice, humanizeRewriteText, VOICE_PROFILES, type VoiceProfile } from '../lib/notai';
import { resolveProviderConfig } from '../lib/chatHelpers';
import { coderLensBlock, CODING_LENSES, LINUS_LENS } from '../lib/coderLens';
import { formatTokens, CHARS_PER_TOKEN } from '../lib/format';
import { openExternalLink } from '../lib/externalLink';
import { packForRequest, readRecallChunk, extractToolResultText, applyResultPlaceholder, LARGE_OUTPUT_EXCLUDED_TOOLS } from '../lib/observationPack';
import { compactedContext, isCompactedMsg, humanizePassText, streamTurn, type ToolHandler, type ToolRegistry, type TurnResult } from '../lib/agentLoop';
import { agentRunsApi, RunStream } from '../lib/agentRuns';
import { redactSecrets, ReportBlock, TrajectoryBlock } from '../components/toolResults';
import { TOOLS, DEFAULT_PERMS, MUTATING_TOOLS, DEFAULT_MAX_AGENT_STEPS, READONLY_TOOL_NAMES, WORKER_TOOL_NAMES, filterToolAllowList, filterToolsByConfig, isReadOnlyCommand, mcpToolTier, mcpToolSchema, mcpServerKey, splitMcpName, MCP_NAME_PREFIX, type PermTier, type PermConfig } from '../lib/coderTools';
import { CODER_SYSTEM, WORKER_SYSTEM, CRITIC_SYSTEM } from '../lib/coderPrompts';
import { SidebarSection, CoderSidebar } from '../components/coder/CoderSidebar';
import { CheckpointsPanel } from '../components/coder/CheckpointsPanel';
import { useCoderCheckpoints } from '../hooks/useCoderCheckpoints';
import { useCoderToolHandlers, isGitCommitCommand } from '../hooks/useCoderToolHandlers';
import { useCoderFileTree } from '../hooks/useCoderFileTree';
import { useCoderUndo } from '../hooks/useCoderUndo';
import { useCoderBranchManager } from '../hooks/useCoderBranchManager';
import { CoderHeader } from '../components/coder/CoderHeader';
import { CoderTranscriptView } from '../components/coder/CoderTranscriptView';
import { CoderComposer } from '../components/coder/CoderComposer';
import { CoderWorkspaceTabs } from '../components/coder/CoderWorkspaceTabs';
import { CoderTodoSidebar } from '../components/coder/CoderTodoSidebar';
import { CoderModals } from '../components/coder/CoderModals';
import { useCoderToolDispatcher } from '../hooks/useCoderToolDispatcher';
import { useCoderAgentLoop } from '../hooks/useCoderAgentLoop';
import { useCoderSubagents } from '../hooks/useCoderSubagents';



const ATTACH_MAX_BYTES = 50 * 1024 * 1024;
const LazyEditorPane = lazy(() => import('../components/editor/EditorPane'));

export function CoderScreen({ coderWs }: { coderWs: string }) {
  const [store, setStore] = useState<CoderStore>(loadStore);
  const storeRef = useRef(store);
  storeRef.current = store;

  const activeWs = store.activeWs;
  const activeConv = store.activeConv;
  const activeMeta = store.workspaces[activeWs]?.conversations[activeConv];
  /** Effective workspace directory: worktree if set, otherwise the main workspace root. */
  const activeWsDir = activeMeta?.worktree
    ? `${activeWs}/${activeMeta.worktree}`.replace(/\\/g, '/').replace(/\/+/g, '/')
    : activeWs;

  const initialMeta = activeMeta;
  const [messages, setMessages] = useState<ChatMessage[]>(initialMeta?.messages ?? []);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [appConfig, setAppConfig] = useState<Awaited<ReturnType<typeof getConfig>> | null>(null);
  const appConfigRef = useRef(appConfig);
  appConfigRef.current = appConfig;
  useEffect(() => {
    let timer: number | null = null;
    const fetchCfg = () => {
      getConfig()
        .then(setAppConfig)
        .catch(() => {
          timer = window.setTimeout(fetchCfg, 5000);
        });
    };
    fetchCfg();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  // When the agent pauses via ask_user, this holds the question and the run halts
  // until the user answers (release blocker #5 — human-in-the-loop).
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const askRef = useRef<string | null>(null);
  const [ledger, setLedger] = useState<LogEntry[]>(initialMeta?.ledger ?? []);
  const [todos, setTodos] = useState<TodoItem[]>(initialMeta?.todos ?? []);
  /** When the task list last changed (tool call or user edit) — shown in the
   *  panel header. Per conversation (ConvMeta.todosUpdatedAt), so switching
   *  conversations can't leak another conversation's time into the header. */
  const [todosUpdatedAt, setTodosUpdatedAt] = useState<number | null>(initialMeta?.todosUpdatedAt ?? null);
  /** Mirror of `todos` for the run loop: the loop's closure sees stale state,
   *  so the per-turn system-prompt injection reads this ref instead. Kept in
   *  sync synchronously (applyTodos) — a useEffect sync alone lands one tick
   *  late, and handleToolCalls → runAgent can build the next request before
   *  effects run, which would send the previous list to the LLM. */
  const todosRef = useRef<TodoItem[]>(todos);
  useEffect(() => { todosRef.current = todos; }, [todos]);
  /** Bumped on every user edit of the list (add / cycle / remove / restore)
   *  — lets an in-flight todo_write tell its snapshot was generated from a
   *  stale list. */
  const todosRevRef = useRef(0);
  /** The revision captured when the current LLM request was built — its
   *  system prompt carried the list as of that moment. */
  const todosRevAtReqStartRef = useRef(0);
  /** Apply a new task list in the same tick: run-loop ref + state (+ optional
   *  header timestamp). */
  const applyTodos = (next: TodoItem[], ts?: number | null) => {
    todosRef.current = next;
    setTodos(next);
    if (ts !== undefined) setTodosUpdatedAt(ts);
  };
  /** User-side mutation: functional edit + revision bump + timestamp, all
   *  synchronous, so the next LLM call (even before a re-render) sees it. */
  const mutateTodos = (fn: (prev: TodoItem[]) => TodoItem[]) => {
    const next = fn(todosRef.current);
    todosRevRef.current += 1;
    todosRef.current = next;
    setTodos(next);
    setTodosUpdatedAt(Date.now());
  };
  /** Briefly highlights the todos panel so a freshly-created list (empty →
   *  populated) catches the eye instead of silently appearing in the sidebar. */
  const [todosJustCreated, setTodosJustCreated] = useState(false);
  const flashTimerRef = useRef<number | null>(null);
  const flashTodosCreated = () => {
    setTodosJustCreated(false);
    requestAnimationFrame(() => setTodosJustCreated(true));
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      setTodosJustCreated(false);
      flashTimerRef.current = null;
    }, 1800);
  };
  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    };
  }, []);
  const [todoDraft, setTodoDraft] = useState('');
  const [wsBusy, setWsBusy] = useState(false);
  // Re-pointed control-plane workspace + flush counter (see the workspace effect below);
  // declared early because the panel-reload effects depend on wsFlushed.
  const wsAppliedDirRef = useRef<string | null>(null);
  const [wsFlushed, setWsFlushed] = useState(0);
  // Serialized re-point queue (see the workspace effect below): a run awaits
  // this before its first control-plane tool call.
  const wsApplyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [showDir, setShowDir] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  /** Messages typed while a run is in flight, per conversation (keyed by
   *  convId) — in-memory only, like the composer draft itself, not persisted
   *  into the conversation's stored messages. Auto-sent one at a time as soon
   *  as that conversation's run finishes; a manual Stop does NOT auto-drain
   *  (see `stoppedRef`), so an interrupted run doesn't immediately fire the
   *  next queued prompt behind the user's back.
   *  Ref-mirrored (like runConv/runConvRef) so runAgent's finally block —
   *  running inside a closure captured when the run STARTED — sees items
   *  queued after that, not a stale empty snapshot. */
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
  /** Set by `stop()`, read (and reset) once the aborted run's `finally` runs. */
  const stoppedRef = useRef(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerNodes, setPickerNodes] = useState<FileNode[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerExpanded, setPickerExpanded] = useState<Record<string, boolean>>({});
  const [pickerSelected, setPickerSelected] = useState<Record<string, boolean>>({});
  // Conversation rename/archived-collapse UI state lives in useConversationHandlers.

  // File Tree panel — browse the workspace and pin files/folders so the system
  // prompt "follows" them (system-prompt follow binding).
  const [treeOpen, setTreeOpen] = useState(true);

  // Commit history of the active workspace (state + fetch live in useCoderGit).
  // Sampling params for the coder runs (persisted globally, not per workspace).
  interface CoderParams { thinking: boolean; thinkLevel?: 'low' | 'medium' | 'high' | 'xhigh'; temperature?: number; topP?: number; topK?: number; seed?: number; criticModel?: string; promptCache?: boolean; humanize?: boolean; voiceProfile?: string; reviewLens?: string; maxAgentSteps?: number; compactAt?: number; primaryProvider?: 'ninfer' | 'cloud'; primaryCloudModel?: string; subagentProvider?: 'ninfer' | 'cloud'; subagentCloudModel?: string; }
  const CODER_PARAMS_KEY = 'ninfier.coder.params';
  const DEFAULT_CODER_PARAMS: CoderParams = { thinking: true };
  const [coderParams, setCoderParams] = useState<CoderParams>(() => {
    try {
      const raw = localStorage.getItem(CODER_PARAMS_KEY);
      if (raw) return { ...DEFAULT_CODER_PARAMS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULT_CODER_PARAMS };
  });
  // Mirror of coderParams for closures with empty deps (e.g. refreshRepoMap) so
  // they read the latest humanize/voice setting without being recreated.
  const coderParamsRef = useRef(coderParams);
  coderParamsRef.current = coderParams;
  const [showCoderParams, setShowCoderParams] = useState(false);
  // Live LLM phase indicator: 'prefill' = request sent, no tokens back yet
  // (the long silent stretch on big contexts); 'decode' = tokens streaming.
  const [llmPhase, setLlmPhase] = useState<{ stage: 'prefill' | 'decode'; label: string; since: number; chars: number } | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!llmPhase) return;
    const t = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(t);
  }, [!!llmPhase]);
  // Commit panel collapse state lives in useCoderGit.

  /** streamChat wrapper that drives the prefill/decode phase indicator. */
  const trackedStream = async (
    req: Record<string, unknown>,
    signal: AbortSignal,
    label: string,
    cb: ChatStreamCallbacks,
    opts?: { baseUrl?: string; apiKey?: string; extraHeaders?: string; allowFallback?: boolean }
  ) => {
    setLlmPhase({ stage: 'prefill', label, since: Date.now(), chars: 0 });
    try {
      return await streamChat(req, signal, {
        ...cb,
        onContentDelta: (t) => {
          setLlmPhase((p) => (p ? { ...p, stage: 'decode', chars: p.chars + t.length } : p));
          cb.onContentDelta?.(t);
        },
        onReasoningDelta: (t) => {
          setLlmPhase((p) => (p ? { ...p, stage: 'decode', chars: p.chars + t.length } : p));
          cb.onReasoningDelta?.(t);
        },
        onDone: (m) => {
          setLlmPhase(null);
          cb.onDone?.(m);
        },
        // A request-level failure (e.g. the engine 400s a param it doesn't
        // support) resolves streamChat via this callback, not onDone or a
        // throw — without clearing the phase here too, the "reading context"
        // banner is left stuck ticking forever even though the turn is
        // already over (the run itself does stop; only this indicator doesn't).
        onError: (msg) => {
          setLlmPhase(null);
          cb.onError?.(msg);
        },
      }, opts);
    } catch (e) {
      setLlmPhase(null);
      throw e;
    }
  };
  // Expanded-commit + loading state live in useCoderGit.
  // Background jobs + live subagents (state + polling live in the hook;
  // the call sits after addLog, which the kill-error path reports through).

  // Safe Mode / Sandbox / Commit Approval now live in Settings > Safety &
  // Permissions (shared, backend-backed state via CoderSafetyProvider so
  // this screen and Settings never go stale relative to each other — see
  // lib/coderSafety.tsx). Commit approval gate: when ON, the agent may not
  // commit without an explicit human sign-off on the working-tree-vs-HEAD
  // diff; auto-commits on write/edit are suppressed so the only commits are
  // intentional, reviewed ones.
  const { safeMode: coderSafeMode, commitApproval } = useCoderSafety();
  // Diff-review viewer (opened from the toolbar "Diff" button).
  const [diffViewOpen, setDiffViewOpen] = useState(false);
  /** Per-file diff (opened from a file tab's Diff button). */
  const [fileDiffPath, setFileDiffPath] = useState<string | null>(null);
  // Commit-approval pending dialog (the agent asked to commit while the gate is ON).
  const [commitReviewOpen, setCommitReviewOpen] = useState(false);
  /** True when the pending commit-approval request came from a worker
   *  subagent's own `bash` call, not the supervisor — shown as a note on
   *  the dialog so the human knows who's asking. */
  const [commitApprovalFromSubagent, setCommitApprovalFromSubagent] = useState(false);
  const commitResolveRef = useRef<((ok: boolean) => void) | null>(null);
  /** Pause the agent loop and show the diff for human sign-off. Resolves true=approve. */
  const requestCommitApproval = (fromSubagent = false): Promise<boolean> => {
    setCommitApprovalFromSubagent(fromSubagent);
    setCommitReviewOpen(true);
    return new Promise<boolean>((resolve) => {
      commitResolveRef.current = (ok: boolean) => {
        commitResolveRef.current = null;
        setCommitReviewOpen(false);
        resolve(ok);
      };
    });
  };
  // Plan mode: read-only agent (no mutating tools), toggled per run.
  const [planMode, setPlanMode] = useState(false);
  // Read-only scout pre-pass (auto, concurrency-gated — see runAgent). Opt-in:
  // no harness mode runs unless the user turns it on.
  const [scoutOn, setScoutOn] = useState(false);
  const [verifyMode, setVerifyMode] = useState(false);
  // Critic gate: after edits, a (possibly different) model reviews the working-tree
  // diff and can bounce it back for fixes before the run is allowed to finish.
  const [criticMode, setCriticMode] = useState(false);
  // A tool call awaiting the user's approve/deny decision (permission tier `ask`).
  const [pendingApproval, setPendingApproval] = useState<{ name: string; detail: string } | null>(null);
  const approvalResolveRef = useRef<((ok: boolean) => void) | null>(null);
  // Optional free-form note the human can attach to an ask_user decision.
  const [askNote, setAskNote] = useState('');
  // Cached AGENTS.md conventions for the active workspace (refreshed by refreshRepoMap).
  const conventionsRef = useRef<string>('');

  // Workspace-switch synchronization for the Tree panel: it fetches RELATIVE
  // to the control plane's *configured* workspace, which setCoderWorkspace()
  // re-points asynchronously. A response that lands before the switch is
  // confirmed belongs to the PREVIOUS workspace — so the tree applies a
  // response only if (a) it is the newest fetch (treeSeqRef) and (b) the
  // control was confirmed at that workspace by then (wsAppliedDirRef.current,
  // set in the setCoderWorkspace success handler below, which also bumps
  // wsFlushed to trigger the confirmed reload). The memory panel applies the
  // same guard inside useCoderMemory.
  const treeSeqRef = useRef(0);

  // Self-improving memory panel (state + guarded fetch live in the hook).
  const { memory, memoryRef, memOpen, setMemOpen, loadMemory, adoptMemory } = useCoderMemory({
    activeWsDir,
    wsFlushed,
    appliedDirRef: wsAppliedDirRef,
  });

  // Refresh the self-improving memory whenever the active workspace changes —
  // and again once the control is confirmed at it (wsFlushed). The effect
  // lives in useCoderMemory; this call site only needs the loader.

  // The conversation an in-flight run is pinned to. Set at run start so that
  // switching conversations/workspaces mid-run is a pure VIEW change: the run
  // keeps appending to ITS conversation (in the store), and the visible
  // transcript only mirrors the update while that conversation is on screen.
  // Without this, a mid-run switch would write the live transcript into the
  // conversation the user switched to — the corruption P0 #2 guarded against.
  const runConvRef = useRef<{ ws: string; convId: string } | null>(null);
  // State mirror of the ref for the UI (drives the "running" marker below).
  const [runConv, setRunConvState] = useState<{ ws: string; convId: string } | null>(null);
  /** Pin/unpin the in-flight run's transcript target. */
  const setRunConv = (pin: { ws: string; convId: string } | null) => {
    runConvRef.current = pin;
    setRunConvState(pin);
  };
  // Where a paused run (ask_user) was pinned, so the answer resumes the right
  // conversation even if the user has since switched elsewhere.
  const askConvRef = useRef<{ ws: string; convId: string } | null>(null);

  const lastPromptTokensRef = useRef<number>(initialMeta?.lastPromptTokens ?? 0);
  // The IN-FLIGHT RUN's token accounting, pinned separately from the visible
  // meter (lastPromptTokensRef): switching to another conversation mid-run
  // overwrites the meter with that conversation's count, which must not feed
  // the run's compaction threshold. The meter only mirrors the run's count
  // while the run's conversation is on screen.
  const runTokensRef = useRef<number>(initialMeta?.lastPromptTokens ?? 0);
  /** Record the run's prompt-token count; mirrors to the visible meter only while the run's conversation is on screen. */
  const noteRunTokens = (t: number) => {
    runTokensRef.current = t;
    const pin = runConvRef.current;
    if (pin && pin.ws === storeRef.current.activeWs && pin.convId === storeRef.current.activeConv) {
      lastPromptTokensRef.current = t;
    }
  };
  // Visible mirrors of the ref above + the engine context window + the agent
  // step counter, so the header can show live context usage (release #3).
  const [ctxTokens, setCtxTokens] = useState<number>(initialMeta?.lastPromptTokens ?? 0);
  const [ctxLimit, setCtxLimit] = useState<number | null>(null);
  const [agentSteps, setAgentSteps] = useState(0);
  // The ref updates inside stream callbacks (no re-render); mirror it into
  // state whenever the transcript changes so the meter stays live.
  useEffect(() => { setCtxTokens(lastPromptTokensRef.current); }, [messages]);
  // The system prompt (CODER_SYSTEM + humanize/review-lens settings). Kept in
  // a ref for the same reason codebaseContextRef is (see its comment below),
  // but this half rarely changes mid-run, so it stays fit for the system
  // message without threatening cache locality.
  const dynamicSystemRef = useRef<string>(CODER_SYSTEM);
  // Live codebase context (repo map, conventions, detected commands, skills
  // index, followed files) — refreshed mid-run after the agent writes/edits
  // files (P1 #6), same as dynamicSystemRef used to include inline. Kept
  // separate and fed in as a per-turn trailing note (after history) instead
  // of the system prompt: this half changes on nearly every mutating tool
  // call during real coding work, and baking a value that changes almost
  // every turn into the system prefix invalidates the engine's KV-cache
  // reuse for the entire growing history each time — see the trailing-note
  // pattern already used for date/time and todos in useCoderAgentLoop.ts.
  const codebaseContextRef = useRef<string>('');

  /** Load a conversation's live state from the store (always reads the latest). */
  const loadConv = (ws: string, convId: string) => {
    const meta = storeRef.current.workspaces[ws]?.conversations[convId];
    const m = meta ?? emptyConv(convId);
    lastPromptTokensRef.current = m.lastPromptTokens ?? 0;
    const msgs = m.messages ?? [];
    setMessages(msgs);
    setLedger(m.ledger ?? []);
    applyTodos(m.todos ?? [], m.todosUpdatedAt ?? null);
  };

  /** Apply a transcript update to the conversation the in-flight run is pinned
   *  to. Persists to the store even when that conversation is NOT on screen
   *  (so switching back shows the live transcript); mirrors to the visible
   *  transcript only while it is on screen. */
  const updateRunMessages = (fn: (prev: ChatMessage[]) => ChatMessage[]) => {
    const pin = runConvRef.current;
    if (!pin) return;
    setStore((prev) => {
      const wsd = prev.workspaces[pin.ws];
      const meta = wsd?.conversations[pin.convId];
      if (!wsd || !meta) return prev;
      return {
        ...prev,
        workspaces: { ...prev.workspaces, [pin.ws]: { ...wsd, conversations: { ...wsd.conversations, [pin.convId]: { ...meta, messages: fn(meta.messages ?? []), lastPromptTokens: runTokensRef.current, updatedAt: Date.now() } } } },
      };
    });
    if (pin.ws === storeRef.current.activeWs && pin.convId === storeRef.current.activeConv) setMessages(fn);
  };
  /** Same pinning for todo_write: the run's todos stay in the run's conversation. */
  /** `ts` (from #5's todosUpdatedAt): persisted into the run conversation's
   *  meta (so switching back shows the right "last updated"), mirrored to the
   *  header only while that conversation is on screen. */
  const updateRunTodos = (next: TodoItem[], ts?: number) => {
    const pin = runConvRef.current;
    if (!pin) { setTodos(next); if (ts != null) setTodosUpdatedAt(ts); return; }
    setStore((prev) => {
      const wsd = prev.workspaces[pin.ws];
      const meta = wsd?.conversations[pin.convId];
      if (!wsd || !meta) return prev;
      return {
        ...prev,
        workspaces: { ...prev.workspaces, [pin.ws]: { ...wsd, conversations: { ...wsd.conversations, [pin.convId]: { ...meta, todos: next, todosUpdatedAt: ts, updatedAt: Date.now() } } } },
      };
    });
    if (pin.ws === storeRef.current.activeWs && pin.convId === storeRef.current.activeConv) { setTodos(next); if (ts != null) setTodosUpdatedAt(ts); }
  };

  // Persist the active conversation's live state back into the store.
  useEffect(() => {
    if (!activeWs || !activeConv) return;
    // Don't clobber a loaded conversation with a transient empty transcript
    // (e.g. the initial [] before loadConv populates messages) — L1.
    const existing = storeRef.current.workspaces[activeWs]?.conversations[activeConv];
    if (messages.length === 0 && existing && (existing.messages?.length ?? 0) > 0) return;
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      if (!wsd) return prev;
      const meta = wsd.conversations[activeConv];
      const firstUser = messages.find((m) => m.role === 'user' && !isCompactedMsg(m));
      const title = firstUser
        ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 48) || (meta?.title ?? 'New conversation')
        : (meta?.title ?? 'New conversation');
      const base = meta ?? { id: activeConv, title: 'New conversation', updatedAt: Date.now(), messages: [], ledger: [], todos: [], lastPromptTokens: 0 };
      const updated: ConvMeta = { ...base, id: activeConv, title, updatedAt: Date.now(), messages, ledger, todos, todosUpdatedAt: todosUpdatedAt ?? undefined, lastPromptTokens: lastPromptTokensRef.current, checkpoints: meta?.checkpoints ?? [] };
      const order = wsd.order.includes(activeConv) ? wsd.order : [...wsd.order, activeConv];
      return {
        ...prev,
        workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [activeConv]: updated }, order } },
      };
    });
  }, [messages, ledger, todos, todosUpdatedAt, activeWs, activeConv]);

  // Keep the control plane's coder workspace pointed at the active workspace — but
  // HOLD the re-point while a run is in flight: every agent tool call resolves
  // against the control plane's configured workspace, so re-pointing mid-run would
  // send the running agent's edits/commits to the repo the user just switched
  // to. When the run ends the re-point fires (running flips in the deps) and
  // the panel reloads below pick it up via wsFlushed.
  //
  // Re-points are SERIALIZED (each chained after the previous) so rapid
  // A→B→A switches can't interleave, and only the LATEST request commits
  // wsAppliedDirRef/wsFlushed — a stale response from an older switch can't
  // clobber the applied workspace. runAgent awaits this queue before its
  // first control-plane tool call, so an in-flight re-point settles before the run
  // starts rather than landing mid-run.
  const wsApplySeqRef = useRef(0);
  const wsApplyPendingRef = useRef(false);
  /** Enqueue a control-plane re-point (serialized; only the latest request commits
   *  wsAppliedDirRef/wsFlushed). Called by the effect below AND directly by
   *  the ask-resume paths — their setStore-driven effect would otherwise
   *  enqueue the re-point only after runAgent already passed its queue await,
   *  i.e. mid-run. */
  const queueWorkspaceApply = (dir: string) => {
    if (wsAppliedDirRef.current === dir && !wsApplyPendingRef.current) return;
    const seq = ++wsApplySeqRef.current;
    wsApplyPendingRef.current = true;
    setWsBusy(true);
    const task = wsApplyQueueRef.current
      .catch(() => undefined) // a previous failure must not clog the queue
      .then(() => setCoderWorkspace(dir))
      .catch((e) => console.warn('Failed to set coder workspace on control plane:', e))
      .then(() => {
        // Only the LATEST request may commit — a stale response from an older
        // workspace switch would otherwise leave wsAppliedDirRef pointing at
        // a workspace the control plane is no longer on.
        if (seq === wsApplySeqRef.current) {
          wsAppliedDirRef.current = dir;
          setWsFlushed((n) => n + 1);
        }
      })
      .finally(() => { wsApplyPendingRef.current = false; setWsBusy(false); });
    wsApplyQueueRef.current = task;
  };
  useEffect(() => {
    if (!activeWsDir) return;
    // Held until the run finishes — wsBusy stays false so the user can still
    // switch/add workspaces (those re-points just queue behind the run).
    if (running) { setWsBusy(false); return; }
    queueWorkspaceApply(activeWsDir);
  }, [activeWsDir, running]);
  // True while the view is on a different workspace than the one the control plane
  // is still pointed at (a re-point held by an in-flight run).
  const wsHeld = running && wsAppliedDirRef.current !== null && wsAppliedDirRef.current !== activeWsDir;

  // Seed the default workspace from the control plane once its path is known.
  const seeded = useRef(false);
  useEffect(() => {
    if (!coderWs || seeded.current) return;
    seeded.current = true;
    // Remount (screen switch or app restart) with a persisted workspace:
    // restore the last active conversation instead of presenting an empty
    // transcript — the store survives, so the visible state must too.
    const existing = storeRef.current.workspaces[coderWs];
    if (existing) {
      const convId = existing.activeConv ?? existing.order[existing.order.length - 1];
      if (convId && existing.conversations[convId]) {
        setStore((prev) => ({ ...prev, activeWs: coderWs, activeConv: convId }));
        loadConv(coderWs, convId);
      } else {
        setMessages([]);
        setLedger([]);
        applyTodos([], null);
        lastPromptTokensRef.current = 0;
      }
      return;
    }
    setStore((prev) => {
      if (prev.workspaces[coderWs]) return prev;
      const id = newConvId();
      const ws: WsData = { expanded: true, conversations: { [id]: emptyConv(id) }, order: [id], activeConv: id, perms: loadDefaultPerms() };
      return { ...prev, activeWs: coderWs, activeConv: id, workspaces: { ...prev.workspaces, [coderWs]: ws } };
    });
    setMessages([]);
    setLedger([]);
    applyTodos([], null);
    lastPromptTokensRef.current = 0;
  }, [coderWs]);

  /** Create a fresh conversation inside a workspace and make it active. */
  const newChat = (ws: string = activeWs) => {
    if (running) {
      addLog({ type: 'error', label: 'chat', detail: 'Cannot create new conversation while an agent run is in flight. Stop the current run first.' });
      return;
    }
    if (!ws) return;
    const id = newConvId();
    setStore((prev) => {
      const wsd = prev.workspaces[ws] ?? { expanded: true, conversations: {}, order: [], activeConv: undefined, perms: loadDefaultPerms() };
      return {
        ...prev,
        activeWs: ws,
        activeConv: id,
        workspaces: { ...prev.workspaces, [ws]: { ...wsd, conversations: { ...wsd.conversations, [id]: emptyConv(id) }, order: [...wsd.order, id], activeConv: id } },
      };
    });
    setMessages([]);
    setLedger([]);
    applyTodos([], null);
    lastPromptTokensRef.current = 0;
  };
  /** Fork the active conversation: duplicate its transcript into a new thread. */
  const forkConversation = () => {
    if (running) {
      addLog({ type: 'error', label: 'chat', detail: 'Cannot fork conversation while an agent run is in flight. Stop the current run first.' });
      return;
    }
    if (!activeWs || !activeConv) return;
    const src = storeRef.current.workspaces[activeWs]?.conversations[activeConv];
    if (!src) return;
    const id = newConvId();
    const copy: ConvMeta = {
      ...src,
      id,
      title: `${src.title || 'Conversation'} (fork)`,
      updatedAt: Date.now(),
      messages: src.messages.map((m) => ({ ...m })),
      ledger: src.ledger.map((l) => ({ ...l })),
      todos: src.todos.map((t) => ({ ...t })),
    };
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      if (!wsd) return prev;
      const at = wsd.order.indexOf(activeConv);
      const order = [...wsd.order];
      order.splice(at < 0 ? order.length : at + 1, 0, id);
      return {
        ...prev,
        activeConv: id,
        workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, conversations: { ...wsd.conversations, [id]: copy }, order, activeConv: id } },
      };
    });
    loadConv(activeWs, id);
  };
  /** Export the active transcript as Markdown (download). Secrets stay redacted. */
  const exportTranscript = () => {
    const meta = storeRef.current.workspaces[activeWs]?.conversations[activeConv];
    if (!meta || meta.messages.length === 0) return;
    const parts: string[] = [`# ${meta.title || 'Conversation'}`, '', `_Workspace: ${activeWs}_`, ''];
    for (const m of meta.messages) {
      if (m.role === 'user' && !isCompactedMsg(m)) parts.push(`## user\n\n${m.content}`);
      else if (m.role === 'assistant') {
        parts.push(`## assistant${m.model ? ` (${m.model})` : ''}\n`);
        if (m.reasoning) parts.push(`<details><summary>thinking</summary>\n\n${m.reasoning}\n\n</details>`);
        if (m.content) parts.push(m.content);
        for (const tc of m.tool_calls ?? []) parts.push(`- tool \`${tc.name}\` \`${tc.arguments.slice(0, 300)}\``);
      } else if (m.role === 'tool') parts.push(`- result \`${m.name ?? ''}\`:\n\n\`\`\`\n${redactSecrets(m.content).slice(0, 4000)}\n\`\`\``);
      parts.push('');
    }
    const blob = new Blob([parts.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(meta.title || 'conversation').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'conversation'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  // Conversation selection + CRUD (store state stays above; handlers live in
  // the hook). clearView resets the visible transcript when no conversation
  // is selected (workspace removed, active conversation archived/deleted).
  const clearView = () => {
    setMessages([]);
    setLedger([]);
    applyTodos([], null);
    lastPromptTokensRef.current = 0;
  };
  const {
    editingConv, setEditingConv, archivedOpen, setArchivedOpen,
    handleSelectConv, handleSelectWorkspace, handleToggleExpand,
    handleAddWorkspace, handleRemoveWorkspace, handleRenameConv,
    handleArchiveConv, handleDeleteConv,
  } = useConversationHandlers({
    store,
    setStore,
    activeWs,
    activeConv,
    loadConv,
    clearView,
    isPinned: (ws, cid) => (runConvRef.current ?? askConvRef.current)?.ws === ws && (runConvRef.current ?? askConvRef.current)?.convId === cid,
    isWorkspacePinned: (path) => (runConvRef.current ?? askConvRef.current)?.ws === path,
  });
  const abortRef = useRef<AbortController | null>(null);
  const modelRef = useRef<string>('qwen-coder');
  /** Lint/test/build commands resolved once per run (config, else manifest
   *  detection) — cached PER WORKSPACE: the cache is neither keyed nor reset
   *  by activeWsDir, so a save-lint in workspace B must not execute the
   *  relative lint/build command detected in workspace A. */
  const detectedCmdsByWsRef = useRef(new Map<string, { lint?: string; test?: string; build?: string }>());

  // ---- Small-model reliability guards (reset at the start of every run(), see below) ----
  /** Paths `read` this run, or successfully `edit`/`apply_patch`'d (which
   *  requires matching real existing content) — read-before-write guard input. */
  const readPathsRef = useRef(new Set<string>());
  /** Paths that already got ONE unread-write refusal this run — the second
   *  attempt is let through (a deliberate blind overwrite), so a stubborn
   *  model doesn't get stuck retrying the same blocked call forever. */
  const unreadWriteWarnedRef = useRef(new Set<string>());
  /** Sliding-window cache of recent PURE (read-only) tool calls this run —
   *  name+args hash -> raw result. An identical repeat is short-circuited
   *  with the cached result instead of re-executing. */
  const toolDedupRef = useRef<Array<{ hash: string; name: string; result: string }>>([]);
  const TOOL_DEDUP_WINDOW = 5;
  const PURE_DEDUP_TOOLS = new Set(['read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'repo_search', 'obs_recall', 'memory_recall']);
  /** Consecutive FAILED edit/apply_patch attempts per file path this run —
   *  a patch-spiral signal (the model keeps guessing at an `old` string
   *  that doesn't match). Reset on any successful edit/patch to that path. */
  const patchFailuresRef = useRef(new Map<string, number>());
  /** Consecutive read-only tool calls this run with no other kind of call
   *  in between — a read-loop signal (the model keeps investigating past
   *  the point of having enough context). Reset by any non-read-only call. */
  const readStreakRef = useRef(0);
  const READ_STREAK_TOOLS = new Set(['read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'repo_search', 'obs_recall', 'memory_recall']);

  /** Stable hash for a (tool name, raw JSON args string) pair — sorts object
   *  keys first so argument order never defeats a cache hit. */
  const hashToolCall = (name: string, argsStr: string): string => {
    let norm = argsStr;
    try {
      const o = JSON.parse(argsStr);
      if (o && typeof o === 'object') norm = JSON.stringify(o, Object.keys(o).sort());
    } catch { /* not JSON — hash the raw string */ }
    return `${name}|${norm}`;
  };
  /** True when a tool result string is a `{error: ...}` shape — used to
   *  avoid caching (dedup) or crediting (read-loop reset) a failed call. */
  const isErrorResult = (s: string): boolean => {
    try { const o = JSON.parse(s); return !!(o && typeof o === 'object' && 'error' in o); } catch { return false; }
  };
  /** Attach a human-readable system note to a tool result without breaking
   *  callers that parse it as JSON (same parse/mutate/restringify pattern
   *  as maybeSummarizeTool's `_summarized` flag). */
  const withNote = (resultStr: string, note: string): string => {
    try {
      const o = JSON.parse(resultStr);
      if (o && typeof o === 'object') { (o as Record<string, unknown>)._note = note; return JSON.stringify(o); }
    } catch { /* not JSON */ }
    return `${resultStr}\n\n[SYSTEM] ${note}`;
  };
  /** Track an edit/apply_patch outcome for `path`. Returns a nudge string
   *  once the same file has failed 4+ times in a row (a patch spiral —
   *  the model should stop guessing and rewrite instead), then resets so
   *  it doesn't nag on every subsequent attempt. */
  const trackPatchSpiral = (path: string, success: boolean): string | null => {
    if (success) { patchFailuresRef.current.delete(path); return null; }
    const n = (patchFailuresRef.current.get(path) ?? 0) + 1;
    patchFailuresRef.current.set(path, n);
    if (n >= 4) {
      patchFailuresRef.current.delete(path);
      return `You have failed to patch ${path} ${n} times in a row. Stop using edit/apply_patch on this file — read it fully, decide what the ENTIRE file should contain, and use \`write\` to rewrite it from scratch instead.`;
    }
    return null;
  };

  const addLog = (entry: Omit<LogEntry, 'id' | 'time'>) => {
    const safe = entry.detail ? { ...entry, detail: redactSecrets(entry.detail) } : entry;
    // Run logs belong to the conversation the run is pinned to, not whatever
    // the user is currently viewing; the ledger only mirrors the view. The
    // fallback reads storeRef (not the captured activeWs/activeConv) because
    // long-lived closures (e.g. refreshRepoMap) hold an old render's values.
    const target = runConvRef.current ?? { ws: storeRef.current.activeWs, convId: storeRef.current.activeConv };
    const rec: LogEntry = { ...safe, id: crypto.randomUUID(), time: Date.now() };
    setStore((prev) => {
      const wsd = prev.workspaces[target.ws];
      const meta = wsd?.conversations[target.convId];
      if (!wsd || !meta) return prev;
      return {
        ...prev,
        workspaces: { ...prev.workspaces, [target.ws]: { ...wsd, conversations: { ...wsd.conversations, [target.convId]: { ...meta, ledger: [...(meta.ledger ?? []).slice(-999), rec], updatedAt: Date.now() } } } },
      };
    });
    if (target.ws === storeRef.current.activeWs && target.convId === storeRef.current.activeConv) setLedger((prev) => [...prev.slice(-999), rec]);
  };
  // Background shell jobs + live subagent runs (Jobs panel).
  const jobs = useCoderJobs({ activeWs, onError: (detail) => addLog({ type: 'error', label: 'job', detail }) });
  // Commit history + revert (panel render lives in CommitsPanel).
  const git = useCoderGit({ activeWsDir, activeWs, wsFlushed, running, onLog: addLog });

  // ---- Todos: user actions (the panel is no longer read-only). Edits take
  // effect on the agent's next LLM call via the per-turn system-prompt
  // injection (todoSystemBlock + todosRef), so the human can retask, drop a
  // spinning step, or add work mid-run without waiting for the next agent
  // todo_write. User edits persist with the conversation (todos in ConvMeta).
  const addTodo = (raw: string) => {
    const content = raw.trim();
    if (!content) return;
    const wasEmpty = todosRef.current.length === 0;
    mutateTodos((prev) => [...prev, { content, status: 'pending' }]);
    addLog({ type: 'todo', label: 'manual', detail: `added task: ${content.slice(0, 60)}` });
    if (wasEmpty) flashTodosCreated();
  };
  const cycleTodo = (i: number) => {
    mutateTodos((prev) => prev.map((t, j) => (j === i ? { ...t, status: t.status === 'pending' ? 'in_progress' : t.status === 'in_progress' ? 'completed' : 'pending' } : t)));
  };
  const removeTodo = (i: number) => {
    mutateTodos((prev) => prev.filter((_, j) => j !== i));
    addLog({ type: 'todo', label: 'manual', detail: 'removed a task' });
  };
  // Rebuild the system prompt's static half and refresh the live codebase
  // context (repo map etc.) so the agent sees files it just created/edited
  // (P1 #6). Stored in dynamicSystemRef / codebaseContextRef for use each turn.
  const refreshRepoMap = useCallback(async () => {
    const sys = CODER_SYSTEM;
    let ctx = '';
    if (appConfigRef.current?.coderRepoMapEnabled !== false) {
      try {
        const rMap = await coderRepoMap();
        if (rMap && rMap.map) {
          // Unlike conventions/skills/followed-files below, this comes straight
          // from an AST scan of the whole repo with no size control of its own —
          // cap it so a large codebase can't silently balloon every turn's prompt.
          const REPO_MAP_CAP = 10000;
          const map = rMap.map.length > REPO_MAP_CAP
            ? rMap.map.slice(0, REPO_MAP_CAP) + '\n…(truncated — repo map exceeds context budget; use repo_map or ast_grep tools to search the codebase)'
            : rMap.map;
          ctx += `\n\n# Codebase Map (Auto-generated AST Signatures)\n\`\`\`\n${map}\n\`\`\`\n`;
        }
      } catch { /* ignore */ }
    }
    // Project conventions: AGENTS.md preferred, CLAUDE.md fallback — refreshed
    let convName = '';
    try {
      let name = 'AGENTS.md';
      let conv = await coderRead(name);
      if (conv.binary || !conv.content?.trim()) { name = 'CLAUDE.md'; conv = await coderRead(name); }
      const txt = (!conv.binary && conv.content ? conv.content : '').slice(0, 8000);
      if (txt.trim() && txt !== conventionsRef.current) {
        conventionsRef.current = txt;
        addLog({ type: 'read', label: 'conventions', detail: `${name} (${txt.length} chars)` });
      } else if (!txt.trim()) {
        conventionsRef.current = '';
      }
      if (conventionsRef.current.trim()) convName = name;
    } catch {
      conventionsRef.current = '';
    }
    if (conventionsRef.current.trim()) {
      ctx += `\n\n# Project Conventions (from ${convName || 'workspace memory file'} — follow these)\n${conventionsRef.current}\n`;
    }
    // Bootstrap: surface the already-detected lint/test/build commands up
    // front so the model doesn't spend early tool calls discovering them
    // (they're detected once per run in run(), before this first executes —
    // see detectedCmdsByWsRef). Looked up via the same run-pinned workspace
    // key used for boundPaths below, not the possibly-stale `activeWsDir`.
    try {
      const pin = runConvRef.current;
      const tWs = pin?.ws ?? storeRef.current.activeWs;
      const tConv = pin?.convId ?? storeRef.current.activeConv;
      const tMeta = storeRef.current.workspaces[tWs]?.conversations[tConv];
      const tWsDir = tMeta?.worktree ? `${tWs}/${tMeta.worktree}` : tWs;
      const cmds = detectedCmdsByWsRef.current.get(tWsDir);
      if (cmds && (cmds.lint || cmds.test || cmds.build)) {
        const lines = [
          cmds.build ? `- build: \`${cmds.build}\`` : '',
          cmds.lint ? `- lint: \`${cmds.lint}\`` : '',
          cmds.test ? `- test: \`${cmds.test}\`` : '',
        ].filter(Boolean);
        ctx += `\n\n# Detected project commands\nUse these to build/lint/test — no need to search for them:\n${lines.join('\n')}\n`;
      }
    } catch { /* bootstrap injection must never break system-prompt assembly */ }
    // Skills-lite: workspace `skills/*/SKILL.md` index. Only names + first-line
    // descriptions are injected; the model reads a skill file via `read` when
    // relevant. Refreshed each run, capped to bound context usage.
    try {
      const g = await coderGlob('skills/*/SKILL.md');
      const files = (g.files ?? []).slice(0, 20);
      const lines: string[] = [];
      for (const f of files) {
        try {
          const s = await coderRead(f, 0, 30);
          if (s.binary || !s.content) continue;
          const ls = s.content.split('\n').map((x) => x.trim()).filter(Boolean);
          const title = (ls[0] ?? f).replace(/^#\s*/, '').slice(0, 80);
          const desc = (ls[1] ?? '').slice(0, 160);
          lines.push(`- ${f}: ${title}${desc ? ` — ${desc}` : ''}`);
        } catch { /* skip unreadable skill */ }
      }
      if (lines.length > 0) {
        ctx += `\n\n# Skills (read the SKILL.md with the read tool when its trigger matches)\n${lines.join('\n').slice(0, 4000)}\n`;
        addLog({ type: 'read', label: 'skills', detail: `${lines.length} skill(s)` });
      }
    } catch { /* no skills dir */ }
    // System-prompt "follow" bindings: files/folders pinned from the Tree panel.
    // The system prompt follows the user's selection, re-read fresh each run so
    // edits to followed files surface in the agent's context automatically.
    try {
      // Followed paths belong to the conversation the run is pinned to, not
      // the one on screen (a mid-run switch is a view change only) — otherwise
      // a mutation in the still-running conversation could inject ANOTHER
      // conversation's bound paths into its next prompt.
      const pin = runConvRef.current;
      const tWs = pin?.ws ?? storeRef.current.activeWs;
      const tConv = pin?.convId ?? storeRef.current.activeConv;
      const bps = storeRef.current.workspaces[tWs]?.conversations[tConv]?.boundPaths ?? [];
      if (bps.length) {
        const followed: string[] = [
          '\n\n# Followed files (system prompt follows these — pinned context for every turn)',
        ];
        const seen = new Set<string>();
        let used = 0;
        const CAP = 20000;
        for (const p of bps) {
          if (used > CAP || seen.has(p)) continue;
          seen.add(p);
          try {
            const r = await coderRead(p, 0, 300);
            if (!r.binary && r.content && r.content.length) {
              const body = r.content.length > 4000 ? r.content.slice(0, 4000) + '\n…(truncated to 4000 chars)' : r.content;
              followed.push(`## ${p}\n\`\`\`\n${body}\n\`\`\``);
              used += body.length;
            } else if (r.binary) {
              followed.push(`- ${p} (binary — omitted)`);
            } else {
              // No readable file content → treat as a directory and list its files (bounded).
              let files: string[] = [];
              try { files = (await coderGlob(`${p}/**`)).files ?? []; } catch { /* ignore */ }
              files = files.slice(0, 200);
              followed.push(`## ${p}/ (directory — ${files.length} file(s) listed)\n${files.map((f) => `- ${f}`).join('\n')}`);
              used += files.join('\n').length;
            }
          } catch {
            followed.push(`- ${p} (unreadable)`);
          }
        }
        if (followed.length > 1) ctx += followed.join('\n');
      }
    } catch { /* never break system-prompt assembly over follow-bindings */ }

    // Not-Ai humanize: when enabled, append the editorial contract (plus the
    // chosen voice profile) so the agent's user-facing prose avoids em dashes,
    // buzzwords, and empty framing. The deterministic gate is applied separately
    // to content-only assistant replies. Driven by a user toggle, not live
    // filesystem state, so this stays part of the (cache-stable) system prompt.
    let staticSys = sys;
    if (coderParamsRef.current.humanize) {
      const voice = voiceSnippet(coderParamsRef.current.voiceProfile || 'technical');
      staticSys += `\n\n# Humanize replies (Not-Ai)\n${NOT_AI_CONTRACT}${voice ? `\n\n${voice}` : ''}\n`;
    }

    // Review lens: inject a distilled coding-review discipline (e.g. the Linus
    // Torvalds method) into the system prompt. The full method is too large to
    // inline every turn, so only the compact distillation is injected here; the
    // complete catalog can live in the workspace `skills/` dir (auto-indexed).
    // Also a user toggle, not live filesystem state.
    const lensBlock = coderLensBlock(coderParamsRef.current.reviewLens);
    if (lensBlock) staticSys += `\n\n# Review lens\n${lensBlock}\n`;

    // Deliberately no live date/time appended here: this string is reused
    // as-is across every step of a run (and re-set after every mutating
    // tool call), and it sits ahead of the growing conversation history in
    // every request — a value that changed on essentially every call would
    // invalidate the engine's KV-cache reuse (and any cache_control
    // breakpoint) for the entire history on every single turn. The date is
    // appended instead as a persisted contextNoteMessage(), added to real
    // history in useCoderAgentLoop's runAgent — see agentLoop.ts. The same
    // reasoning is why `ctx` (repo map, conventions, followed files — all
    // live filesystem state, refreshed on every mutating tool call) is kept
    // out of dynamicSystemRef entirely and folded into that same note by the
    // caller instead; see codebaseContextRef's declaration.
    dynamicSystemRef.current = staticSys;
    codebaseContextRef.current = ctx;
  }, []);

  const {
    treeNodes,
    treeLoading,
    treeExpanded,
    treeChildren,
    loadTree,
    onExpandDir,
    toggleBind,
    clearBinds,
  } = useCoderFileTree({
    activeWs,
    activeConv,
    activeWsDir,
    treeOpen,
    wsFlushed,
    wsAppliedDirRef,
    setStore,
    refreshRepoMap,
  });
  /** undoFileEdit is defined before the tabs hook (which needs it as its
   *  onUndoEdit); this ref keeps the refresh path one-way (no cyclic dep). */
  const tabsRefreshRef = useRef<() => void>(() => {});

  const { undoLastCommit, undoFileEdit } = useCoderUndo({
    activeWsDir,
    running,
    gitCommits: git.commits,
    loadGitCommits: git.loadCommits,
    refreshRepoMap,
    tabsRefreshRef,
    addLog,
  });

  // ---- File tabs (VS Code-style center column: Chat + open file tabs) ----
  const tabs = useFileTabs({
    activeWsDir,
    running,
    // Mid-run backend-hold gate: while a run pins the control plane to another
    // workspace, every backend-touching tab op no-ops (the wsHeld chip explains).
    backendReady: () => wsAppliedDirRef.current === activeWsDir,
    getLintCommand: () => {
      const c = activeWsDir ? detectedCmdsByWsRef.current.get(activeWsDir) : undefined;
      return c?.lint || c?.build || null;
    },
    onUndoEdit: (p) => { void undoFileEdit(p); },
  });
  tabsRefreshRef.current = () => { void tabs.refreshOpenTabs(); void tabs.refreshGitStatus(); };
  // Refresh git badges once a new workspace's control-plane re-point is flushed.
  useEffect(() => {
    void tabs.refreshGitStatus();
  }, [tabs.refreshGitStatus, wsFlushed, activeWsDir]);
  // Content refresh only when the flush actually lands (wsFlushed bumped):
  // a held mid-run switch — and even a plain switch's in-flight POST — skips
  // the restore re-reads (backendReady is false until the confirmed
  // workspace), so this is the point at which rereading open tabs (code AND
  // image — the snapshot drops image payloads) is guaranteed to hit the
  // right workspace. Gated on the delta so a plain activeWsDir change (no
  // flush) doesn't double-read the tabs the flush will cover anyway.
  const wsFlushedPrevRef = useRef(wsFlushed);
  useEffect(() => {
    const flushed = wsFlushed !== wsFlushedPrevRef.current;
    wsFlushedPrevRef.current = wsFlushed;
    if (!flushed) return;
    void tabs.refreshOpenTabs();
  }, [tabs.refreshOpenTabs, wsFlushed]);

  const {
    showBranchMenu,
    setShowBranchMenu,
    branchMenuRef,
    handleCreateBranch,
    handleSwitchBranch,
  } = useCoderBranchManager({
    activeWs,
    running,
    gitCurrentBranch: git.currentBranch,
    createBranch: git.createBranch,
    switchBranch: git.switchBranch,
    refreshRepoMap,
    loadTree,
    tabsRefreshRef,
  });

  // ---- Permissions (per-workspace tiers + denied path prefixes) ----
  const perms: PermConfig = store.workspaces[activeWs]?.perms ?? DEFAULT_PERMS;
  const setPerms = (next: PermConfig) => {
    if (!activeWs) return;
    setStore((prev) => {
      const wsd = prev.workspaces[activeWs];
      if (!wsd) return prev;
      return { ...prev, workspaces: { ...prev.workspaces, [activeWs]: { ...wsd, perms: next } } };
    });
  };
  const setToolPerm = (tool: string, tier: PermTier) =>
    setPerms({ ...perms, tools: { ...perms.tools, [tool]: tier } });
  // Mirror tiers + denyPaths to the control plane so `deny` is enforced
  // server-side too (see coderPermsSet) — re-synced on every edit and on
  // workspace switch, since `perms` is derived from `activeWs`. Scoped to the
  // SAME `activeWsDir` the tool calls below send as `workspace`, so the
  // control plane's per-endpoint re-check (enforce_perm) reads exactly the
  // bucket this UI edits.
  useEffect(() => {
    if (!activeWs) return;
    coderPermsSet({ tools: perms.tools, denyPaths: perms.denyPaths }, activeWsDir).catch(() => { /* best-effort mirror */ });
  }, [activeWs, perms, activeWsDir]);
  // MCP tools (mcp__<server>__<tool>) — the control plane owns the server
  // connections (desktop/control/src/mcp.rs); this is the LLM-ready catalog
  // plus each tool's effective tier for this workspace. The ref feeds the run
  // loop (stable across re-renders), the state feeds the sidebar permission
  // grid below.
  const mcpToolsRef = useRef<McpToolInfo[]>([]);
  const [mcpTools, setMcpTools] = useState<McpToolInfo[]>([]);
  const refreshMcpTools = useCallback(() => {
    mcpToolsGet(activeWsDir)
      .then((r) => { mcpToolsRef.current = r.tools; setMcpTools(r.tools); })
      .catch(() => { /* control plane unreachable — no MCP tools this run */ });
  }, [activeWsDir]);
  useEffect(() => { refreshMcpTools(); }, [refreshMcpTools]);
  /** Human-readable denial reason, or `'ask'` when the user must decide, or null. */
  const checkPerm = (name: string, args: Record<string, unknown>): string | 'ask' | null => {
    if (planMode && MUTATING_TOOLS.has(name)) {
      if (name === 'bash') {
        // Plan mode keeps bash for investigation, locked to inspection commands.
        const cmd = typeof args.command === 'string' ? args.command.trim() : '';
        if (!isReadOnlyCommand(cmd)) {
          return 'Plan mode is read-only — bash may only run inspection commands (find, ls, cat, head, tail, wc, grep, rg, file, stat, du, tree, git log/status/diff/show, …); redirection, pipes, and chaining are rejected. Turn Plan off to execute anything that changes state.';
        }
      } else {
        return 'Plan mode is read-only — the run cannot write files or execute commands. Turn Plan off to apply changes.';
      }
    }
    if (planMode && name.startsWith(MCP_NAME_PREFIX)) {
      return 'Plan mode is read-only — external MCP tools are disabled (they may mutate external state).';
    }
    // Per-tool row, else the per-server `mcp__<server>` row for MCP names.
    const tier = mcpToolTier(perms, name);
    if (tier === 'deny') {
      return `Denied by workspace permissions (${name} is set to deny).`;
    }
    const target = typeof args.path === 'string' ? args.path : '';
    if (target) {
      const normTarget = target.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
      const hit = perms.denyPaths.find((d) => {
        const clean = d.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
        return clean !== '' && (normTarget === clean || normTarget.startsWith(clean + '/'));
      });
      if (hit) return `Denied by workspace permissions (path is under denied prefix "${hit.trim()}").`;
    }
    if (tier === 'ask') return 'ask';
    return null;
  };
  /** Pause the agent loop until the user approves or denies this one call. */
  const requestApproval = (name: string, detail: string): Promise<boolean> => {
    setPendingApproval({ name, detail });
    return new Promise<boolean>((resolve) => {
      approvalResolveRef.current = (ok: boolean) => {
        approvalResolveRef.current = null;
        setPendingApproval(null);
        resolve(ok);
      };
    });
  };
  /** Resume the run after an ask_user pause, sending the human's decision (and
   * optional note) back to the model as the tool answer. */
  const resumeFromAsk = (answer: string) => {
    if (pendingQuestion === null) return;
    setPendingQuestion(null);
    setAskNote('');
    const msg: ChatMessage = { role: 'user', content: answer };
    // Resume into the PAUSED conversation (askConvRef) even if the user has
    // since switched — the answer must not resume from the transcript now on
    // screen.
    const pin = askConvRef.current;
    askConvRef.current = null;
    if (pin && (pin.ws !== activeWs || pin.convId !== activeConv)) {
      setStore((prev) => ({ ...prev, activeWs: pin.ws, activeConv: pin.convId }));
      const pMeta = storeRef.current.workspaces[pin.ws]?.conversations[pin.convId];
      const pDir = pMeta?.worktree ? `${pin.ws}/${pMeta.worktree}` : pin.ws;
      queueWorkspaceApply(pDir); // must settle before the resumed run's first tool call
      const base = storeRef.current.workspaces[pin.ws]?.conversations[pin.convId]?.messages ?? [];
      loadConv(pin.ws, pin.convId);
      runAgent(compactedContext(base).concat(msg), { scout: false, pin });
      return;
    }
    const next = [...messages, msg];
    setMessages(next);
    // Resumed runs skip the scout pre-pass (its findings are already in context).
    runAgent(compactedContext(messages).concat(msg), { scout: false, pin: pin ?? undefined });
  };

  // ---------------------------------------------------------------------------
  // AI summarization of giant tool outputs. When a tool result (command output,
  // a large file read, a fetched page) exceeds SUMMARY_THRESHOLD, we ask the
  // engine to condense it and return the summary plus a short raw tail to the
  // agent — keeping its context small instead of ingesting a raw multi-KB dump.
  // ---------------------------------------------------------------------------
  const SUMMARY_THRESHOLD = 16 * 1024;
  const SUMMARY_TAIL = 1500;
  const maybeSummarizeTool = async (
    name: string,
    resultStr: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    // obs_recall is the recall path itself — summarizing its own output would
    // be circular (see LARGE_OUTPUT_EXCLUDED_TOOLS).
    if (LARGE_OUTPUT_EXCLUDED_TOOLS.has(name)) return resultStr;
    let res: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(resultStr);
      if (parsed && typeof parsed === 'object') res = parsed as Record<string, unknown>;
    } catch {
      return resultStr;
    }
    if (!res) return resultStr;
    const extracted = extractToolResultText(res);
    if (!extracted) return resultStr;
    const { text, hasStd } = extracted;
    if (text.length <= SUMMARY_THRESHOLD) return resultStr;
    // A bash result's exitCode is a known, authoritative pass/fail signal —
    // pass it through so the receipt validator can reject a summary that
    // disagrees with it. File reads have no such signal (undefined).
    const isError = hasStd && typeof res.exitCode === 'number' ? res.exitCode !== 0 : undefined;
    try {
      const receipt = await summarizeOutputVerified({ model, output: text, isError, signal });
      // null covers a transport/stream failure AND a rejected (unverifiable
      // or outcome-mismatched) receipt — either way, fall back untouched.
      if (!receipt) return resultStr;
      const tail = text.slice(-SUMMARY_TAIL);
      const wrapped = formatSummarizedOutput(text.length, receipt, tail);
      applyResultPlaceholder(res, wrapped);
      res._summarized = true;
      return JSON.stringify(res);
    } catch {
      // On any summarizer failure, fall back to the raw (already-truncated) output.
      return resultStr;
    }
  };

  // ---------------------------------------------------------------------------
  // Per-workspace risky-command approval memory.
  //
  // Some bash commands have external / hard-to-reverse side effects (pushing to a
  // remote, publishing a package, SSH to a host, mutating cloud/infra, running as
  // root). When the agent issues one, we pause for human-in-the-loop review. If the
  // human approves *and* asks to remember, the (normalized) command is added to
  // this workspace's `approvedCommands` so future matching commands run without
  // re-prompting. `detectDestructive` (server-side safe mode) still hard-blocks the
  // truly catastrophic ones; this layer is for "risky but allowed with a yay/nay".
  // ---------------------------------------------------------------------------
  const RISKY_PATTERNS: Array<[RegExp, string]> = [
    [/\bgit\s+push\b[^]*?(--force|-f\b|--delete)\b/i, 'force-pushes or deletes remote refs'],
    [/\bgit\s+push\b/i, 'pushes commits to a remote'],
    [/\b(npm|pnpm|yarn)\s+publish\b/i, 'publishes a package to a registry'],
    [/\bcargo\s+publish\b/i, 'publishes a crate'],
    [/\btwine\s+upload\b/i, 'uploads a release to PyPI'],
    [/\bgh\s+(pr|release|api)\b/i, 'creates a GitHub release/PR via gh'],
    [/\b(sudo|su|doas)\b/i, 'runs a command as another user (root)'],
    [/\bssh\b(?!-)/i, 'opens an SSH connection to a remote host'],
    [/\b(scp|rsync|sftp)\b/i, 'transfers files to/from a remote host'],
    [/\b(docker|podman)\b/i, 'runs containers'],
    [/\b(kubectl|helm|terraform\s+apply|ansible)\b/i, 'applies infrastructure changes'],
    [/\b(aws|gcloud|az)\b[^]*?\b(ec2|s3|deploy|apply|create|delete|update|push)\b/i, 'mutates cloud resources'],
    [/\b(apt|apt-get|yum|dnf|apk)\b\s+(install|remove|upgrade|update)\b/i, 'changes system packages'],
    [/\b(npm\s+install\s+-g|pnpm\s+add\s+-g|yarn\s+global\s+add)\b/i, 'installs a global package'],
  ];
  const detectRisky = (cmd: string): string | null => {
    const trimmed = cmd.trim();
    if (isReadOnlyCommand(trimmed)) return null;
    for (const [re, why] of RISKY_PATTERNS) if (re.test(cmd)) return why;
    return null;
  };
  const normalizeCommand = (cmd: string): string => cmd.replace(/\s+/g, ' ').trim();
  const isApprovedCommand = (cmd: string, approved: string[] = []): boolean => {
    const c = normalizeCommand(cmd);
    return approved.some((a) => {
      const na = normalizeCommand(a);
      return c === na || c.startsWith(na + ' ');
    });
  };
  const addApprovedCommand = (cmd: string) => {
    const norm = normalizeCommand(cmd);
    const targetWs = runConvRef.current?.ws ?? storeRef.current.activeWs;
    setStore((prev) => {
      const wsd = prev.workspaces[targetWs];
      if (!wsd) return prev;
      const cur = wsd.perms?.approvedCommands || [];
      if (cur.includes(norm)) return prev;
      return {
        ...prev,
        workspaces: {
          ...prev.workspaces,
          [targetWs]: { ...wsd, perms: { ...(wsd.perms || DEFAULT_PERMS), approvedCommands: [...cur, norm] } },
        },
      };
    });
  };

  // Risky-command HITL dialog: Deny / Approve once / Approve & remember.
  const [riskyApproval, setRiskyApproval] = useState<{ command: string; reason: string; fromSubagent?: boolean } | null>(null);
  const riskyResolveRef = useRef<((v: 'deny' | 'once' | 'remember') => void) | null>(null);
  /** Pause and ask the human before a risky command runs — `fromSubagent`
   *  marks a request that originated from a worker subagent's own `bash`
   *  call (rather than the supervisor's), noted on the dialog. */
  const requestRiskyApproval = (command: string, reason: string, fromSubagent = false): Promise<'deny' | 'once' | 'remember'> => {
    setRiskyApproval({ command, reason, fromSubagent });
    return new Promise((resolve) => {
      riskyResolveRef.current = (v) => {
        riskyResolveRef.current = null;
        setRiskyApproval(null);
        resolve(v);
      };
    });
  };

  const {
    showCheckpoints,
    setShowCheckpoints,
    createCheckpoint,
    restoreCheckpoint,
    deleteCheckpoint,
  } = useCoderCheckpoints({
    activeWs,
    activeConv,
    activeWsDir,
    messages,
    ledger,
    todos,
    running,
    setStore,
    setMessages,
    setLedger,
    applyTodos,
    addLog,
    loadGitCommits: git.loadCommits,
    refreshRepoMap,
  });
  const checkpoints = store.workspaces[activeWs]?.conversations[activeConv]?.checkpoints ?? [];

  const { getFilePreview, runPostEditChecks } = useCoderToolHandlers({
    activeWsDir,
    detectedCmdsByWsRef,
  });

  const {
    runSubagent,
    runWorker,
    runIdeation,
    runCritic,
    persistLearnings,
  } = useCoderSubagents({
    activeWsDir,
    activeWs,
    jobs,
    appConfig,
    coderParams,
    dynamicSystemRef,
    codebaseContextRef,
    requestApproval,
    addLog,
    memoryRef,
  });

  const { handleToolCalls } = useCoderToolDispatcher({
    appConfig,
    coderParams,
    abortRef,
    activeWsDir,
    activeWs,
    activeConv,
    perms,
    modelRef,
    toolDedupRef,
    readPathsRef,
    unreadWriteWarnedRef,
    patchFailuresRef,
    readStreakRef,
    askRef,
    askConvRef,
    runConvRef,
    todosRef,
    todosRevRef,
    todosRevAtReqStartRef,
    memoryRef,
    mcpToolsRef,
    commitApproval,
    criticMode,
    jobs,
    addLog,
    createCheckpoint,
    requestApproval,
    requestRiskyApproval,
    addApprovedCommand,
    requestCommitApproval,
    setStore,
    setPendingQuestion,
    updateRunTodos,
    flashTodosCreated,
    adoptMemory,
    runPostEditChecks,
    getFilePreview,
    trackPatchSpiral,
    checkPerm,
    runSubagent,
    runWorker,
    runIdeation,
    runCritic,
    persistLearnings,
    isGitCommitCommand,
  });




  // ---------------------------------------------------------------------------
  // Standalone Verify/Critic actions — Verify and Critic also work as one-click
  // checks against whatever is on disk right now, independent of the Verify/
  // Critic toggles (which only gate an agent run's own finish condition). Plan
  // and Scout have no standalone equivalent: Scout only makes sense ahead of a
  // run it feeds context into, and Plan only means anything as a constraint on
  // an upcoming run — neither has a "thing that already exists" to check.
  // ---------------------------------------------------------------------------
  const [verifyNowBusy, setVerifyNowBusy] = useState(false);
  const [criticNowBusy, setCriticNowBusy] = useState(false);

  const runVerifyNow = async () => {
    if (verifyNowBusy || running) return;
    setVerifyNowBusy(true);
    const cmds = (activeWsDir ? detectedCmdsByWsRef.current.get(activeWsDir) : undefined) ?? {};
    if (!cmds.lint && !cmds.build && !cmds.test) {
      addLog({ type: 'error', label: 'verify', detail: 'no lint/build/test command detected for this workspace' });
      setVerifyNowBusy(false);
      return;
    }
    addLog({ type: 'read', label: 'verify', detail: 'checking current working tree…' });
    try {
      const v = await runPostEditChecks({}, '', abortRef.current?.signal);
      if (v.linter_error) {
        addLog({ type: 'error', label: 'verify', detail: `lint failed: ${String(v.linter_error).slice(0, 200)}` });
      } else if (v.test_error) {
        addLog({ type: 'error', label: 'verify', detail: `tests failed: ${String(v.test_error).slice(0, 200)}` });
      } else {
        addLog({ type: 'bash', label: 'verify', detail: 'lint/test passed' });
      }
    } catch (e) {
      addLog({ type: 'error', label: 'verify', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setVerifyNowBusy(false);
    }
  };

  const runCriticNow = async () => {
    if (criticNowBusy || running) return;
    setCriticNowBusy(true);
    addLog({ type: 'read', label: 'critic', detail: 'reviewing current diff…' });
    try {
      const d = await coderDiff();
      if (!d.diff || !d.diff.trim()) {
        addLog({ type: 'error', label: 'critic', detail: 'no uncommitted changes to review' });
        return;
      }
      const taskText = [...messages].reverse().find((m) => m.role === 'user' && !isCompactedMsg(m))?.content
        || 'Review the current uncommitted changes for correctness and quality.';
      const c = await runCritic(d.diff, taskText, abortRef.current?.signal);
      if (c.learnings.length) {
        await persistLearnings(c.learnings, c.approved ? 'critic:approve' : 'critic:reject', taskText);
      }
      addLog({
        type: c.approved ? 'bash' : 'error',
        label: 'critic',
        detail: c.approved ? 'approved (no issues found)' : `issues: ${c.issues.slice(0, 120)}`,
      });
    } catch (e) {
      addLog({ type: 'error', label: 'critic', detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setCriticNowBusy(false);
    }
  };

  const { runAgent } = useCoderAgentLoop({
    activeWs,
    activeConv,
    activeWsDir,
    stream: trackedStream,
    setRunConv,
    setRunning,
    stoppedRef,
    runTokensRef,
    lastPromptTokensRef,
    wsApplyQueueRef,
    readPathsRef,
    unreadWriteWarnedRef,
    toolDedupRef,
    patchFailuresRef,
    readStreakRef,
    detectedCmdsByWsRef,
    refreshRepoMap,
    memoryRef,
    coderParams,
    modelRef,
    abortRef,
    scoutOn,
    setCtxLimit,
    setAgentSteps,
    perms,
    mcpToolsRef,
    planMode,
    dynamicSystemRef,
    codebaseContextRef,
    todosRef,
    todosRevRef,
    todosRevAtReqStartRef,
    appConfig,
    handleToolCalls,
    tabs,
    git,
    askRef,
    askConvRef,
    runConvRef,
    setPendingQuestion,
    addLog,
    verifyMode,
    runPostEditChecks,
    criticMode,
    runCritic,
    persistLearnings,
    updateRunMessages,
    noteRunTokens,
    setMessages,
    queuedRef,
    setQueued,
    storeRef,
    setStore,
    runSubagent,
  });

  const onSubmit = () => {
    if ((!input.trim() && attachments.length === 0) || !activeWs) return;

    const currentInput = input.trim();
    if (/(?:must|never|always|prefer|use)\b/i.test(currentInput)) {
      const extractorSystem = `Extract strict rules and intent constraints from the user's prompt as a JSON array. Only include genuinely reusable constraints, not one-off tasks.
\`\`\`json
[
  { "kind": "success", "text": "use pnpm", "component": "general", "scope": "repo", "target_key": "packageManager", "value": "pnpm" }
]
\`\`\``;
      const extractorCfg = resolveProviderConfig('subagent', appConfig, {
        subagentProvider: coderParams.subagentProvider,
        subagentCloudModel: coderParams.subagentCloudModel,
        taskWeight: 'light',
      }, coderParams.criticModel?.trim() || modelRef.current);
      const req = buildChatRequest(extractorCfg.model, extractorSystem, [{ role: 'user', content: currentInput }], { thinking: false, maxTokens: 1024 } as ChatParams, {});

      (async () => {
        let textContent = '';
        try {
          await trackedStream(req, abortRef.current?.signal ?? new AbortController().signal, 'critic', { onContentDelta: (t) => { textContent += t; } }, {
            baseUrl: extractorCfg.baseUrl,
            apiKey: extractorCfg.apiKey,
            extraHeaders: extractorCfg.extraHeaders,
            allowFallback: appConfig?.cloudFallbackToLocal !== false,
          });
          const jsonMatch = textContent.match(/\`\`\`json\s*(\[[\s\S]*?\])\s*\`\`\`/);
          if (jsonMatch) {
            const rules = JSON.parse(jsonMatch[1]);
            for (const r of rules) {
              if (r.text && r.kind) {
                coderMemoryAddLearning(r).then((m) => adoptMemory(m)).catch(() => {});
              }
            }
          }
        } catch { /* ignore */ }
      })();
    }
    if (running) {
      // Don't block on a run in flight — queue for whichever conversation is
      // on screen right now, and it auto-sends once that conversation's run
      // finishes (see runAgent's finally block).
      if (!activeConv) return;
      const item: QueuedItem = { text: input.trim(), attachments: [...attachments] };
      setQueued((q) => ({ ...q, [activeConv]: [...(q[activeConv] ?? []), item] }));
      setInput('');
      setAttachments([]);
      return;
    }
    // Answering a pending ask_user question: clear the pause and continue. The
    // answer is just a normal user message that resumes the run (#5). Resumed
    // runs skip the scout — its findings are already in context.
    const resuming = pendingQuestion !== null;
    if (resuming) setPendingQuestion(null);
    const msg: ChatMessage = { role: 'user', content: input.trim(), attachments: attachments.length ? attachments : undefined };
    // Answering a question that was asked while the user has since switched
    // conversations: the answer belongs to the PAUSED conversation — go back
    // there and resume from its transcript (not the one now on screen).
    const resumePin = resuming ? askConvRef.current : null;
    askConvRef.current = null;
    if (resumePin && (resumePin.ws !== activeWs || resumePin.convId !== activeConv)) {
      setStore((prev) => ({ ...prev, activeWs: resumePin.ws, activeConv: resumePin.convId }));
      const pMeta = storeRef.current.workspaces[resumePin.ws]?.conversations[resumePin.convId];
      const pDir = pMeta?.worktree ? `${resumePin.ws}/${pMeta.worktree}` : resumePin.ws;
      queueWorkspaceApply(pDir); // must settle before the resumed run's first tool call
      const base = storeRef.current.workspaces[resumePin.ws]?.conversations[resumePin.convId]?.messages ?? [];
      loadConv(resumePin.ws, resumePin.convId);
      setInput('');
      setAttachments([]);
      runAgent(compactedContext(base).concat(msg), { scout: false, pin: resumePin });
      return;
    }
    const next = [...messages, msg];
    setMessages(next);
    setInput('');
    setAttachments([]);
    // Seed the model context from the most recent compaction checkpoint onward.
    // The visible transcript keeps the full history; only the engine's context is
    // cleared to the summary and re-injected as leading context.
    runAgent(compactedContext(messages).concat(msg), { scout: !resuming, pin: resumePin ?? undefined });
  };

  // Send a suggested follow-up straight away (bypassing the composer) — only
  // ever shown against the latest, already-finished turn, so a plain new
  // instruction on the current conversation is always the right action.
  const onFollowUp = (content: string) => {
    const trimmed = content.trim();
    if (!trimmed || running || !activeWs || pendingQuestion !== null) return;
    const msg: ChatMessage = { role: 'user', content: trimmed };
    const next = [...messages, msg];
    setMessages(next);
    runAgent(compactedContext(messages).concat(msg), { scout: true });
  };

  // True while a run is in flight in a DIFFERENT conversation than the one on
  // screen. The Stop button is disabled there so the user can't stop (or try to
  // track) a run they can't see — switch to the running conversation (marked
  // with the pulsing dot / header chip) to stop it.
  const runElsewhere = running && !!runConv && (runConv.ws !== activeWs || runConv.convId !== activeConv);

  const stop = () => {
    stoppedRef.current = true;
    abortRef.current?.abort();
    // Never leave the agent loop parked on an approval dialog after Stop.
    approvalResolveRef.current?.(false);
    commitResolveRef.current?.(false);
  };

  // Persist conversations + per-workspace permissions across reloads (debounced).
  useEffect(() => {
    saveStoreDebounced(store, 500, () => {
      console.warn('[storage] Failed to persist conversation store to localStorage (quota exceeded or private mode)');
    });
  }, [store]);
  // Persist sampling params across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(CODER_PARAMS_KEY, JSON.stringify(coderParams));
    } catch { /* ignore */ }
  }, [coderParams]);

  // ---- Workspace file attachments -------------------------------------------
  const openPicker = async () => {
    setPickerSelected({});
    setShowPicker(true);
    setPickerLoading(true);
    try {
      const tree = await coderTree(4, '.');
      setPickerNodes(tree.nodes ?? []);
    } catch {
      setPickerNodes([]);
    } finally {
      setPickerLoading(false);
    }
  };
  const toggleNode = (path: string) =>
    setPickerExpanded((e) => ({ ...e, [path]: !e[path] }));
  const attachSelected = async (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (attachments.some((a) => a.path === node.path)) continue;
      try {
        if (isImagePath(node.path)) {
          const res = await coderReadBase64(node.path);
          setAttachments((cur) => [...cur, { kind: 'image', name: node.name, path: node.path, dataUrl: res.dataUrl }]);
        } else {
          const res = await coderRead(node.path);
          setAttachments((cur) => [...cur, { kind: 'file', name: node.name, path: node.path, content: res.content ?? '' }]);
        }
      } catch {
        /* ignore unreadable file */
      }
    }
    setShowPicker(false);
    setPickerSelected({});
  };
  const removeAttachment = (path?: string) =>
    setAttachments((cur) => cur.filter((a) => a.path !== path));

  const messageGroups = useMemo(() => {
    const groups: { type: 'message' | 'trajectory' | 'compact', items: ChatMessage[] }[] = [];
    let currentTrajectory: ChatMessage[] = [];

    const flushTrajectory = () => {
      if (currentTrajectory.length > 0) {
        groups.push({ type: 'trajectory', items: currentTrajectory });
        currentTrajectory = [];
      }
    };

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (isCompactedMsg(m)) {
        flushTrajectory();
        groups.push({ type: 'compact', items: [m] });
        continue;
      }
      const isBackground = m.role === 'tool' || (m.role === 'assistant' && !!m.tool_calls?.length);

      if (isBackground) {
        currentTrajectory.push(m);
      } else {
        flushTrajectory();
        groups.push({ type: 'message', items: [m] });
      }
    }
    flushTrajectory();
    return groups;
  }, [messages]);

  // Auto-scroll the transcript as the agent streams new messages/tools, but
  // only while the user is pinned near the bottom — scrolling up to read
  // history must not yank the view back down. Mirrors the Chat screen and
  // the Log pane (stick-to-bottom, re-engage when they return to the end).
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptStick = useRef(true);
  // Re-pin on workspace/conversation switch: a newly loaded transcript opens
  // at its latest message and follows the stream, instead of inheriting the
  // previous conversation's scrolled-up position (where auto-follow would be
  // off and the view would sit stale). Runs before the scroll effect below,
  // which then applies the fresh bottom position.
  useEffect(() => {
    transcriptStick.current = true;
  }, [activeWs, activeConv]);
  useEffect(() => {
    const el = transcriptRef.current;
    // While a file tab is active the chat panel is display:none (all dims 0) —
    // skip force-scrolling the hidden node; the existing re-pin logic decides
    // on re-show.
    if (el && transcriptStick.current && !tabs.activeTabId) el.scrollTop = el.scrollHeight;
  }, [messageGroups, tabs.activeTabId]);

  const boundPaths = activeMeta?.boundPaths ?? [];

  const renderTree = (list: FileNode[], depth: number): React.ReactNode => (
    <div>
      {list.map((n) => {
        const bound = boundPaths.includes(n.path);
        const kids = treeChildren[n.path] ?? n.children;
        return (
          <div key={n.path}>
            <div className={cn('group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-panel2', bound && 'text-accent')} style={{ paddingLeft: depth * 10 + 4 }}>
              {n.kind === 'dir' ? (
                <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={() => void onExpandDir(n)}>
                  {treeExpanded[n.path] ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                  <Folder size={12} className="shrink-0 text-accent" />
                  <span className="truncate">{n.name}</span>
                </button>
              ) : (
                <>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={() => tabs.openFile(n.path)} title={n.path}>
                    <span className="w-3 shrink-0" />
                    <File size={12} className="shrink-0 text-mute" />
                    <span className="truncate">{n.name}</span>
                  </button>
                  {tabs.statusMap.get(n.path) ? (
                    <span className={cn('shrink-0 font-mono text-[10px] font-bold', GIT_BADGE_CLASS[tabs.statusMap.get(n.path)!])} title={`git status: ${tabs.statusMap.get(n.path)}`}>
                      {tabs.statusMap.get(n.path)}
                    </span>
                  ) : null}
                </>
              )}
              <button
                type="button"
                className={cn('shrink-0 rounded p-0.5 hover:bg-panel', bound ? 'text-accent' : 'text-faint opacity-0 group-hover:opacity-100')}
                title={bound ? 'Unpin from system prompt (stop following)' : 'Pin to system prompt (follow this file/dir)'}
                onClick={() => toggleBind(n.path)}
              >
                <BookmarkPlus size={12} />
              </button>
            </div>
            {n.kind === 'dir' && treeExpanded[n.path] && kids && renderTree(kids, depth + 1)}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="flex h-full w-full">
      <CoderSidebar
        store={store}
        activeWs={activeWs}
        activeConv={activeConv}
        runConv={runConv}
        wsBusy={wsBusy}
        setShowDir={setShowDir}
        handleToggleExpand={handleToggleExpand}
        handleSelectWorkspace={handleSelectWorkspace}
        baseName={baseName}
        newChat={newChat}
        handleRemoveWorkspace={handleRemoveWorkspace}
        editingConv={editingConv}
        setEditingConv={setEditingConv}
        handleRenameConv={handleRenameConv}
        handleSelectConv={handleSelectConv}
        relTime={relTime}
        handleArchiveConv={handleArchiveConv}
        handleDeleteConv={handleDeleteConv}
        archivedOpen={archivedOpen}
        setArchivedOpen={setArchivedOpen}
        ledger={ledger}
        activeWsDir={activeWsDir}
        git={git}
        jobs={jobs}
        treeOpen={treeOpen}
        setTreeOpen={setTreeOpen}
        treeLoading={treeLoading}
        treeNodes={treeNodes}
        loadTree={loadTree}
        renderTree={renderTree}
        boundPaths={boundPaths}
        clearBinds={clearBinds}
      />

      <CoderWorkspaceTabs tabs={tabs} running={running} setFileDiffPath={setFileDiffPath}>
        <CoderHeader
          activeWs={activeWs}
          activeMeta={activeMeta ?? null}
          runConv={runConv}
          wsHeld={wsHeld}
          wsAppliedDirRef={wsAppliedDirRef}
          ctxTokens={ctxTokens}
          ctxLimit={ctxLimit}
          running={running}
          agentSteps={agentSteps}
          maxAgentSteps={coderParams.maxAgentSteps}
          planMode={planMode}
          setPlanMode={setPlanMode}
          scoutOn={scoutOn}
          setScoutOn={setScoutOn}
          verifyMode={verifyMode}
          setVerifyMode={setVerifyMode}
          runVerifyNow={runVerifyNow}
          verifyNowBusy={verifyNowBusy}
          criticMode={criticMode}
          setCriticMode={setCriticMode}
          runCriticNow={runCriticNow}
          criticNowBusy={criticNowBusy}
          showBranchMenu={showBranchMenu}
          setShowBranchMenu={setShowBranchMenu}
          branchMenuRef={branchMenuRef}
          git={git}
          handleSwitchBranch={handleSwitchBranch}
          handleCreateBranch={handleCreateBranch}
          diffViewOpen={diffViewOpen}
          setDiffViewOpen={setDiffViewOpen}
          memOpen={memOpen}
          setMemOpen={setMemOpen}
          memory={memory}
          forkConversation={forkConversation}
          exportTranscript={exportTranscript}
          undoLastCommit={undoLastCommit}
          showCheckpoints={showCheckpoints}
          setShowCheckpoints={setShowCheckpoints}
          newChat={newChat}
          messagesCount={messages.length}
          store={store}
          baseName={baseName}
          formatTokens={formatTokens}
          defaultMaxAgentSteps={DEFAULT_MAX_AGENT_STEPS}
        />
        <CheckpointsPanel
          showCheckpoints={showCheckpoints}
          activeWs={activeWs}
          activeConv={activeConv}
          running={running}
          checkpoints={checkpoints}
          createCheckpoint={createCheckpoint}
          restoreCheckpoint={restoreCheckpoint}
          deleteCheckpoint={deleteCheckpoint}
        />

        <CoderTranscriptView
          transcriptRef={transcriptRef}
          tabsActiveTabId={tabs.activeTabId}
          transcriptStick={transcriptStick}
          planMode={planMode}
          coderSafeMode={coderSafeMode}
          activeWs={activeWs}
          activeWsDir={activeWsDir}
          messageGroups={messageGroups}
          running={running}
          pendingQuestion={pendingQuestion}
          onFollowUp={onFollowUp}
          TrajectoryBlock={TrajectoryBlock}
          ReportBlock={ReportBlock}
          Markdown={Markdown}
        />
        <CoderComposer
          llmPhase={llmPhase}
          nowTick={nowTick}
          attachments={attachments}
          removeAttachment={removeAttachment}
          showCoderParams={showCoderParams}
          setShowCoderParams={setShowCoderParams}
          coderParams={coderParams}
          setCoderParams={setCoderParams}
          appConfig={appConfig}
          openPicker={openPicker}
          running={running}
          activeWs={activeWs}
          input={input}
          setInput={setInput}
          onSubmit={onSubmit}
          pendingQuestion={pendingQuestion}
          stop={stop}
          runElsewhere={runElsewhere}
          runConv={runConv}
          activeConv={activeConv}
          queued={queued}
          setQueued={setQueued}
          coderSafeMode={coderSafeMode}
          baseName={baseName}
          store={store}
          defaultMaxAgentSteps={DEFAULT_MAX_AGENT_STEPS}
        />
      </CoderWorkspaceTabs>

      <CoderTodoSidebar
        todos={todos}
        todosUpdatedAt={todosUpdatedAt}
        todosJustCreated={todosJustCreated}
        todoDraft={todoDraft}
        setTodoDraft={setTodoDraft}
        cycleTodo={cycleTodo}
        removeTodo={removeTodo}
        addTodo={addTodo}
      />

      <CoderModals
        pendingQuestion={pendingQuestion}
        askNote={askNote}
        setAskNote={setAskNote}
        resumeFromAsk={resumeFromAsk}
        pendingApproval={pendingApproval}
        approvalResolveRef={approvalResolveRef}
        riskyApproval={riskyApproval}
        riskyResolveRef={riskyResolveRef}
        diffViewOpen={diffViewOpen}
        setDiffViewOpen={setDiffViewOpen}
        commitReviewOpen={commitReviewOpen}
        commitApprovalFromSubagent={commitApprovalFromSubagent}
        commitResolveRef={commitResolveRef}
        fileDiffPath={fileDiffPath}
        setFileDiffPath={setFileDiffPath}
        memOpen={memOpen}
        setMemOpen={setMemOpen}
        memory={memory}
        adoptMemory={adoptMemory}
        loadMemory={loadMemory}
        showDir={showDir}
        setShowDir={setShowDir}
        handleAddWorkspace={handleAddWorkspace}
        showPicker={showPicker}
        setShowPicker={setShowPicker}
        pickerNodes={pickerNodes}
        pickerLoading={pickerLoading}
        pickerExpanded={pickerExpanded}
        pickerSelected={pickerSelected}
        toggleNode={toggleNode}
        setPickerSelected={setPickerSelected}
        attachSelected={attachSelected}
        attachments={attachments}
        ATTACH_MAX_BYTES={ATTACH_MAX_BYTES}
      />

    </div>
  );
}
