import { useCallback } from 'react';
import {
  getStatus,
  coderDiff,
  coderMemoryAddLearning,
  buildChatRequest,
  streamChat,
} from '../lib/api';
import { agentRunsApi, RunStream } from '../lib/agentRuns';
import type { CoderMemory } from '../lib/api/coder';
import {
  TOOLS,
  filterToolAllowList,
  filterToolsByConfig,
} from '../lib/coderTools';
import { resolveProviderConfig } from '../lib/chatHelpers';
import type { CoderParams } from '../components/coder/CoderComposer';
import type { LogEntry } from '../lib/coderStore';
import type { ChatParams } from '../lib/types';

export interface UseCoderSubagentsOptions {
  activeWsDir: string;
  activeWs: string;
  jobs: {
    registerSub: (sub: { id: string; label: string; task: string; ws: string }) => void;
    unregisterSub: (id: string) => void;
  };
  appConfig: any;
  coderParams: CoderParams;
  dynamicSystemRef: React.RefObject<string>;
  requestApproval: (tool: string, detail: string) => Promise<boolean>;
  addLog: (entry: Omit<LogEntry, 'id' | 'time'>) => void;
  memoryRef: React.RefObject<CoderMemory>;
}

export function useCoderSubagents({
  activeWsDir,
  activeWs,
  jobs,
  appConfig,
  coderParams,
  dynamicSystemRef,
  requestApproval,
  addLog,
  memoryRef,
}: UseCoderSubagentsOptions) {
  const engineMaxConcurrency = useCallback(async (): Promise<number> => {
    try {
      const s = await getStatus();
      const mc = s?.lastStart?.profile?.maxConcurrency;
      if (typeof mc === 'number' && mc > 0) return mc;
    } catch {
      /* unknown — fail closed below */
    }
    return 1;
  }, []);

  const runSubagentInner = useCallback(
    async (
      label: string,
      prompt: string,
      model: string,
      signal: AbortSignal,
      maxSteps = 6,
      allowedTools?: string[],
      depth = 0
    ): Promise<string> => {
      if (depth > 5) return '(subagent failed: maximum depth 5 exceeded)';
      const allowed = allowedTools
        ? new Set(allowedTools)
        : new Set(['read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'browser']);
      const SCOUT_CAPABLE = new Set(['read', 'grep', 'glob', 'ast_grep', 'web_fetch', 'web_search', 'browser', 'obs_recall']);
      const names = [...allowed].filter((n) => SCOUT_CAPABLE.has(n));
      if (!names.includes('delegate')) names.push('delegate');
      const rawTools = TOOLS.filter((t) => names.includes(t.function.name));
      const tools = filterToolAllowList(filterToolsByConfig(rawTools, appConfig), allowed);
      let id: string | null = null;
      const stop = () => {
        if (id) agentRunsApi.stop(id).catch(() => {});
      };
      try {
        const subConfig = resolveProviderConfig('subagent', appConfig, {
          provider: coderParams.subagentProvider,
          cloudModel: coderParams.subagentCloudModel,
        }, model);
        const subProvider = subConfig.baseUrl ? 'cloud' : 'local';
        const started = await agentRunsApi.start({
          messages: [{ role: 'user', content: prompt }],
          kind: 'scout',
          label: `scout: ${label}`,
          model: subConfig.model,
          baseUrl: subConfig.baseUrl,
          apiKey: subConfig.apiKey,
          system: dynamicSystemRef.current ?? undefined,
          maxSteps,
          toolSet: 'coder',
          toolNames: names,
          tools,
          params: {
            thinking: coderParams.thinking,
            reasoningEffort: coderParams.thinkLevel,
            temperature: coderParams.temperature,
            topP: coderParams.topP,
            topK: coderParams.topK,
            seed: coderParams.seed,
            maxTokens: 2048,
          },
          scope: activeWsDir,
        });
        id = started.id;
        if (signal.aborted) {
          stop();
          return `(subagent ${label} aborted)`;
        }
        signal.addEventListener('abort', stop, { once: true });
        try {
          const stream = new RunStream(
            id,
            () => {},
            (ev: any) => {
              if (signal.aborted || ev.type !== 'approval_requested') return;
              const a = ev as unknown as { id: string; tool: string; rel: string | null; args: string };
              const detail = a.rel ?? a.args.slice(0, 160);
              void (async () => {
                addLog({ type: 'ask', label: a.tool, detail: `[subagent] ${detail}` });
                const ok = signal.aborted ? false : await requestApproval(a.tool, detail);
                addLog({ type: ok ? 'bash' : 'error', label: a.tool, detail: ok ? `approved: ${detail}` : `denied: ${detail}` });
                await agentRunsApi.approve(id as string, a.id, ok ? 'approve' : 'deny').catch(() => {});
              })();
            },
            () => {}
          );
          await stream.attach();
          const snap = await agentRunsApi.get(id);
          if (snap.stop === 'aborted' || snap.status === 'stopped' || signal.aborted) return `(subagent ${label} aborted)`;
          if (snap.status === 'error') return `(subagent ${label} failed: ${snap.error ?? 'unknown error'})`;
          if (snap.stop === 'steps') return '(subagent step budget reached)';
          const last = [...snap.messages].reverse().find((m) => m.role === 'assistant' && (m.content ?? '').trim());
          return ((last?.content as string) ?? '').trim() || '(no findings)';
        } finally {
          signal.removeEventListener('abort', stop);
        }
      } catch (e) {
        stop();
        return `(subagent ${label} failed: ${e instanceof Error ? e.message : String(e)})`;
      }
    },
    [activeWsDir, appConfig, coderParams, dynamicSystemRef, addLog, requestApproval]
  );

  const runSubagent = useCallback(
    async (
      label: string,
      prompt: string,
      model: string,
      signal: AbortSignal,
      maxSteps = 6,
      allowedTools?: string[],
      depth = 0
    ): Promise<string> => {
      if (depth > 5) return '(subagent failed: maximum depth 5 exceeded)';
      const subId = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
      jobs.registerSub({ id: subId, label, task: prompt.replace(/^Task: /, '').slice(0, 100), ws: activeWsDir });
      try {
        return await runSubagentInner(label, prompt, model, signal, maxSteps, allowedTools, depth);
      } finally {
        jobs.unregisterSub(subId);
      }
    },
    [activeWsDir, jobs, runSubagentInner]
  );

  const runIdeation = useCallback(
    async (task: string, fallbackModel: string, signal: AbortSignal): Promise<string> => {
      const subConfig = resolveProviderConfig('subagent', appConfig, {
        subagentProvider: coderParams.subagentProvider,
        subagentCloudModel: coderParams.subagentCloudModel,
      }, fallbackModel);
      let out = '';
      try {
        await streamChat(
          buildChatRequest(
            subConfig.model,
            'You are an IDEATION pass before implementation. Do NOT write any code and do NOT solve the task. Identify the core difficulty, then list 2-4 genuinely distinct candidate approaches (different algorithms/data structures/designs -- not variations of one idea), noting a pitfall for each. Prose only, no code blocks, under 250 words.',
            [{ role: 'user', content: `TASK:\n${task}` }],
            { thinking: coderParams.thinking, reasoningEffort: coderParams.thinkLevel, temperature: 0.4, maxTokens: 1024 } as ChatParams,
            {},
            coderParams.promptCache
          ),
          signal,
          {
            onContentDelta: (t: string) => {
              out += t;
            },
          },
          { baseUrl: subConfig.baseUrl, apiKey: subConfig.apiKey }
        );
      } catch {
        /* best-effort */
      }
      return out.trim();
    },
    [appConfig, coderParams]
  );

  const summarizeCutoff = useCallback(
    async (partial: string, fallbackModel: string, signal: AbortSignal): Promise<string> => {
      const snippet = partial.length <= 9000 ? partial : `${partial.slice(0, 3500)}\n...[middle omitted]...\n${partial.slice(-5500)}`;
      const subConfig = resolveProviderConfig('subagent', appConfig, {
        subagentProvider: coderParams.subagentProvider,
        subagentCloudModel: coderParams.subagentCloudModel,
      }, fallbackModel);
      let out = '';
      try {
        await streamChat(
          buildChatRequest(
            subConfig.model,
            "A worker's reply was CUT OFF by the token limit mid-generation. Summarize its partial attempt in 3-5 sentences: which approach it was pursuing, what it established, how far it got, and what remains unfinished. Do not try to finish the work yourself.",
            [{ role: 'user', content: `CUT-OFF ATTEMPT:\n${snippet}` }],
            { thinking: coderParams.thinking, reasoningEffort: coderParams.thinkLevel, maxTokens: 512 } as ChatParams,
            {},
            coderParams.promptCache
          ),
          signal,
          {
            onContentDelta: (t: string) => {
              out += t;
            },
          },
          { baseUrl: subConfig.baseUrl, apiKey: subConfig.apiKey }
        );
      } catch {
        /* best-effort */
      }
      return out.trim() || '(the cut-off attempt could not be summarized)';
    },
    [coderParams]
  );

  const runWorker = useCallback(
    async (
      label: string,
      prompt: string,
      model: string,
      signal: AbortSignal,
      maxSteps = 8,
      allowedTools?: string[],
      depth = 0
    ): Promise<{ summary: string; diff: string; ok: boolean }> => {
      if (depth > 5) return { summary: '(worker failed: maximum depth 5 exceeded)', diff: '', ok: false };
      const subId = `worker-${label}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
      jobs.registerSub({ id: subId, label: `worker:${label}`, task: prompt.replace(/^Task: /, '').slice(0, 100), ws: activeWsDir });
      try {
        const allowed = allowedTools ? new Set(allowedTools) : new Set(['read', 'grep', 'glob', 'ast_grep', 'edit', 'apply_patch', 'write', 'cmd']);
        const WORKER_CAPABLE = new Set(['read', 'grep', 'glob', 'ast_grep', 'edit', 'apply_patch', 'write', 'cmd', 'obs_recall']);
        const names = [...allowed].filter((n) => WORKER_CAPABLE.has(n));
        const rawTools = TOOLS.filter((t) => names.includes(t.function.name));
        const tools = filterToolAllowList(filterToolsByConfig(rawTools, appConfig), allowed);
        const subConfig = resolveProviderConfig('subagent', appConfig, {
          provider: coderParams.subagentProvider,
          cloudModel: coderParams.subagentCloudModel,
        }, model);
        const started = await agentRunsApi.start({
          messages: [{ role: 'user', content: prompt }],
          kind: 'worker',
          label: `worker: ${label}`,
          model: subConfig.model,
          baseUrl: subConfig.baseUrl,
          apiKey: subConfig.apiKey,
          system: dynamicSystemRef.current ?? undefined,
          maxSteps,
          toolSet: 'coder',
          toolNames: names,
          tools,
          params: {
            thinking: coderParams.thinking,
            reasoningEffort: coderParams.thinkLevel,
            temperature: coderParams.temperature,
            topP: coderParams.topP,
            topK: coderParams.topK,
            seed: coderParams.seed,
            maxTokens: 4096,
          },
          scope: activeWsDir,
        });
        const id = started.id;
        const stop = () => {
          agentRunsApi.stop(id).catch(() => {});
        };
        if (signal.aborted) {
          stop();
          return { summary: '(worker aborted)', diff: '', ok: false };
        }
        signal.addEventListener('abort', stop, { once: true });
        try {
          const stream = new RunStream(
            id,
            () => {},
            (ev: any) => {
              if (signal.aborted || ev.type !== 'approval_requested') return;
              const a = ev as unknown as { id: string; tool: string; rel: string | null; args: string };
              const detail = a.rel ?? a.args.slice(0, 160);
              void (async () => {
                addLog({ type: 'ask', label: a.tool, detail: `[worker] ${detail}` });
                const ok = signal.aborted ? false : await requestApproval(a.tool, detail);
                addLog({ type: ok ? 'bash' : 'error', label: a.tool, detail: ok ? `approved: ${detail}` : `denied: ${detail}` });
                await agentRunsApi.approve(id, a.id, ok ? 'approve' : 'deny').catch(() => {});
              })();
            },
            () => {}
          );
          await stream.attach();
          const snap = await agentRunsApi.get(id);
          const diffRes = await coderDiff(activeWsDir).catch(() => ({ diff: '' }));
          const diff = diffRes.diff ?? '';
          if (snap.stop === 'aborted' || snap.status === 'stopped' || signal.aborted)
            return { summary: `(worker ${label} aborted)`, diff, ok: false };
          if (snap.status === 'error')
            return { summary: `(worker ${label} failed: ${snap.error ?? 'unknown error'})`, diff, ok: false };
          const last = [...snap.messages].reverse().find((m) => m.role === 'assistant' && (m.content ?? '').trim());
          let summary = ((last?.content as string) ?? '').trim();
          if (snap.stop === 'max_tokens' && summary) {
            const sumNote = await summarizeCutoff(summary, model, signal);
            summary = `${summary}\n\n[SYSTEM NOTE: worker output truncated at max_tokens. Summary of partial attempt: ${sumNote}]`;
          }
          return { summary: summary || '(worker completed with no summary)', diff, ok: true };
        } finally {
          signal.removeEventListener('abort', stop);
        }
      } catch (e) {
        return { summary: `(worker ${label} failed: ${e instanceof Error ? e.message : String(e)})`, diff: '', ok: false };
      } finally {
        jobs.unregisterSub(subId);
      }
    },
    [activeWsDir, appConfig, coderParams, dynamicSystemRef, jobs, addLog, requestApproval, summarizeCutoff]
  );

  const runCritic = useCallback(
    async (
      diff: string,
      taskText: string
    ): Promise<{ approved: boolean; issues: string; learnings: any[] }> => {
      const fallbackModel = coderParams.criticModel || 'qwen-coder';
      const subConfig = resolveProviderConfig('subagent', appConfig, {
        subagentProvider: coderParams.subagentProvider,
        subagentCloudModel: coderParams.subagentCloudModel,
      }, fallbackModel);
      const prompt = `CRITIC REVIEW:\nTask: ${taskText.slice(0, 1500)}\n\nDiff to review:\n${diff.slice(0, 12000)}`;
      let out = '';
      try {
        const ctrl = new AbortController();
        await streamChat(
          buildChatRequest(
            subConfig.model,
            'You are a rigorous code critic. Review the given diff against the task description. If acceptable, reply ONLY with "APPROVED". If there are issues, list them concisely.',
            [{ role: 'user', content: prompt }],
            { thinking: coderParams.thinking, reasoningEffort: coderParams.thinkLevel, temperature: 0.2, maxTokens: 1024 } as ChatParams,
            {},
            coderParams.promptCache
          ),
          ctrl.signal,
          {
            onContentDelta: (t: string) => {
              out += t;
            },
          },
          { baseUrl: subConfig.baseUrl, apiKey: subConfig.apiKey }
        );
      } catch {
        return { approved: true, issues: '', learnings: [] };
      }
      const text = out.trim();
      if (text.toUpperCase().startsWith('APPROVED')) {
        return { approved: true, issues: '', learnings: [] };
      }
      return { approved: false, issues: text, learnings: [] };
    },
    [appConfig, coderParams]
  );

  const persistLearnings = useCallback(
    async (learnings: any[], provenance: string, taskText: string): Promise<void> => {
      if (!learnings.length) return;
      for (const item of learnings) {
        try {
          const updated = await coderMemoryAddLearning({
            text: item.rule || item.text || '',
            kind: item.kind || 'user_rule',
            scope: item.scope || 'workspace',
            provenance,
            task: taskText,
          });
          if (memoryRef.current) {
            memoryRef.current.learnings = updated.learnings;
          }
        } catch {
          /* best-effort */
        }
      }
    },
    [memoryRef]
  );

  return {
    engineMaxConcurrency,
    runSubagent,
    runWorker,
    runIdeation,
    runCritic,
    persistLearnings,
  };
}
