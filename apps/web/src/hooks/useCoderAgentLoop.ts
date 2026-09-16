import { useRef, useCallback } from 'react';
import type { ChatMessage, AgentToolCall, ChatParams } from '../lib/types';
import type { CoderMemory } from '../lib/api/coder';
import type { LogEntry, TodoItem, CoderStore } from '../lib/coderStore';
import type { McpToolInfo } from '../lib/api';
import type { CoderParams, QueuedItem } from '../components/coder/CoderComposer';
import {
  getStatus,
  getEngineContextSize,
  summarizeConversation,
  frameCompactedSummary,
  coderExec,
  coderDiff,
  suggestFollowUps,
  buildChatRequest,
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
import { compactedContext, isCompactedMsg, humanizePassText, streamTurn, type TurnResult } from '../lib/agentLoop';
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
  runCritic: (diff: string, taskText: string) => Promise<{ approved: boolean; issues: string; learnings: any[] }>;
  persistLearnings: (learnings: any[], provenance: string, taskText: string) => Promise<void>;
  updateRunMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  noteRunTokens: (n: number) => void;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  queuedRef: React.MutableRefObject<Record<string, QueuedItem[]>>;
  setQueued: React.Dispatch<React.SetStateAction<Record<string, QueuedItem[]>>>;
  storeRef: React.MutableRefObject<CoderStore>;
  setStore: React.Dispatch<React.SetStateAction<CoderStore>>;
  engineMaxConcurrency: () => Promise<number>;
  runSubagent: (label: string, prompt: string, model: string, signal: AbortSignal, maxSteps?: number, allowedTools?: string[], depth?: number) => Promise<string>;
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

    let intentRulesBlock = '';
    try {
      const mem = opts.memoryRef.current;
      const comps = Array.from(
        new Set((mem?.learnings || []).map((l) => l.component).filter((c) => c && c !== 'general'))
      );
      let activeComponents = new Set<string>(['general']);

      const lastUserMsg =
        [...currentMessages].reverse().find((m) => m.role === 'user' && !isCompactedMsg(m))?.content || '';
      if (comps.length > 0 && lastUserMsg) {
        const taggerPrompt = `TASK: \`\`\`\n${lastUserMsg.slice(
          0,
          500
        )}\n\`\`\`\n\nWhich of the following components does this task involve? ${comps.join(
          ', '
        )}\nReply with a JSON array of strings.`;
        const taggerModel = opts.coderParams.criticModel?.trim() || opts.modelRef.current || 'qwen-coder';
        const taggerCfg = resolveProviderConfig('subagent', opts.appConfig, {
          provider: opts.coderParams.subagentProvider,
          cloudModel: opts.coderParams.subagentCloudModel,
        }, taggerModel);
        const req = buildChatRequest(
          taggerCfg.model,
          'You are a task categorizer. Reply only with a JSON array of matching component strings.',
          [{ role: 'user', content: taggerPrompt }],
          { thinking: false, maxTokens: 100 } as ChatParams,
          {}
        );
        let textContent = '';
        await streamChat(req, new AbortController().signal, {
          onContentDelta: (t: string) => {
            textContent += t;
          },
        }, {
          baseUrl: taggerCfg.baseUrl,
          apiKey: taggerCfg.apiKey,
          extraHeaders: taggerCfg.extraHeaders,
          allowFallback: opts.appConfig?.cloudFallbackToLocal !== false,
        });
        const jsonMatch = textContent.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          for (const c of parsed) activeComponents.add(c);
        }
      }

      if (mem && mem.learnings.length > 0) {
        const byComponent: Record<string, any[]> = {};
        for (const l of mem.learnings) {
          const comp = l.component || 'general';
          if (!activeComponents.has(comp) && activeComponents.size > 1) continue;
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
      const mc = await opts.engineMaxConcurrency();
      const subConfig = resolveProviderConfig('subagent', opts.appConfig, {
        provider: opts.coderParams.subagentProvider,
        cloudModel: opts.coderParams.subagentCloudModel,
      }, model);
      const isCloudSub = !!subConfig.baseUrl;

      if (!opts.abortRef.current?.signal.aborted) {
        const task =
          [...currentMessages].reverse().find((m) => m.role === 'user' && !isCompactedMsg(m))?.content ?? '';
        const signal = opts.abortRef.current!.signal;

        let summaries: string[] = [];
        if (mc > 1 || isCloudSub) {
          opts.addLog({ type: 'read', label: 'scout', provider: isCloudSub ? 'cloud' : 'local', detail: `3 parallel probes (${isCloudSub ? 'cloud' : `engine concurrency ${mc}`})` });
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
              opts.addLog({ type: 'read', label: `scout:${p.label}`, provider: isCloudSub ? 'cloud' : 'local', detail: `${s.length} chars` });
              return `## ${p.label}\n${s}`;
            })
          );
        } else {
          opts.addLog({ type: 'read', label: 'scout', provider: 'local', detail: '3 sequential probes (local single concurrency)' });
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

    const sysTokenEstimate = Math.ceil(opts.dynamicSystemRef.current.length / CHARS_PER_TOKEN);
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
              systemPrompt: opts.dynamicSystemRef.current,
              history: currentMessages,
              maxTokens: 2048,
              signal: opts.abortRef.current?.signal,
              useLocalCompactor: opts.appConfig?.cloudUseLocalCompactor !== false,
            });
            if (!summary) throw new Error('compaction produced no summary');
            currentMessages = [{ role: 'user', content: frameCompactedSummary(summary) }];
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
        const system =
          (opts.planMode
            ? `${opts.dynamicSystemRef.current}\n\n# PLAN MODE (read-only): investigate, analyze, and propose a concrete, step-by-step plan, then stop and wait for the user.\nAvailable tools: ${planToolNames}. bash is READ-ONLY here: inspection commands only (find, ls, cat, head, tail, wc, grep, rg, file, stat, du, tree, git log/status/diff/show) — redirection, pipes, chaining, and anything that mutates state are rejected.\nDo NOT call write, edit, apply_patch, git_commit, or git_branch — they are disabled and calls to them are denied.\nCall tools through the native tool-call mechanism only — never write <tool_call> markup inside your reply text.`
            : opts.dynamicSystemRef.current) +
          intentRulesBlock +
          todoSystemBlock(opts.todosRef.current);
        opts.todosRevAtReqStartRef.current = opts.todosRevRef.current;
        const wireMessages = await packForRequest(currentMessages);
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
              stream: (r, sig, cb) => {
                const primaryConfig = resolveProviderConfig('primary', opts.appConfig, {
                  primaryProvider: opts.coderParams.primaryProvider,
                  primaryCloudModel: opts.coderParams.primaryCloudModel,
                });
                return streamChat(r, sig, cb, {
                  baseUrl: primaryConfig.baseUrl,
                  apiKey: primaryConfig.apiKey,
                  extraHeaders: primaryConfig.extraHeaders,
                  allowFallback: opts.appConfig?.cloudFallbackToLocal !== false,
                });
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
          opts.addLog({
            type: 'error',
            label: 'empty',
            detail: streamErrorMsg
              ? `${streamErrorMsg} — stopping the turn.`
              : 'Model returned an empty response (no content or tool calls) — stopping the turn.',
          });
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
              const c = await opts.runCritic(d, taskText);
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
          if (!opts.abortRef.current?.signal.aborted && finishReason !== 'length') {
            const lastAssistant = currentMessages[currentMessages.length - 1];
            if (lastAssistant?.role === 'assistant' && lastAssistant.content.trim()) {
              try {
                const followUps = await suggestFollowUps({
                  model,
                  baseUrl: primaryConfig.baseUrl,
                  apiKey: primaryConfig.apiKey,
                  extraHeaders: primaryConfig.extraHeaders,
                  history: [...wireMessages, lastAssistant],
                  signal: opts.abortRef.current?.signal,
                });
                if (!opts.abortRef.current?.signal.aborted && followUps.length) {
                  const withFollowUps: ChatMessage = { ...lastAssistant, followUps };
                  currentMessages = currentMessages.map((m) => (m === lastAssistant ? withFollowUps : m));
                  opts.updateRunMessages((prev) => prev.map((m) => (m === lastAssistant ? withFollowUps : m)));
                }
              } catch (followUpError) {
                console.warn('[coder] follow-up suggestions skipped', followUpError);
              }
            }
          }
          break;
        }
      }
    } catch (err: unknown) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (!isAbort) {
        const msg = err instanceof Error ? err.message : String(err);
        opts.addLog({ type: 'error', label: 'System Error', detail: msg });
        opts.setMessages((prev) => [
          ...prev,
          { role: 'user', displayName: 'System', content: `[Run failed: ${msg}]`, error: true },
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
