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

import {
  buildChatRequest,
  streamChat,
  streamResponses,
  knownResponsesSupport,
  paramsSupportedByResponses,
  type ChatStreamCallbacks,
} from './api';
import { localDateTimeBlock } from './chatHelpers';
import { evaluate, needsHumanize, HUMANIZE_MAX_DEPTH, type VoiceProfile } from './notai';
import type { AgentToolCall, ChatMessage, ChatParams, MessageMeta } from './types';

// ---------------------------------------------------------------------------
// Compaction checkpoints
// ---------------------------------------------------------------------------

/** A compaction checkpoint message (the engine-side <compacted-summary> block). */
export function isCompactedMsg(m: ChatMessage): boolean {
  if (m.displayName === 'Compaction Summary') return true;
  if (m.role !== 'user' || typeof m.content !== 'string') return false;
  const s = m.content.trimStart();
  return s.startsWith('<compacted-summary>') || s.startsWith('This is an automatically generated checkpoint');
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
function parseMarkupToolCalls(text: string): { calls: AgentToolCall[]; consumed: string[] } {
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
function stripToolMarkup(text: string, consumed: string[]): string {
  let out = text;
  for (const c of consumed) out = out.split(c).join('');
  return out.trim();
}

// ---------------------------------------------------------------------------
// Tool registry + dispatch
/** Parsed model args object (JSON). Handlers read fields with String()/Number()/Array checks. */
type ToolArgs = Record<string, unknown>;

/** A tool executor: parsed args in, JSON result string out. Throwing is
+ *  allowed — executeToolCalls converts it to an error result for the model. */
export type ToolHandler = (args: ToolArgs, signal: AbortSignal) => Promise<string>;

/** Name → executor map. Chat registers web_fetch/web_search; the coder
 *  subagent/worker register their (filtered) dispatchers. */
export type ToolRegistry = Record<string, ToolHandler>;

/** Run one tool call per entry through the registry, isolating failures so
 *  one bad call (bad JSON args, unknown tool, throwing handler) becomes an
 *  error result for the model instead of killing the run. */
async function executeToolCalls(
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
  opts?: { baseUrl?: string; apiKey?: string; extraHeaders?: string; allowFallback?: boolean; source?: 'local' | 'remote' }
) => Promise<void>;

/** Picks the transport for a turn that didn't request one explicitly: the
 *  Responses API when the local engine build is known to support it and `params`
 *  doesn't use a sampling knob Responses can't express, falling back to the
 *  proven Chat Completions path otherwise. Remote cloud endpoints always use streamChat. */
function resolveDefaultStreamFn(params: ChatParams, opts?: { source?: 'local' | 'remote'; baseUrl?: string }): StreamFn {
  if (opts?.source === 'remote' || !!opts?.baseUrl) return streamChat;
  return knownResponsesSupport() && paramsSupportedByResponses(params) ? streamResponses : streamChat;
}

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

/** Declared name of one tool schema (`{ function: { name } }`) — guarded read,
 *  null when the entry isn't that shape. Schemas arrive as `unknown[]`
 *  (transport-agnostic `tools?: unknown[]`), so narrow instead of casting. */
function toolNameOf(t: unknown): string | null {
  if (!t || typeof t !== 'object' || !('function' in t)) return null;
  const fn = t.function;
  if (!fn || typeof fn !== 'object' || !('name' in fn)) return null;
  return typeof fn.name === 'string' && fn.name ? fn.name : null;
}

/** Build a small persisted "context for this turn" message (date/time plus
 *  any extra per-turn text) — a real `ChatMessage` the caller appends to
 *  actual history before the turn, not a value threaded through
 *  `streamTurn`/`buildChatRequest` and discarded afterward. That older
 *  design recomputed this block fresh every turn and dropped it right
 *  after, so it never sat in front of the growing history — but the engine
 *  still generated its reply *with those exact tokens in context*. The next
 *  turn's real prompt (history + new content) was therefore never a byte
 *  extension of what the previous turn actually sent: the tail the model
 *  saw got silently swapped out from under it. Prefix/continuation caching
 *  (the engine's own KV-cache reuse, and the Anthropic-style `cache_control`
 *  breakpoint `cacheSystem` requests) only ever match a request that
 *  extends the previous one byte-for-byte, so that swap zeroed out caching
 *  for the entire history on every single turn — confirmed against the
 *  ninfer engine directly (see the fix-scout-cache-eviction branch notes).
 *  Persisting the note instead — even though its date/time stamp goes stale
 *  the moment history moves on — keeps every request a true extension of
 *  the last. Returns null when there's nothing to add. */
export function contextNoteMessage(extra?: string): ChatMessage | null {
  const text = [extra, localDateTimeBlock()].filter(Boolean).join('\n\n').trim();
  if (!text) return null;
  return {
    role: 'user',
    displayName: 'Context',
    collapsed: true,
    content: `[System context for this turn — not something the user said]\n\n${text}`,
  };
}

/** Stream one assistant turn: accumulate deltas/usage/tool calls, then fall
 *  back to markup recovery when the model emitted calls as text. Per-turn
 *  context (date/time, live todos, ...) is the caller's concern now — fold
 *  it into `messages` via `contextNoteMessage` before calling this, so it's
 *  persisted rather than reinvented and dropped each turn (see
 *  `contextNoteMessage` for why that distinction matters for caching). */
export async function streamTurn(opts: {
  model: string;
  system: string | undefined;
  messages: ChatMessage[];
  params: ChatParams;
  tools?: unknown[];
  cacheSystem?: boolean;
  baseUrl?: string;
  apiKey?: string;
  extraHeaders?: string;
  allowFallback?: boolean;
  source?: 'local' | 'remote';
  signal: AbortSignal;
  stream?: StreamFn;
  recoverMarkup?: boolean;
  onDelta?: (kind: 'content' | 'reasoning', text: string) => void;
  onStreamError?: (message: string) => void;
}): Promise<TurnResult> {
  const {
    model, system, messages, params, tools, cacheSystem,
    baseUrl, apiKey, extraHeaders, allowFallback, source,
    signal, stream = resolveDefaultStreamFn(params, { source, baseUrl }), recoverMarkup = true, onDelta, onStreamError
  } = opts;
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
  await stream(
    req, signal,
    {
      onContentDelta: (t) => { content += t; onDelta?.('content', t); },
      onReasoningDelta: (t) => { reasoning += t; onDelta?.('reasoning', t); },
      onToolCalls: (c) => { toolCalls = c; },
      onUsage: (_u, m) => { meta = m; },
      onDone: (m) => { meta = { ...meta, ...m }; finishReason = m.finishReason; },
      onError: (msg) => { onStreamError?.(msg); },
    },
    { baseUrl, apiKey, extraHeaders, allowFallback, source }
  );

  let recoveredFromMarkup: TurnResult['recoveredFromMarkup'] = null;
  let dropped: string[] = [];
  if (recoverMarkup && toolCalls.length === 0 && (content.trim() || reasoning.trim())) {
    const declared = new Set(
      (tools ?? []).map(toolNameOf).filter((n): n is string => n !== null),
    );
    let recovered = parseMarkupToolCalls(content);
    let fromReasoning = false;
    if (recovered.calls.length === 0 && !content.trim() && reasoning.trim()) {
      recovered = parseMarkupToolCalls(reasoning);
      fromReasoning = true;
    }
    const usable = recovered.calls.filter((c) => declared.has(c.name));
    // Report dropped names even when nothing was usable — otherwise a turn
    // whose markup names only unoffered tools looks identical to a plain
    // reply and the loop strands with raw markup as the final answer.
    dropped = recovered.calls.filter((c) => !declared.has(c.name)).map((c) => c.name);
    if (usable.length > 0) {
      if (fromReasoning) reasoning = stripToolMarkup(reasoning, recovered.consumed);
      else content = stripToolMarkup(content, recovered.consumed);
      toolCalls = usable;
      recoveredFromMarkup = fromReasoning ? 'reasoning' : 'content';
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

type ToolLoopStop = 'done' | 'steps' | 'aborted' | 'empty' | 'halted';

interface AssistantHook {
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
  baseUrl?: string;
  apiKey?: string;
  extraHeaders?: string;
  allowFallback?: boolean;
  source?: 'local' | 'remote';
  cacheSystem?: boolean;
  /** Append a fresh `contextNoteMessage()` (date/time) to real history
   *  before every internal turn of this loop — persisted, not discarded;
   *  see `contextNoteMessage`. */
  appendDateTime?: boolean;
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
  const {
    model, system, params, tools, registry, maxSteps, signal, stream,
    baseUrl, apiKey, extraHeaders, allowFallback, source,
    cacheSystem, appendDateTime, recoverMarkup
  } = opts;
  let messages = [...opts.messages];
  let turns = 0;
  let finishReason: string | undefined;
  let meta: MessageMeta = {};
  while (turns < maxSteps) {
    if (signal.aborted) return { messages, turns, stop: 'aborted', finishReason, meta };
    opts.onTurnStart?.(turns);
    if (appendDateTime) {
      const note = contextNoteMessage();
      if (note) {
        messages = [...messages, note];
        opts.onAppended?.([note], turns);
      }
    }
    let streamError: string | undefined;
    const t = await streamTurn({
      model, system, messages, params, tools, cacheSystem, signal, stream, recoverMarkup,
      baseUrl, apiKey, extraHeaders, allowFallback, source,
      onDelta: (kind, text) => opts.onDelta?.(kind, text, turns),
      onStreamError: (msg) => {
        streamError = msg;
        opts.onStreamError?.(msg, turns);
      },
    });
    // Transports report errors via callbacks rather than rejecting. Do not
    // treat an interrupted turn as success or dispatch its partial tool calls.
    if (streamError !== undefined && !signal.aborted) throw new Error(streamError);
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
    if (!proceed && !signal.aborted && t.toolCalls.length === 0 && t.dropped.length > 0) {
      // The model emitted tool-call markup for tools that aren't offered
      // (e.g. `bash` while Computer Use is off) — recovery parsed it but the
      // declared-set filter dropped every call. Without a correction the run
      // strands with raw `<tool_call>` text in the reply and the model never
      // learns why nothing executed. Nudge it back into the loop with the
      // available list; consumes step budget like any other continued turn,
      // so a stubborn model ends at 'steps', never spins forever.
      const names = [...new Set(t.dropped)];
      const available = (tools ?? []).map(toolNameOf).filter((n): n is string => n !== null);
      const note: ChatMessage = {
        role: 'user',
        content: available.length
          ? `[System: your tool-call markup for ${names.join(', ')} was ignored — those tools are not available right now. Available tools: ${available.join(', ')}. Call one of the available tools using the native tool-call format, or answer directly in prose.]`
          : `[System: your tool-call markup for ${names.join(', ')} was ignored — no tools are available in this conversation. Answer directly in prose.]`,
      };
      messages = [...messages, note];
      opts.onAppended?.([note], turns);
      turns++;
      continue;
    }
    if (!proceed) return { messages, turns, stop: 'done', finishReason, meta };
    const toolMsgs = await executeToolCalls(t.toolCalls, registry, signal);
    messages = [...messages, ...toolMsgs];
    opts.onAppended?.(toolMsgs, turns);
    turns++;
  }
  return { messages, turns, stop: 'steps', finishReason, meta };
}
