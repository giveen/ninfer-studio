import { useRef, useCallback } from 'react';
import type { ChatMessage, AgentToolCall, ChatParams } from '../lib/types';
import type { CoderMemory } from '../lib/api/coder';
import type { LogEntry, TodoItem, CoderStore } from '../lib/coderStore';
import type { McpToolInfo, ChatStreamCallbacks } from '../lib/api';
import type { CoderParams, QueuedItem } from '../components/coder/CoderComposer';
import {
  getStatus,
  getEngineContextSize,
  summarizeConversation,
  frameCompactedSummary,
  coderExec,
  coderDiff,
  streamChat,
} from '../lib/api';
import {
  TOOLS,
  READONLY_TOOL_NAMES,
  SCOUT_PROBES,
  DEFAULT_MAX_AGENT_STEPS,
  mcpToolTier,
  mcpToolSchema,
} from '../lib/coderTools';
import { formatTokens, CHARS_PER_TOKEN } from '../lib/format';
import { resolveProviderConfig } from '../lib/chatHelpers';
import { compactedContext, isCompactedMsg, humanizePassText, streamTurn, contextNoteMessage, type TurnResult } from '../lib/agentLoop';
import { packForRequest } from '../lib/observationPack';
import { effectiveVoice, humanizeRewriteText } from '../lib/notai';
import { detectCommands, todoSystemBlock } from '../lib/coderStore';

export interface UseCoderAgentLoopOptions {
  activeWs: string;
  activeConv: string;
  activeWsDir: string;
  setRunConv: (conv: { ws: string; convId: string } | null) => void;
  setRunning: (r: boolean) => void;
  stoppedRef: React.MutableRefObject<boolean>;
  runTokensRef: React.MutableRefObject<number>;
  lastPromptTokensRef: React.MutableRefObject<number>;
  wsApplyQueueRef: React.MutableRefObject<Promise<void>>;
  readPathsRef: React.MutableRefObject<Set<string>>;
  unreadWriteWarnedRef: React.MutableRefObject<Set<string>>;
  toolDedupRef: React.MutableRefObject<Array<{ hash: string; result: string }>>;
  patchFailuresRef: React.MutableRefObject<Map<string, number>>;
  readStreakRef: React.MutableRefObject<number>;
  detectedCmdsByWsRef: React.MutableRefObject<Map<string, any>>;
  refreshRepoMap: () => Promise<void>;
  memoryRef: React.MutableRefObject<CoderMemory>;
  coderParams: CoderParams;
  modelRef: React.MutableRefObject<string>;
  abortRef: React.MutableRefObject<AbortController | null>;
  scoutOn: boolean;
  setCtxLimit: (limit: number | null) => void;
  setAgentSteps: (steps: number) => void;
  perms: any;
  mcpToolsRef: React.MutableRefObject<McpToolInfo[]>;
  planMode: boolean;
  dynamicSystemRef: React.MutableRefObject<string>;
  codebaseContextRef: React.MutableRefObject<string>;
  todosRef: React.MutableRefObject<TodoItem[]>;
  todosRevRef: React.MutableRefObject<number>;
  todosRevAtReqStartRef: React.MutableRefObject<number>;
  appConfig: any;
  handleToolCalls: (
    calls: AgentToolCall[],
    msgs: ChatMessage[],
    onMutate?: () => Promise<void> | void
  ) => Promise<ChatMessage[]>;
  tabs: { refreshOpenTabs: () => Promise<void>; refreshGitStatus: () => Promise<void> };
  git: { loadBranches: () => void; loadCommits: () => void };
  askRef: React.MutableRefObject<string | null>;
  askConvRef: React.MutableRefObject<{ ws: string; convId: string } | null>;
  runConvRef: React.MutableRefObject<{ ws: string; convId: string } | null>;
  setPendingQuestion: (q: string | null) => void;
  addLog: (log: any) => void;
  verifyMode: boolean;
  runPostEditChecks: (result: any, preview: string, signal?: AbortSignal) => Promise<any>;
  criticMode: boolean;
  runCritic: (diff: string, taskText: string, signal?: AbortSignal) => Promise<{ approved: boolean; issues: string; learnings: any[] }>;
  persistLearnings: (learnings: any[], provenance: string, taskText: string) => Promise<void>;
  updateRunMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  noteRunTokens: (n: number) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  queuedRef: React.MutableRefObject<Record<string, QueuedItem[]>>;
  setQueued: React.Dispatch<React.SetStateAction<Record<string, QueuedItem[]>>>;
  storeRef: React.MutableRefObject<CoderStore>;
  setStore: React.Dispatch<React.SetStateAction<CoderStore>>;
  runSubagent: (label: string, prompt: string, model: string, signal: AbortSignal, maxSteps?: number, allowedTools?: string[], depth?: number) => Promise<string>;
  stream?: (
    req: Record<string, unknown>,
    signal: AbortSignal,
    label: string,
    cb: ChatStreamCallbacks,
    opts?: { baseUrl?: string; apiKey?: string; extraHeaders?: string; allowFallback?: boolean }
  ) => Promise<unknown>;
}

export function useCoderAgentLoop(opts: UseCoderAgentLoopOptions) {
  const runAgent = async (
    initialMessages: ChatMessage[],
    options?: { scout?: boolean; pin?: { ws: string; convId: string } }
  ) => {
    opts.setRunConv(options?.pin ?? { ws: opts.activeWs, convId: opts.activeConv });
    opts.setRunning(true);
    opts.stoppedRef.current = false;
    opts.runTokensRef.current = opts.lastPromptTokensRef.current;
    await opts.wsApplyQueueRef.current.catch(() => undefined);
    let currentMessages = initialMessages;
    let runStartHead = '';
    try {
      runStartHead = (
        await coderExec('git rev-parse HEAD', undefined, 10000, undefined, false, undefined, opts.activeWsDir)
      ).stdout.trim();
    } catch {
      /* not a repo */
    }

    opts.readPathsRef.current = new Set();
    opts.unreadWriteWarnedRef.current = new Set();
    opts.toolDedupRef.current = [];
    opts.patchFailuresRef.current = new Map();
    opts.readStreakRef.current = 0;

    {
      const m = opts.detectedCmdsByWsRef.current;
      if (!m.has(opts.activeWsDir) && m.size >= 8) m.delete(m.keys().next().value!);
      m.set(opts.activeWsDir, await detectCommands());
    }
    await opts.refreshRepoMap();

    // No task-categorizer call here (unlike a design that once tagged each
    // task's component via a separate model call): that call went to the
    // same local engine, with its own system prompt, right before the main
    // run's first request — a throwaway continuation that competes with
    // this run's for the same small device-state/catalog slots, same
    // failure mode as scout probes and suggestFollowUps below. Skipping the
    // classification just means every component's intent rules are shown
    // instead of only the relevant ones — a precision loss, not a
    // correctness one.
    let intentRulesBlock = '';
    try {
      const mem = opts.memoryRef.current;
      if (mem && mem.learnings.length > 0) {
        const byComponent: Record<string, any[]> = {};
        for (const l of mem.learnings) {
          const comp = l.component || 'general';
          if (!byComponent[comp]) byComponent[comp] = [];
          byComponent[comp].push(l);
        }
        const parts = [];
        for (const [comp, rules] of Object.entries(byComponent)) {
          parts.push(`### Component: ${comp}`);
          for (const r of rules) parts.push(`- [${r.kind}] ${r.text}`);
        }
        if (parts.length > 0) {
          intentRulesBlock = `\n\n# Intent Continuity Rules\n${parts.join('\n')}\n`;
        }
      }
    } catch {
      /* ignore */
    }

    opts.abortRef.current = new AbortController();

    let fallbackModel = 'qwen-coder';
    try {
      const s = await getStatus();
      if (s?.engine?.modelId) fallbackModel = s.engine.modelId;
    } catch {
      /* ignore */
    }
    const primaryConfig = resolveProviderConfig('primary', opts.appConfig, {
      primaryProvider: opts.coderParams.primaryProvider,
      primaryCloudModel: opts.coderParams.primaryCloudModel,
    }, fallbackModel);
    const model = primaryConfig.model;
    const mainProvider: 'cloud' | 'local' = primaryConfig.baseUrl ? 'cloud' : 'local';
    opts.modelRef.current = model;
    opts.addLog({ type: 'read', label: 'run', provider: mainProvider, detail: `main agent on ${mainProvider}: ${model}` });

    if (options?.scout && opts.scoutOn) {
      const subConfig = resolveProviderConfig('subagent', opts.appConfig, {
        provider: opts.coderParams.subagentProvider,
        cloudModel: opts.coderParams.subagentCloudModel,
        taskWeight: 'light',
      }, model);
      const isCloudSub = !!subConfig.baseUrl;

      if (!opts.abortRef.current?.signal.aborted) {
        const task =
          [...currentMessages].reverse().find((m) => m.role === 'user' && !isCompactedMsg(m))?.content ?? '';
        const signal = opts.abortRef.current!.signal;

        let summaries: string[] = [];
        if (isCloudSub) {
          // Parallel probes only when the subagent hits a separate cloud endpoint.
          // On the local engine, probes share the main conversation's KV-cache
          // budget/slots — running them concurrently evicts the primary loop's
          // cached prefix and can drop its hit rate to 0%.
          opts.addLog({ type: 'read', label: 'scout', provider: 'cloud', detail: '3 parallel probes (cloud)' });
          summaries = await Promise.all(
            SCOUT_PROBES.map(async (p) => {
              const s = await opts.runSubagent(
                p.label,
                `Task: ${task.slice(0, 2000)}\n\nScout goal (${p.label}): ${
                  p.goal
                }\n\nYou are read-only: investigate with tools and reply with a concise findings report (paths + facts). Do not write code.`,
                model,
                signal
              );
              opts.addLog({ type: 'read', label: `scout:${p.label}`, provider: 'cloud', detail: `${s.length} chars` });
              return `## ${p.label}\n${s}`;
            })
          );
        } else {
          opts.addLog({ type: 'read', label: 'scout', provider: 'local', detail: '3 sequential probes (preserves local KV cache)' });
          for (const p of SCOUT_PROBES) {
            if (signal.aborted) break;
            const s = await opts.runSubagent(
              p.label,
              `Task: ${task.slice(0, 2000)}\n\nScout goal (${p.label}): ${
                p.goal
              }\n\nYou are read-only: investigate with tools and reply with a concise findings report (paths + facts). Do not write code.`,
              model,
              signal
            );
            opts.addLog({ type: 'read', label: `scout:${p.label}`, provider: 'local', detail: `${s.length} chars` });
            summaries.push(`## ${p.label}\n${s}`);
          }
        }

        if (!signal.aborted && summaries.length > 0) {
          const scoutMsg: ChatMessage = {
            role: 'user',
            displayName: 'Scout',
            collapsed: true,
            content: `# Scout Report (read-only pre-pass, ${
              summaries.length
            } probes)\n${summaries.join('\n\n')}\n\nUse these findings; verify paths before editing.`,
          };
          currentMessages = [...currentMessages, scoutMsg];
          opts.updateRunMessages((prev) => [...prev, scoutMsg]);
        }
      }
    }
    if (opts.abortRef.current.signal.aborted) {
      opts.setRunning(false);
      opts.abortRef.current = null;
      opts.setRunConv(null);
      return;
    }

    let maxContext = 0;
    try {
      maxContext = (await getEngineContextSize(model)) ?? 0;
    } catch {
      /* ignore */
    }
    if (!maxContext) {
      try {
        const s = await getStatus();
        maxContext = s?.engine?.maxContext ?? 0;
      } catch {
        /* ignore */
      }
    }
    if (!maxContext && (primaryConfig.baseUrl || opts.appConfig?.cloudProviderEnabled)) {
      maxContext = 200_000;
    } else if (!maxContext) {
      maxContext = 128_000;
    }
    opts.setCtxLimit(maxContext > 0 ? maxContext : null);
    const COMPACT_AT = (opts.coderParams.compactAt ?? 80) / 100;
    const MAX_ATTEMPTS = 3;
    const MAX_AGENT_STEPS = opts.coderParams.maxAgentSteps || DEFAULT_MAX_AGENT_STEPS;
    const MAX_REPAIR = 3;
    const MAX_CRITIC = 2;
    let criticBudget = 0;
    const MAX_CONTINUE = 4;
    let continueCount = 0;
    const taskText =
      [...initialMessages].reverse().find((m) => m.role === 'user' && !isCompactedMsg(m))?.content ?? '';
    const respFloor = 4096;
    const respMax =
      maxContext > 0 ? Math.min(Math.max(Math.floor(maxContext / 2), respFloor), 16384) : 8192;

    const sysTokenEstimate = Math.ceil((opts.dynamicSystemRef.current.length + opts.codebaseContextRef.current.length) / CHARS_PER_TOKEN);
    const estimateTokens = (msgs: ChatMessage[]): number => {
      let n = sysTokenEstimate;
      for (const m of msgs) {
        n += typeof m.content === 'string' ? m.content.length : 0;
        if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
      }
      return Math.ceil(n / CHARS_PER_TOKEN);
    };

    try {
      let agentSteps = 0;
      opts.setAgentSteps(0);
      let repairCount = 0;
      while (true) {
        if (opts.abortRef.current?.signal.aborted) break;

        const est = estimateTokens(currentMessages);
        const recordedOrEst = Math.max(opts.runTokensRef.current, est);
        const overBudget = maxContext > 0 && (recordedOrEst >= COMPACT_AT * maxContext || est >= maxContext);
        if (overBudget) {
          opts.addLog({
            type: 'compact',
            label: 'compact',
            detail: `context ${opts.runTokensRef.current}/${maxContext} — summarizing`,
          });
          try {
            const summary = await summarizeConversation({
              model,
              baseUrl: primaryConfig.baseUrl,
              apiKey: primaryConfig.apiKey,
              extraHeaders: primaryConfig.extraHeaders,
              // A one-off call over the whole history, not a growing prefix,
              // so there's no cache locality to protect — give it the full
              // codebase context for a better-grounded summary.
              systemPrompt: [opts.dynamicSystemRef.current, opts.codebaseContextRef.current].filter(Boolean).join('\n\n'),
              history: currentMessages,
              maxTokens: 2048,
              signal: opts.abortRef.current?.signal,
              useLocalCompactor: opts.appConfig?.cloudUseLocalCompactor !== false,
            });
            if (!summary) throw new Error('compaction produced no summary');
            currentMessages = [{ role: 'user', displayName: 'Compaction Summary', collapsed: true, content: frameCompactedSummary(summary) }];
            opts.updateRunMessages((prev) => [...prev, ...currentMessages]);
            opts.noteRunTokens(0);
            opts.readPathsRef.current = new Set();
            opts.unreadWriteWarnedRef.current = new Set();
            continue;
          } catch (e) {
            if (!(e instanceof DOMException && e.name === 'AbortError')) {
              opts.addLog({
                type: 'error',
                label: 'compact',
                detail: e instanceof Error ? e.message : String(e),
              });
              opts.updateRunMessages((prev) => [
                ...prev,
                {
                  role: 'system',
                  content:
                    '⚠ Auto-compaction failed, so the run was stopped to avoid exceeding the model context window. Start a new conversation or compact manually.',
                },
              ]);
            }
            break;
          }
        }

        if (agentSteps >= MAX_AGENT_STEPS) {
          opts.addLog({
            type: 'error',
            label: 'limit',
            detail: `reached max agent steps (${MAX_AGENT_STEPS}) — stopping to avoid a runaway run`,
          });
          opts.updateRunMessages((prev) => [
            ...prev,
            {
              role: 'system',
              content: `⚠ Reached the maximum number of agent steps (${MAX_AGENT_STEPS}). The run was stopped to avoid a runaway loop. Review the work so far, then continue in a new message or break the task into smaller steps.`,
            },
          ]);
          break;
        }
        agentSteps++;
        opts.setAgentSteps(agentSteps);

        let content = '';
        let reasoning = '';
        let toolCalls: AgentToolCall[] = [];
        let finishReason: string | undefined;

        const undeniedTools = TOOLS.filter((t) => (opts.perms.tools[t.function.name] ?? 'allow') !== 'deny');
        const undeniedMcp = opts.mcpToolsRef.current
          .filter((t) => mcpToolTier(opts.perms, t.name) !== 'deny')
          .map(mcpToolSchema);
        const activeTools = opts.planMode
          ? undeniedTools.filter((t) => READONLY_TOOL_NAMES.has(t.function.name) || t.function.name === 'bash')
          : [...undeniedTools, ...undeniedMcp];
        const planToolNames = [...new Set([...READONLY_TOOL_NAMES, 'bash'])].join(', ');
        const system = opts.planMode
          ? `${opts.dynamicSystemRef.current}\n\n# PLAN MODE (read-only): investigate, analyze, and propose a concrete, step-by-step plan, then stop and wait for the user.\nAvailable tools: ${planToolNames}. bash is READ-ONLY here: inspection commands only (find, ls, cat, head, tail, wc, grep, rg, file, stat, du, tree, git log/status/diff/show) — redirection, pipes, chaining, and anything that mutates state are rejected.\nDo NOT call write, edit, apply_patch, git_commit, or git_branch — they are disabled and calls to them are denied.\nCall tools through the native tool-call mechanism only — never write <tool_call> markup inside your reply text.`
          : opts.dynamicSystemRef.current;
        // Live task-list + intent rules + codebase context (repo map,
        // conventions, followed files) move OUT of the system message and
        // into a persisted contextNoteMessage() appended to real history
        // instead: all of these change on most steps (a completed todo, a
        // newly tagged component, a file the agent just edited), and baking
        // any of them into the system prefix would invalidate the engine's
        // KV-cache reuse (and cacheSystem's cache_control breakpoint) for
        // the entire growing history on every such step — exactly the
        // mechanism that used to make this run's system prompt change on
        // nearly every mutating tool call (codebaseContextRef used to be
        // inlined into dynamicSystemRef and re-set by refreshRepoMap()
        // after every one). The note is appended as real history (not
        // recomputed and dropped) because a discarded trailing note has the
        // same effect: the next request is never a byte extension of what
        // the engine actually generated against, so its own continuation
        // cache never matches either — see contextNoteMessage.
        const turnContext = [intentRulesBlock, todoSystemBlock(opts.todosRef.current), opts.codebaseContextRef.current].filter(Boolean).join('\n\n');
        opts.todosRevAtReqStartRef.current = opts.todosRevRef.current;
        const contextNote = contextNoteMessage(turnContext);
        if (contextNote) {
          currentMessages = [...currentMessages, contextNote];
          opts.updateRunMessages((prev) => [...prev, contextNote]);
        }
        // Adopt packForRequest's result as real history instead of a
        // wire-only view: packForRequest is pure (never mutates its input)
        // specifically so a caller can choose either — but a wire-only view
        // means the FIRST turn a given tool result crosses the packing
        // threshold, that turn's prompt has a message shrink out from under
        // it relative to what the engine actually cached from the previous
        // turn, which breaks continuation matching for that entire request
        // (confirmed empirically: an otherwise-60% cache hit turn drops to
        // 0% the moment one earlier tool result gets packed on the wire but
        // not in history). Since a new tool result crosses that threshold on
        // nearly every turn of a real tool-heavy run, that 0% was chronic,
        // not a one-off. Persisting it — via the same "replace this message
        // object in place" mirroring already used for assistant-turn edits
        // above — makes each pack transition a one-time, permanent part of
        // history, so every later request is a true extension again. The
        // placeholder text itself remains human-readable and points at
        // obs_recall, so nothing is actually lost from the transcript.
        const packedMessages = await packForRequest(currentMessages);
        if (packedMessages !== currentMessages) {
          const replaced = new Map<ChatMessage, ChatMessage>();
          packedMessages.forEach((m, i) => {
            if (m !== currentMessages[i]) replaced.set(currentMessages[i], m);
          });
          currentMessages = packedMessages;
          opts.updateRunMessages((prev) => prev.map((m) => replaced.get(m) ?? m));
        }
        const wireMessages = currentMessages;
        const turnParams = {
          thinking: opts.coderParams.thinking,
          reasoningEffort: opts.coderParams.thinkLevel,
          temperature: opts.coderParams.temperature,
          topP: opts.coderParams.topP,
          topK: opts.coderParams.topK,
          seed: opts.coderParams.seed,
          maxTokens: respMax,
        } as ChatParams;

        let attempt = 0;
        let turn: TurnResult | null = null;
        let streamErrorMsg: string | null = null;
        while (!turn && attempt < MAX_ATTEMPTS) {
          attempt++;
          try {
            turn = await streamTurn({
              model,
              system,
              messages: wireMessages,
              params: turnParams,
              tools: activeTools,
              cacheSystem: opts.coderParams.promptCache,
              signal: opts.abortRef.current.signal,
              stream: async (r, sig, cb) => {
                const primaryConfig = resolveProviderConfig('primary', opts.appConfig, {
                  primaryProvider: opts.coderParams.primaryProvider,
                  primaryCloudModel: opts.coderParams.primaryCloudModel,
                });
                const streamOpts = {
                  source: primaryConfig.source,
                  baseUrl: primaryConfig.baseUrl,
                  apiKey: primaryConfig.apiKey,
                  extraHeaders: primaryConfig.extraHeaders,
                  allowFallback: opts.appConfig?.cloudFallbackToLocal !== false,
                };
                if (opts.stream) {
                  await opts.stream(r, sig, 'coder', cb, streamOpts);
                  return;
                }
                await streamChat(r, sig, cb, streamOpts);
              },
              onStreamError: (msg) => {
                streamErrorMsg = msg;
              },
            });
          } catch (e) {
            if (opts.abortRef.current?.signal.aborted) throw e;
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt >= MAX_ATTEMPTS) {
              opts.addLog({
                type: 'error',
                label: 'retry',
                detail: `stream failed after ${MAX_ATTEMPTS} attempts: ${msg}`,
              });
              throw e;
            }
            opts.addLog({
              type: 'error',
              label: 'retry',
              detail: `stream failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${msg}`,
            });
            await new Promise((r) => setTimeout(r, 800 * attempt));
          }
        }
        if (!turn) throw new Error('stream produced no turn without throwing');

        content = turn.content;
        reasoning = turn.reasoning;
        toolCalls = turn.toolCalls;
        finishReason = turn.finishReason;
        opts.noteRunTokens(turn.meta?.promptTokens ?? est);
        if (turn.recoveredFromMarkup) {
          const declared = activeTools.map((t) => t.function.name);
          opts.addLog({
            type: 'error',
            label: 'markup',
            detail: `recovered ${toolCalls.length} tool call(s) from ${
              turn.recoveredFromMarkup
            } markup${turn.dropped.length ? `; dropped undeclared: ${turn.dropped.join(', ')}` : ''}`,
          });
          if (turn.dropped.length) {
            content += `\n\n[System: your tool-call markup for ${turn.dropped.join(
              ', '
            )} was ignored — those tools are not available right now. Available tools: ${declared.join(
              ', '
            )}. Use the native tool-call format.]`;
          }
        }

        const isEmptyResponse = !content.trim() && toolCalls.length === 0;
        if (isEmptyResponse) {
          const errorDetail = streamErrorMsg
            ? streamErrorMsg
            : 'Model returned an empty response (no content or tool calls).';
          opts.addLog({
            type: 'error',
            label: 'empty',
            detail: `${errorDetail} — stopping turn.`,
          });
          const errAssistantMsg: ChatMessage = {
            role: 'assistant',
            content: `⚠️ *${errorDetail}*`,
            error: true,
          };
          currentMessages = [...currentMessages, errAssistantMsg];
          opts.updateRunMessages((prev) => [...prev, errAssistantMsg]);
          break;
        }

        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content,
          reasoning: reasoning || undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        };

        currentMessages = [...currentMessages, assistantMsg];
        opts.updateRunMessages((prev) => [...prev, assistantMsg]);

        if (opts.coderParams.humanize && toolCalls.length === 0 && assistantMsg.content.trim()) {
          try {
            const humanized = await humanizePassText(assistantMsg.content, {
              voice: effectiveVoice({ ...opts.coderParams, humanize: true }, 'technical'),
              signal: opts.abortRef.current?.signal,
              rewrite: (current) =>
                humanizeRewriteText({
                  model,
                  baseUrl: primaryConfig.baseUrl,
                  apiKey: primaryConfig.apiKey,
                  extraHeaders: primaryConfig.extraHeaders,
                  baseSystem: opts.dynamicSystemRef.current,
                  priorMessages: currentMessages.slice(0, currentMessages.length - 1),
                  originalText: current,
                  params: {
                    thinking: opts.coderParams.thinking,
                    humanize: true,
                    voiceProfile: opts.coderParams.voiceProfile || 'technical',
                  },
                  signal: opts.abortRef.current?.signal,
                }),
            });
            if (humanized.trim() !== assistantMsg.content.trim()) {
              const updated: ChatMessage = { ...assistantMsg, content: humanized };
              currentMessages = currentMessages.map((m) => (m === assistantMsg ? updated : m));
              opts.updateRunMessages((prev) => prev.map((m) => (m === assistantMsg ? updated : m)));
            }
          } catch {
            /* keep original */
          }
        }

        if (toolCalls.length > 0) {
          const before = currentMessages.length;
          currentMessages = await opts.handleToolCalls(toolCalls, currentMessages, async () => {
            await opts.refreshRepoMap();
            await opts.tabs.refreshOpenTabs();
            await opts.tabs.refreshGitStatus();
            opts.git.loadBranches();
          });
          opts.git.loadCommits();
          opts.updateRunMessages((prev) => [...prev, ...currentMessages.slice(before)]);
          if (opts.askRef.current) {
            const q = opts.askRef.current;
            opts.askRef.current = null;
            opts.askConvRef.current = opts.runConvRef.current;
            opts.setPendingQuestion(q);
            opts.addLog({ type: 'ask', label: 'ask_user', detail: q });
            return;
          }
        } else if (finishReason === 'length' && continueCount < MAX_CONTINUE) {
          continueCount++;
          opts.addLog({
            type: 'error',
            label: 'continue',
            detail: `reply hit the token limit — continuing (${continueCount}/${MAX_CONTINUE})`,
          });
          currentMessages = [
            ...currentMessages,
            {
              role: 'user',
              displayName: 'Continue',
              collapsed: true,
              content:
                'Continue your previous response exactly where it left off. Do not repeat any text you already wrote, and do not add any preamble or acknowledgement.',
            },
          ];
          opts.updateRunMessages((prev) => [...prev, currentMessages[currentMessages.length - 1]]);
          continue;
        } else {
          let bounced = false;
          if (opts.verifyMode && repairCount < MAX_REPAIR) {
            const v = await opts.runPostEditChecks({}, '', opts.abortRef.current?.signal);
            if (v.linter_error || v.test_error) {
              repairCount++;
              const summary = String(v.linter_error || v.test_error || '').slice(0, 2500);
              opts.addLog({
                type: 'error',
                label: 'verify',
                detail: `checks failing — sending back to fix (${repairCount}/${MAX_REPAIR})`,
              });
              currentMessages = [
                ...currentMessages,
                {
                  role: 'user',
                  displayName: 'Verify',
                  collapsed: true,
                  content: `VERIFICATION GATE: the project's lint/test checks are still failing. You must fix them before the task is complete — do not declare success. Re-run the checks after fixing.\n\n${summary}`,
                },
              ];
              opts.updateRunMessages((prev) => [...prev, currentMessages[currentMessages.length - 1]]);
              bounced = true;
            }
          }
          if (!bounced && opts.criticMode && criticBudget < MAX_CRITIC) {
            let d = '';
            try {
              d = runStartHead
                ? (
                    await coderExec(
                      `git --no-pager diff ${runStartHead}`,
                      undefined,
                      60000,
                      undefined,
                      false,
                      undefined,
                      opts.activeWsDir
                    )
                  ).stdout || ''
                : (await coderDiff(opts.activeWsDir)).diff || '';
            } catch {
              d = '';
            }
            if (d.trim()) {
              const c = await opts.runCritic(d, taskText, opts.abortRef.current?.signal);
              if (c.learnings.length) {
                await opts.persistLearnings(c.learnings, c.approved ? 'critic:approve' : 'critic:reject', taskText);
              }
              if (!c.approved) {
                criticBudget++;
                opts.addLog({
                  type: 'error',
                  label: 'critic',
                  detail: `review rejected (${criticBudget}/${MAX_CRITIC}) — sending back to fix`,
                });
                currentMessages = [
                  ...currentMessages,
                  {
                    role: 'user',
                    displayName: 'Critic',
                    collapsed: true,
                    content: `CODE REVIEW REJECTED: a reviewer found issues with your changes. Address every point below, then continue — do not declare success until the review passes.\n\n${c.issues}`,
                  },
                ];
                opts.updateRunMessages((prev) => [...prev, currentMessages[currentMessages.length - 1]]);
                bounced = true;
              } else {
                opts.addLog({ type: 'todo', label: 'critic', detail: 'review passed' });
              }
            }
          }
          if (bounced) continue;
          // No suggestFollowUps call here (unlike ChatScreen's plain chat
          // loop): it's a separate request to the same local engine, with
          // its own system prompt, that doesn't extend this run's
          // continuation — it only competes with it for the same small
          // device-state/catalog slots right as the run ends, same failure
          // mode as the scout probes and task-tagger call above.
          break;
        }
      }
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        const msg = err instanceof Error ? err.message : String(err);
        opts.addLog({ type: 'error', label: 'System Error', detail: msg });
        opts.updateRunMessages((prev) => [
          ...prev,
          { role: 'assistant', displayName: 'System', content: `[Run failed: ${msg}]`, error: true },
        ]);
      }
    } finally {
      const finishedConv = opts.runConvRef.current;
      const wasPaused = opts.askConvRef.current !== null;
      opts.setRunning(false);
      opts.abortRef.current = null;
      opts.setRunConv(null);
      if (finishedConv && !opts.stoppedRef.current && !wasPaused) {
        const pending = opts.queuedRef.current[finishedConv.convId];
        if (pending && pending.length > 0) {
          const [item, ...rest] = pending;
          opts.setQueued((q) => ({ ...q, [finishedConv.convId]: rest }));
          const base =
            opts.storeRef.current.workspaces[finishedConv.ws]?.conversations[finishedConv.convId]?.messages ?? [];
          const msg: ChatMessage = {
            role: 'user',
            content: item.text,
            attachments: item.attachments.length ? item.attachments : undefined,
          };
          opts.setStore((prev) => {
            const wsd = prev.workspaces[finishedConv.ws];
            const meta = wsd?.conversations[finishedConv.convId];
            if (!wsd || !meta) return prev;
            return {
              ...prev,
              workspaces: {
                ...prev.workspaces,
                [finishedConv.ws]: {
                  ...wsd,
                  conversations: {
                    ...wsd.conversations,
                    [finishedConv.convId]: {
                      ...meta,
                      messages: [...(meta.messages ?? []), msg],
                      updatedAt: Date.now(),
                    },
                  },
                },
              },
            };
          });
          if (
            finishedConv.ws === opts.storeRef.current.activeWs &&
            finishedConv.convId === opts.storeRef.current.activeConv
          ) {
            opts.setMessages((prev) => [...prev, msg]);
          }
          runAgent(compactedContext(base).concat(msg), { scout: true, pin: finishedConv });
        }
      }
    }
  };

  return { runAgent };
}
