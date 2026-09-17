// Deep research: concurrency-gated fan-out, the same orchestrator-workers
// shape as Coder's Scout pre-pass (CoderScreen.tsx's SCOUT_PROBES/
// runSubagent), simplified for Chat's workspace-independent tool set. A
// quick planning call breaks the question into up to `maxAngles`
// independent angles; each angle runs as its own small, tool-restricted
// server-side run (the control plane owns the loop now — runs survive
// window close) — in parallel when hitting a cloud endpoint, sequentially
// on the local engine to avoid evicting the main conversation's KV cache;
// the findings are combined into one report string the caller injects as
// context for the final answer.

import { buildChatRequest, streamChat } from './api';
import { CHAT_TOOLS, CHAT_BROWSER_TOOL } from './chatHelpers';
import { agentRunsApi, isTerminalStatus } from './agentRuns';
import type { ChatParams } from './types';

const RESEARCH_PLANNER_SYSTEM = (maxAngles: number) => `You are planning a deep-research pass for a user's question. Break the question into up to ${maxAngles} independent research angles — each answerable on its own, together covering the question well. If the question doesn't need multiple angles, return fewer (even just 1).

Respond with ONLY a numbered list, one angle per line, nothing else:
1. <angle>
2. <angle>`;

/** Pure parse of the planner's raw numbered-list output into angle strings —
 *  extracted so the line-splitting/numbering-strip logic is directly
 *  unit-testable. `fallback` (the original question) is returned when
 *  nothing parseable came back, so a planning hiccup degrades to
 *  "research the whole question" rather than zero angles. */
export function parseResearchAngles(raw: string, maxAngles: number, fallback: string): string[] {
  const angles = raw
    .split('\n')
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
  return angles.length ? angles.slice(0, maxAngles) : [fallback];
}

/** Break `question` into up to `maxAngles` research angles. Best-effort:
 *  any failure, abort, or unparseable response falls back to a single
 *  angle — the question itself — so a planning hiccup degrades to "research
 *  the whole question" rather than skipping research entirely. */
async function planResearchAngles(opts: {
  model: string;
  question: string;
  maxAngles: number;
  signal?: AbortSignal;
  baseUrl?: string;
  apiKey?: string;
  extraHeaders?: string;
  source?: 'local' | 'remote';
}): Promise<string[]> {
  const plannerParams: ChatParams = { thinking: false, reasoningEffort: '', preserveThinking: false, maxTokens: 300 };
  const body = buildChatRequest(opts.model, RESEARCH_PLANNER_SYSTEM(opts.maxAngles), [{ role: 'user', content: opts.question.slice(0, 2000) }], plannerParams);
  const signal = opts.signal ?? AbortSignal.timeout(60_000);
  let acc = '';
  try {
    await new Promise<void>((resolve, reject) => {
      streamChat(body, signal, {
        onContentDelta: (d) => { acc += d; },
        onDone: () => resolve(),
        onError: (m) => reject(new Error(m)),
      }, { baseUrl: opts.baseUrl, apiKey: opts.apiKey, extraHeaders: opts.extraHeaders, source: opts.source });
    });
  } catch {
    return [opts.question];
  }
  if (signal.aborted) return [opts.question];
  return parseResearchAngles(acc, opts.maxAngles, opts.question);
}

const RESEARCH_ANGLE_SYSTEM = 'You are researching one specific angle of a larger question. Use the available tools to investigate, then reply with a concise findings report: the key facts, with source URLs where relevant. Do not answer the original overall question directly — just report findings for this angle.';

/** Research one angle as a small, tool-restricted server-side run
 *  (web_fetch/web_search/browser only, a short step budget) — the "worker"
 *  side of the fan-out. Best-effort: a failure/abort/empty result becomes a
 *  clearly-labeled placeholder finding rather than throwing, so one bad
 *  angle can't sink the whole Promise.all. Ask-tier approvals auto-deny
 *  (the old client registry never permission-checked these tools, so
 *  allow-with-denial-on-ask preserves its effective behavior without a UI).
 *  Abort stops the server run. */
async function runResearchAngle(opts: { model: string; angle: string; maxSteps: number; signal: AbortSignal; baseUrl?: string; apiKey?: string; extraHeaders?: string; source?: 'local' | 'remote' }): Promise<string> {
  let id: string | null = null;
  const stop = () => { if (id) agentRunsApi.stop(id).catch(() => {}); };
  try {
    const started = await agentRunsApi.start({
      messages: [{ role: 'user', content: opts.angle }],
      kind: 'research',
      label: `research: ${opts.angle.slice(0, 60)}`,
      model: opts.model,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      extraHeaders: opts.extraHeaders,
      system: RESEARCH_ANGLE_SYSTEM,
      maxSteps: opts.maxSteps,
      toolSet: 'chat',
      toolNames: ['web_fetch', 'web_search', 'browser'],
      tools: [...CHAT_TOOLS, CHAT_BROWSER_TOOL],
      params: { thinking: false, maxTokens: 1024 },
      hookMode: 'client',
    });
    id = started.id;
    if (opts.signal.aborted) { stop(); return '(aborted)'; }
    opts.signal.addEventListener('abort', stop, { once: true });
    try {
      for (;;) {
        if (opts.signal.aborted) { stop(); return '(aborted)'; }
        const snap = await agentRunsApi.get(id);
        if (isTerminalStatus(snap.status)) {
          if (snap.stop === 'aborted') return '(aborted)';
          if (snap.status === 'error') return `(research failed: ${snap.error ?? 'unknown error'})`;
          const last = [...snap.messages].reverse().find((m) => m.role === 'assistant' && (m.content ?? '').trim());
          return last?.content?.trim() || '(no findings)';
        }
        for (const a of snap.pendingApprovals ?? []) {
          await agentRunsApi.approve(id, a.id, 'deny').catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      opts.signal.removeEventListener('abort', stop);
    }
  } catch (e) {
    stop();
    return `(research failed: ${e instanceof Error ? e.message : String(e)})`;
  }
}

export interface DeepResearchResult {
  angles: string[];
  /** One combined report string, ready to inject as context — "" if every angle failed. */
  report: string;
}

/** Full fan-out: plan angles, research each, combine into one report.
 *  Angles run in parallel only when `baseUrl` points at a real cloud
 *  endpoint — a local engine's KV cache is a single shared budget, and
 *  concurrent angles with unrelated prefixes evict the main conversation's
 *  cached tokens (the same failure mode Scout had). Local angles run
 *  sequentially instead, trading fan-out speed for cache locality. */
export async function runDeepResearch(opts: {
  model: string;
  question: string;
  maxAngles: number;
  maxStepsPerAngle?: number;
  signal: AbortSignal;
  baseUrl?: string;
  apiKey?: string;
  extraHeaders?: string;
  source?: 'local' | 'remote';
}): Promise<DeepResearchResult> {
  const { baseUrl, apiKey, extraHeaders, source } = opts;
  const angles = await planResearchAngles({ model: opts.model, question: opts.question, maxAngles: opts.maxAngles, signal: opts.signal, baseUrl, apiKey, extraHeaders, source });
  if (opts.signal.aborted) return { angles, report: '' };
  const runAngle = (angle: string) =>
    runResearchAngle({ model: opts.model, angle, maxSteps: opts.maxStepsPerAngle ?? 5, signal: opts.signal, baseUrl, apiKey, extraHeaders, source });
  let findings: string[];
  if (baseUrl) {
    findings = await Promise.all(angles.map(runAngle));
  } else {
    findings = [];
    for (const angle of angles) {
      if (opts.signal.aborted) break;
      findings.push(await runAngle(angle));
    }
  }
  if (opts.signal.aborted) return { angles, report: '' };
  const report = angles.map((angle, i) => `## ${angle}\n${findings[i]}`).join('\n\n');
  return { angles, report };
}
