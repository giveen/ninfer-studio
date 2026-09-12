// Shared agent-loop plumbing for ChatScreen and CoderScreen.
//
// Both screens ran independent stream → tool-call → recurse loops over the
// same engine contract (streamChat callbacks, native tool_calls, the
// <compacted-summary> checkpoint convention). This module owns the parts that
// were duplicated or near-duplicated:
//
//   compaction  — isCompactedMsg / compactedContext (were byte-identical
//                 copies in each screen)
//   markup      — parseMarkupToolCalls / stripToolMarkup (small local models
//                 emit tool calls as text instead of native tool_calls)
//   turns       — streamTurn: one streamed turn (accumulate deltas, usage,
//                 tool calls, markup recovery)
//   dispatch    — ToolRegistry + executeToolCalls (name → executor map with
//                 per-call JSON/error isolation)
//   loop        — runToolLoop: bounded turn loop shared by Chat, the
//                 read-only subagent, and the implementation worker. The
//                 supervisor keeps its own loop (plan/scout/verify/critic
//                 gates) but builds each turn on streamTurn.
//   humanize    — humanizePassText: the evaluate → rewrite retry gate both
//                 screens ran around content-only replies.
//
// The runner is UI-agnostic: screens mirror progress into their own stores
// through the onDelta / onTurnStart / onAppended events.

import { buildChatRequest, streamChat, type ChatStreamCallbacks } from './api';
import { evaluate, needsHumanize, HUMANIZE_MAX_DEPTH, type VoiceProfile } from './notai';
import type { AgentToolCall, ChatMessage, ChatParams, MessageMeta } from './types';

// ---------------------------------------------------------------------------
// Compaction checkpoints
// ---------------------------------------------------------------------------

/** A compaction checkpoint message (the engine-side <compacted-summary> block). */
export function isCompactedMsg(m: ChatMessage): boolean {
  return m.role === 'user' && typeof m.content === 'string' && m.content.includes('<compacted-summary>');
}

/** Model context for a loaded transcript: from the most recent compaction
 *  checkpoint onward, so reloading a conversation never re-inflates the full
 *  context. */
export function compactedContext(msgs: ChatMessage[]): ChatMessage[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (isCompactedMsg(msgs[i])) return msgs.slice(i);
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// Markup tool-call recovery
// ---------------------------------------------------------------------------

/** Recover tool calls a model emitted as text instead of native tool_calls —
 *  small local models commonly paste a tool invocation into content (or
 *  reasoning_content) as JSON rather than using the engine's structured
 *  field. Tries, in priority order: <tool_call> markup (JSON body, or the
 *  <function=name><parameter=k>v</parameter> XML-ish form some models use),
 *  fenced ```json/```tool_call blocks, and — only when the text is
 *  essentially nothing but JSON — a bare leading JSON object/array.
 *  Conservative by design: unrecognized JSON is left alone rather than
 *  guessed at, so a normal prose reply never gets misread. Returns both the
 *  parsed calls and the exact raw substrings consumed, so the caller can
 *  strip only those from the visible reply without touching unrelated code
 *  fences or prose. */
export function parseMarkupToolCalls(text: string): { calls: AgentToolCall[]; consumed: string[] } {
  const calls: AgentToolCall[] = [];
  const consumed: string[] = [];

  // Trailing commas are a common small-model JSON mistake — strip before parsing.
  const parseItems = (body: string): unknown[] | null => {
    const b = body.trim();
    if (!/^\s*[{[]/.test(b)) return null;
    try {
      const j = JSON.parse(b.replace(/,(\s*[}\]])/g, '$1'));
      return Array.isArray(j) ? j : [j];
    } catch { return null; }
  };
  // Normalize {name,arguments} / {function:{name,arguments}} / {tool,args} shapes.
  const coerce = (item: unknown): { name: string; args: unknown } | null => {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const fn = typeof o.function === 'object' && o.function !== null ? (o.function as Record<string, unknown>) : undefined;
    const rawName = typeof o.name === 'string' ? o.name : typeof fn?.name === 'string' ? fn.name : typeof o.tool === 'string' ? o.tool : undefined;
    if (!rawName) return null;
    return { name: rawName, args: o.arguments ?? fn?.arguments ?? o.args ?? o.parameters ?? {} };
  };
  const pushAll = (items: unknown[]): boolean => {
    let any = false;
    for (const item of items) {
      const c = coerce(item);
      if (!c) continue;
      calls.push({ id: 'markup-' + crypto.randomUUID(), name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) });
      any = true;
    }
    return any;
  };

  // 1. <tool_call>...</tool_call> — JSON body, or the <function=name> XML-ish form.
  for (const m of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) {
    const body = m[1];
    const items = parseItems(body);
    let any = items ? pushAll(items) : false;
    if (!any) {
      const fn = body.match(/<function=([\w.-]+)>/);
      if (fn) {
        const args: Record<string, unknown> = {};
        for (const p of body.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)) args[p[1]] = p[2];
        calls.push({ id: 'markup-' + crypto.randomUUID(), name: fn[1], arguments: JSON.stringify(args) });
        any = true;
      }
    }
    if (any) consumed.push(m[0]);
  }
  if (calls.length > 0) return { calls, consumed };

  // 2. Fenced ```json / ```tool_call blocks (explicitly labeled only — an
  //    unlabeled ``` fence is more likely a genuine code sample to the
  //    user). Only tried when the reply is essentially JUST the block(s)
  //    instead of a native call, not a long explanatory answer that happens
  //    to contain an illustrative JSON example partway through.
  const FENCED_RE = /```(?:json|tool_?call)\s*\n?([\s\S]*?)\n?```/g;
  const outsideFences = text.replace(FENCED_RE, '').trim();
  if (outsideFences.length <= 200) {
    for (const m of text.matchAll(FENCED_RE)) {
      const items = parseItems(m[1]);
      if (items && pushAll(items)) consumed.push(m[0]);
    }
  }
  if (calls.length > 0) return { calls, consumed };

  // 3. Bare JSON — only when the whole text is essentially nothing but JSON.
  const bare = text.trim().match(/^([{[][\s\S]+[}\]])$/);
  if (bare) {
    const items = parseItems(bare[1]);
    if (items && pushAll(items)) consumed.push(bare[1]);
  }

  return { calls, consumed };
}
export function stripToolMarkup(text: string, consumed: string[]): string {
  let out = text;
  for (const c of consumed) out = out.split(c).join('');
  return out.trim();
}

// ---------------------------------------------------------------------------
// Tool registry + dispatch
/** Parsed model args object (JSON). Handlers read fields with String()/Number()/Array checks. */
export type ToolArgs = Record<string, unknown>;

/** A tool executor: parsed args in, JSON result string out. Throwing is
+ *  allowed — executeToolCalls converts it to an error result for the model. */
export type ToolHandler = (args: ToolArgs, signal: AbortSignal) => Promise<string>;

/** Name → executor map. Chat registers web_fetch/web_search; the coder
 *  subagent/worker register their (filtered) dispatchers. */
export type ToolRegistry = Record<string, ToolHandler>;

/** Run one tool call per entry through the registry, isolating failures so
 *  one bad call (bad JSON args, unknown tool, throwing handler) becomes an
 *  error result for the model instead of killing the run. */
export async function executeToolCalls(
  calls: AgentToolCall[],
  registry: ToolRegistry,
  signal: AbortSignal,
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const call of calls) {
    let result: string;
    try {
      const handler = registry[call.name];
      if (!handler) {
        result = JSON.stringify({ error: `unknown tool: ${call.name}` });
      } else {
        const parsed: unknown = JSON.parse(call.arguments);
        const args: ToolArgs = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ToolArgs) : {};
        result = await handler(args, signal);
      }
    } catch (e) {
      result = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
    out.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Single streamed turn
// ---------------------------------------------------------------------------

/** Injectable stream backend: streamChat directly, or a wrapper (the coder's
 *  trackedStream drives the prefill/decode phase indicator). */
export type StreamFn = (
  req: Record<string, unknown>,
  signal: AbortSignal,
  cb: ChatStreamCallbacks,
) => Promise<void>;

export interface TurnResult {
  content: string;
  reasoning: string;
  toolCalls: AgentToolCall[];
  finishReason?: string;
  meta: MessageMeta;
  /** Where markup-recovered calls came from (null = native tool_calls). */
  recoveredFromMarkup: 'content' | 'reasoning' | null;
  /** Recovered names outside the offered tool set (dropped, caller may note). */
  dropped: string[];
}

/** Stream one assistant turn: accumulate deltas/usage/tool calls, then fall
 *  back to markup recovery when the model emitted calls as text. */
export async function streamTurn(opts: {
  model: string;
  system: string | undefined;
  messages: ChatMessage[];
  params: ChatParams;
  tools?: unknown[];
  cacheSystem?: boolean;
  signal: AbortSignal;
  stream?: StreamFn;
  recoverMarkup?: boolean;
  onDelta?: (kind: 'content' | 'reasoning', text: string) => void;
  onStreamError?: (message: string) => void;
}): Promise<TurnResult> {
  const { model, system, messages, params, tools, cacheSystem, signal, stream = streamChat, recoverMarkup = true, onDelta, onStreamError } = opts;
  let content = '';
  let reasoning = '';
  let toolCalls: AgentToolCall[] = [];
  let finishReason: string | undefined;
  let meta: MessageMeta = {};
  const req = buildChatRequest(
    model, system, messages, params,
    tools && tools.length ? { tools } : undefined,
    cacheSystem,
  );
  await stream(req, signal, {
    onContentDelta: (t) => { content += t; onDelta?.('content', t); },
    onReasoningDelta: (t) => { reasoning += t; onDelta?.('reasoning', t); },
    onToolCalls: (c) => { toolCalls = c; },
    onUsage: (_u, m) => { meta = m; },
    onDone: (m) => { meta = { ...meta, ...m }; finishReason = m.finishReason; },
    onError: (msg) => { onStreamError?.(msg); },
  });

  let recoveredFromMarkup: TurnResult['recoveredFromMarkup'] = null;
  let dropped: string[] = [];
  if (recoverMarkup && toolCalls.length === 0 && (content.trim() || reasoning.trim())) {
    const declared = new Set(
      (tools ?? []).map((t) => (t as { function?: { name?: string } })?.function?.name).filter((n): n is string => !!n),
    );
    let recovered = parseMarkupToolCalls(content);
    let fromReasoning = false;
    if (recovered.calls.length === 0 && !content.trim() && reasoning.trim()) {
      recovered = parseMarkupToolCalls(reasoning);
      fromReasoning = true;
    }
    const usable = recovered.calls.filter((c) => declared.has(c.name));
    if (usable.length > 0) {
      if (fromReasoning) reasoning = stripToolMarkup(reasoning, recovered.consumed);
      else content = stripToolMarkup(content, recovered.consumed);
      toolCalls = usable;
      recoveredFromMarkup = fromReasoning ? 'reasoning' : 'content';
      dropped = recovered.calls.filter((c) => !declared.has(c.name)).map((c) => c.name);
    }
  }
  return { content, reasoning, toolCalls, finishReason, meta, recoveredFromMarkup, dropped };
}

// ---------------------------------------------------------------------------
// Humanize gate
// ---------------------------------------------------------------------------

/** Deterministic tell-gate → rewrite retry loop both screens ran around
 *  content-only replies. Best-effort: a failing gate/rewrite keeps the
 *  best-so-far text, never throws the turn away. */
export async function humanizePassText(
  text: string,
  opts: {
    voice: VoiceProfile;
    signal?: AbortSignal;
    rewrite: (current: string) => Promise<string | undefined | null>;
  },
): Promise<string> {
  let current = text;
  let gateRes = evaluate(current, opts.voice, {});
  for (let attempt = 0; attempt < HUMANIZE_MAX_DEPTH && needsHumanize(gateRes); attempt++) {
    if (opts.signal?.aborted) break;
    let rewritten: string | undefined | null;
    try {
      rewritten = await opts.rewrite(current);
    } catch {
      break;
    }
    if (!rewritten || !rewritten.trim() || rewritten.trim() === current.trim()) break;
    current = rewritten.trim();
    gateRes = evaluate(current, opts.voice, {});
  }
  return current;
}

// ---------------------------------------------------------------------------
// Bounded tool loop
// ---------------------------------------------------------------------------

export type ToolLoopStop = 'done' | 'steps' | 'aborted' | 'empty' | 'halted';

export interface AssistantHook {
  /** Replacement assistant content (e.g. humanized rewrite). */
  content?: string;
  /** Extra messages appended right after the assistant turn (e.g. a
   *  cut-off digest note or a continue nudge). */
  inject?: ChatMessage[];
  /** Stop after this turn even if tool calls remain. */
  halt?: boolean;
  /** Run another turn even with no tool calls (e.g. token-limit cut-off). */
  proceed?: boolean;
}

export interface ToolLoopOptions {
  model: string;
  system: string | undefined;
  messages: ChatMessage[];
  params: ChatParams;
  /** Tool definitions offered to the model for this run. */
  tools?: unknown[];
  registry: ToolRegistry;
  maxSteps: number;
  signal: AbortSignal;
  stream?: StreamFn;
  cacheSystem?: boolean;
  recoverMarkup?: boolean;
  onDelta?: (kind: 'content' | 'reasoning', text: string, turn: number) => void;
  onTurnStart?: (turn: number) => void;
  /** Fires after each append so screens can mirror into their own stores. */
  onAppended?: (appended: ChatMessage[], turn: number) => void;
  onStreamError?: (message: string, turn: number) => void;
  /** Inspect/rewrite each finished assistant turn before dispatch. */
  onAssistantTurn?: (
    msg: ChatMessage,
    info: { turn: number; finishReason?: string; meta: MessageMeta; recoveredFromMarkup: TurnResult['recoveredFromMarkup']; dropped: string[] },
  ) => Promise<AssistantHook | void>;
}

export interface ToolLoopResult {
  messages: ChatMessage[];
  /** Completed tool cycles (content-only final turns don't consume budget). */
  turns: number;
  stop: ToolLoopStop;
  finishReason?: string;
  meta: MessageMeta;
}

/** Bounded stream → dispatch loop. Each turn streams via streamTurn,
 *  appends the assistant message, then either stops (no calls, halt, empty,
 *  abort, budget) or dispatches through the registry and continues. */
export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const { model, system, params, tools, registry, maxSteps, signal, stream, cacheSystem, recoverMarkup } = opts;
  let messages = [...opts.messages];
  let turns = 0;
  let finishReason: string | undefined;
  let meta: MessageMeta = {};
  while (turns < maxSteps) {
    if (signal.aborted) return { messages, turns, stop: 'aborted', finishReason, meta };
    opts.onTurnStart?.(turns);
    const t = await streamTurn({
      model, system, messages, params, tools, cacheSystem, signal, stream, recoverMarkup,
      onDelta: (kind, text) => opts.onDelta?.(kind, text, turns),
      onStreamError: (msg) => opts.onStreamError?.(msg, turns),
    });
    finishReason = t.finishReason;
    meta = t.meta;
    // A response with neither content nor tool calls is a no-op — don't push
    // a blank bubble into the transcript or model context, just stop cleanly.
    if (!t.content.trim() && t.toolCalls.length === 0) {
      return { messages, turns, stop: 'empty', finishReason, meta };
    }
    let assistant: ChatMessage = {
      role: 'assistant',
      content: t.content,
      ...(t.reasoning ? { reasoning: t.reasoning } : {}),
      ...(t.toolCalls.length ? { tool_calls: t.toolCalls } : {}),
    };
    const hook = await opts.onAssistantTurn?.(assistant, {
      turn: turns, finishReason: t.finishReason, meta: t.meta,
      recoveredFromMarkup: t.recoveredFromMarkup, dropped: t.dropped,
    });
    if (hook?.content !== undefined) assistant = { ...assistant, content: hook.content };
    messages = [...messages, assistant];
    opts.onAppended?.([assistant], turns);
    if (hook?.inject?.length) {
      messages = [...messages, ...hook.inject];
      opts.onAppended?.(hook.inject, turns);
    }
    if (hook?.halt) return { messages, turns, stop: 'halted', finishReason, meta };
    const proceed = hook?.proceed ?? t.toolCalls.length > 0;
    if (!proceed) return { messages, turns, stop: 'done', finishReason, meta };
    const toolMsgs = await executeToolCalls(t.toolCalls, registry, signal);
    messages = [...messages, ...toolMsgs];
    opts.onAppended?.(toolMsgs, turns);
    turns++;
  }
  return { messages, turns, stop: 'steps', finishReason, meta };
}
