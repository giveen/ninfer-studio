// Deep research: concurrency-gated parallel fan-out, the same
// orchestrator-workers shape as Coder's Scout pre-pass (CoderScreen.tsx's
// SCOUT_PROBES/runSubagent), simplified for Chat's workspace-independent
// tool set. A quick planning call breaks the question into up to
// `maxAngles` independent angles; each angle runs its own small,
// tool-restricted runToolLoop in parallel; the findings are combined into
// one report string the caller injects as context for the final answer.

import { runToolLoop, type ToolRegistry } from './agentLoop';
import { buildChatRequest, streamChat, coderWebFetch, coderWebSearch, coderBrowser } from './api';
import { CHAT_TOOLS, CHAT_BROWSER_TOOL } from './chatHelpers';
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
      });
    });
  } catch {
    return [opts.question];
  }
  if (signal.aborted) return [opts.question];
  return parseResearchAngles(acc, opts.maxAngles, opts.question);
}

const RESEARCH_ANGLE_SYSTEM = 'You are researching one specific angle of a larger question. Use the available tools to investigate, then reply with a concise findings report: the key facts, with source URLs where relevant. Do not answer the original overall question directly — just report findings for this angle.';

/** Research one angle with a small, tool-restricted runToolLoop
 *  (web_fetch/web_search/browser only, a short step budget) — the "worker"
 *  side of the fan-out. Best-effort: a failure/abort/empty result becomes a
 *  clearly-labeled placeholder finding rather than throwing, so one bad
 *  angle can't sink the whole Promise.all. */
async function runResearchAngle(opts: { model: string; angle: string; maxSteps: number; signal: AbortSignal }): Promise<string> {
  const registry: ToolRegistry = {
    web_fetch: (args, signal) => coderWebFetch(String(args.url ?? ''), signal).then((r) => JSON.stringify(r)),
    web_search: (args, signal) => coderWebSearch(String(args.query ?? ''), signal).then((r) => JSON.stringify(r)),
    browser: (args, signal) =>
      coderBrowser(
        String(args.action ?? 'status'),
        { url: args.url, selector: args.selector, value: args.value, key: args.key, expression: args.expression, wait_until: args.wait_until, timeout: args.timeout } as Record<string, string | number>,
        signal,
      ).then((r) => JSON.stringify(r)),
  };
  const angleParams: ChatParams = { thinking: false, reasoningEffort: '', preserveThinking: false, maxTokens: 1024 };
  try {
    const res = await runToolLoop({
      model: opts.model,
      system: RESEARCH_ANGLE_SYSTEM,
      messages: [{ role: 'user', content: opts.angle }],
      params: angleParams,
      tools: [...CHAT_TOOLS, CHAT_BROWSER_TOOL],
      registry,
      maxSteps: opts.maxSteps,
      signal: opts.signal,
    });
    if (res.stop === 'aborted') return '(aborted)';
    const last = [...res.messages].reverse().find((m) => m.role === 'assistant');
    return last?.content.trim() || '(no findings)';
  } catch (e) {
    return `(research failed: ${e instanceof Error ? e.message : String(e)})`;
  }
}

export interface DeepResearchResult {
  angles: string[];
  /** One combined report string, ready to inject as context — "" if every angle failed. */
  report: string;
}

/** Full fan-out: plan angles, research each in parallel, combine into one
 *  report. `maxAngles` should already be `min(engineMaxConcurrency(), 3)` —
 *  this function doesn't re-check concurrency itself, since gating on
 *  whether to call it at all is the caller's job (mirrors Scout's own
 *  call-site gate). */
export async function runDeepResearch(opts: {
  model: string;
  question: string;
  maxAngles: number;
  maxStepsPerAngle?: number;
  signal: AbortSignal;
}): Promise<DeepResearchResult> {
  const angles = await planResearchAngles({ model: opts.model, question: opts.question, maxAngles: opts.maxAngles, signal: opts.signal });
  if (opts.signal.aborted) return { angles, report: '' };
  const findings = await Promise.all(
    angles.map((angle) => runResearchAngle({ model: opts.model, angle, maxSteps: opts.maxStepsPerAngle ?? 5, signal: opts.signal })),
  );
  if (opts.signal.aborted) return { angles, report: '' };
  const report = angles.map((angle, i) => `## ${angle}\n${findings[i]}`).join('\n\n');
  return { angles, report };
}
