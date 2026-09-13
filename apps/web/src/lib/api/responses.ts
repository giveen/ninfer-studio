// Transport adapter for the engine's /v1/responses endpoint (OpenAI Responses
// API shape: typed output Items — reasoning/message/function_call — instead
// of Chat Completions' role/content messages + tool_calls array). Contract
// confirmed empirically against a live engine (see plan doc): stable
// call_id/id per item, no [DONE] sentinel (stream ends after
// response.completed), and — critically — this engine build's /v1/responses
// only accepts `temperature`/`top_p` from our sampling knobs; `top_k`,
// `min_p`, `presence_penalty`, `frequency_penalty`, and `seed` are all
// rejected with `unknown_parameter`. Never silently drop a param the user
// set — see `paramsSupportedByResponses`, used by callers to decide per-turn
// whether to route here at all.
//
// Deliberately a pure transport adapter, not a parallel request-builder:
// `streamResponses` takes the exact Chat-Completions-shaped `req` object
// `buildChatRequest` already produces (the same one `streamTurn` builds
// internally), reshapes it into the Responses request, and parses the event
// stream back into the same ChatStreamCallbacks — so `streamTurn` /
// `agentLoop.ts` need zero changes to use this as an injected `StreamFn`.

import type { ChatParams } from '../types';
import type { ChatStreamCallbacks } from './chat';
import { API_BASE } from './core';

/** Sampling fields this engine's /v1/responses build actually accepts.
 *  Anything else set to a non-default value must keep using Chat Completions
 *  for that turn — see `paramsSupportedByResponses`. */
const UNSUPPORTED_SAMPLING_FIELDS: Array<keyof ChatParams> = [
  'topK', 'minP', 'presencePenalty', 'frequencyPenalty', 'seed',
];

/** True when `params` is fully expressible via /v1/responses on this engine
 *  build — i.e. none of the fields it rejects are set. Callers should use
 *  this (before building a request) to decide whether this turn may use the
 *  Responses transport at all; never call streamResponses for a turn that
 *  fails this check, or a user-configured sampling knob gets silently
 *  dropped. */
export function paramsSupportedByResponses(params: ChatParams): boolean {
  return !UNSUPPORTED_SAMPLING_FIELDS.some((k) => params[k] !== undefined);
}

// ---------------------------------------------------------------------------
// Capability probe — community engine forks may not implement /v1/responses
// at all, so support is never assumed, only detected.
// ---------------------------------------------------------------------------
let cachedSupport: { supported: boolean; at: number } | null = null;
const PROBE_TTL_MS = 60_000;

/** Probe whether the engine at API_BASE implements /v1/responses. Cached for
 *  PROBE_TTL_MS so callers can check this on every turn cheaply; pass
 *  `force` to re-probe immediately (e.g. right after an engine restart).
 *
 *  Deliberately does NOT use the HTTP status code to decide — this engine
 *  returns 404 for "model not found" on a perfectly real route, same as it
 *  would for a genuinely missing one, so status alone is ambiguous
 *  (confirmed empirically). The real signal is the response body: an
 *  existing route always answers with a structured `{"error": {...}}` JSON
 *  body (whatever the status code — 400 for a bad request, 404 for an
 *  unknown model, 200 on success), while a route the engine build doesn't
 *  implement at all falls through to the proxy's own 404 with an empty,
 *  non-JSON body. */
export async function probeResponsesSupport(force = false): Promise<boolean> {
  if (!force && cachedSupport && Date.now() - cachedSupport.at < PROBE_TTL_MS) {
    return cachedSupport.supported;
  }
  let supported = false;
  try {
    const r = await fetch(API_BASE + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Deliberately invalid body (empty input, bogus model) — cheapest
      // possible probe; we only care whether the engine's JSON API layer
      // answered at all, never about the response's success/failure.
      body: JSON.stringify({ model: '__ninfier_probe__', input: [], max_output_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(4000),
    });
    const text = await r.text();
    const parsed = text ? JSON.parse(text) : null;
    supported = !!parsed && typeof parsed === 'object';
  } catch {
    supported = false;
  }
  cachedSupport = { supported, at: Date.now() };
  return supported;
}

/** Last-known probe result without awaiting a fresh check — for call sites
 *  that need a synchronous yes/no (e.g. deciding which StreamFn to pass into
 *  streamTurn without making the whole call chain async). Defaults to
 *  false (safe: falls back to the proven Chat Completions path) until the
 *  first probeResponsesSupport() call resolves. */
export function knownResponsesSupport(): boolean {
  return cachedSupport?.supported ?? false;
}

// ---------------------------------------------------------------------------
// Request reshaping: Chat-Completions-shaped `req` -> Responses `input` items
// ---------------------------------------------------------------------------

/** One Chat-Completions `messages[]` entry, as `buildChatRequest` produces
 *  it (loosely typed here since we only reach in for the fields we convert). */
interface CCMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

/** Convert one Chat-Completions message into 0-2 Responses input items.
 *  A tool-role message becomes a function_call_output item; an
 *  assistant message with tool_calls becomes an optional text/message item
 *  followed by one function_call item per call; everything else becomes a
 *  plain {role, content} item (Responses accepts the same role vocabulary
 *  for plain text turns). Multimodal attachment parts (image_url/video_url)
 *  already present in `content` as an array are passed through as-is —
 *  Responses' content-part type names differ from Chat Completions' for
 *  multimodal parts, but this engine build accepts the same `image_url`/
 *  `video_url` shape here too (unverified for non-text parts beyond this;
 *  flag for follow-up testing once vision-in-Chat is exercised through this
 *  transport). */
export function toResponsesItems(m: CCMessage): Array<Record<string, unknown>> {
  if (m.role === 'tool') {
    return [{ type: 'function_call_output', call_id: m.tool_call_id, output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }];
  }
  const items: Array<Record<string, unknown>> = [];
  const hasText = typeof m.content === 'string' ? m.content.trim().length > 0 : Array.isArray(m.content) && m.content.length > 0;
  if (hasText) items.push({ role: m.role, content: m.content });
  if (m.role === 'assistant' && m.tool_calls?.length) {
    for (const tc of m.tool_calls) {
      items.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
    }
  }
  return items;
}

export function toResponsesTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => {
    const f = (t as { function?: { name: string; description?: string; parameters?: unknown } }).function;
    return f ? { type: 'function', name: f.name, description: f.description, parameters: f.parameters } : t;
  });
}

/** Map buildChatRequest's reasoning fields onto Responses' nested
 *  `reasoning: {effort}` object. `enable_thinking === false` always wins
 *  (explicit off); otherwise an explicit reasoning_effort is forwarded;
 *  otherwise reasoning is left unset so the engine applies its own default
 *  (matches today's Chat Completions behavior when no override is chosen). */
export function toResponsesReasoning(req: Record<string, unknown>): Record<string, unknown> | undefined {
  if (req.enable_thinking === false) return { effort: 'none' };
  const effort = req.reasoning_effort;
  if (typeof effort === 'string' && effort) return { effort };
  return undefined;
}

export function buildResponsesBody(req: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(req.messages) ? (req.messages as CCMessage[]) : [];
  const input = messages.flatMap(toResponsesItems);
  const body: Record<string, unknown> = {
    model: req.model,
    input,
    stream: true,
  };
  const reasoning = toResponsesReasoning(req);
  if (reasoning) body.reasoning = reasoning;
  if (req.max_completion_tokens !== undefined) body.max_output_tokens = req.max_completion_tokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  const tools = toResponsesTools(req.tools);
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return body;
}

// ---------------------------------------------------------------------------
// Streaming: parse the confirmed event/data SSE stream into ChatStreamCallbacks
// ---------------------------------------------------------------------------

interface ResponsesMeta {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  ttftMs?: number;
  finishReason?: string;
}

/** Mutable accumulator threaded through one stream's worth of events —
 *  `calls`/`itemIdToCallId` collect tool-call pieces that arrive across
 *  several events, `meta`/`completed` are the terminal summary. Exported
 *  (with `initResponsesState`) purely so `applyResponsesEvent` is directly
 *  unit-testable against canned event fixtures, without touching
 *  fetch/ReadableStream at all. */
export interface ResponsesState {
  calls: Map<string, { name: string; arguments: string }>;
  itemIdToCallId: Map<string, string>;
  meta: ResponsesMeta;
  completed: boolean;
}

export function initResponsesState(): ResponsesState {
  return { calls: new Map(), itemIdToCallId: new Map(), meta: {}, completed: false };
}

/** What one parsed SSE event should cause the caller to emit — `state` is
 *  mutated in place (calls/meta/completed), this return value covers only
 *  the parts that map to a ChatStreamCallbacks call. */
export interface ResponsesEventEffect {
  contentDelta?: string;
  reasoningDelta?: string;
  usage?: Record<string, unknown>;
  error?: string;
}

/** Pure reducer over one decoded `data:` line's JSON payload — the actual
 *  event-type switch, extracted from the fetch/ReadableStream loop so it can
 *  be tested directly against the confirmed event shapes (see the plan doc)
 *  without any network mocking. Malformed JSON is silently ignored (mirrors
 *  the original inline `try { JSON.parse } catch { return }` — a single bad
 *  line must never abort an otherwise-healthy stream). */
export function applyResponsesEvent(payload: string, state: ResponsesState): ResponsesEventEffect {
  let chunk: Record<string, any>;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return {};
  }
  switch (chunk.type) {
    case 'response.output_text.delta':
      return { contentDelta: chunk.delta ?? '' };
    case 'response.reasoning_text.delta':
      return { reasoningDelta: chunk.delta ?? '' };
    case 'response.output_item.added': {
      if (chunk.item?.type === 'function_call' && chunk.item.call_id) {
        state.itemIdToCallId.set(chunk.item.id, chunk.item.call_id);
        state.calls.set(chunk.item.call_id, { name: chunk.item.name ?? '', arguments: '' });
      }
      return {};
    }
    case 'response.function_call_arguments.done': {
      // Fall back to item_id as the key if output_item.added somehow wasn't
      // seen first, so the call is never silently dropped.
      const callId = state.itemIdToCallId.get(chunk.item_id) ?? chunk.item_id;
      const entry = state.calls.get(callId) ?? { name: '', arguments: '' };
      entry.name = chunk.name ?? entry.name;
      entry.arguments = chunk.arguments ?? '';
      state.calls.set(callId, entry);
      return {};
    }
    case 'response.completed': {
      state.completed = true;
      const usage = chunk.response?.usage;
      if (usage) {
        state.meta.promptTokens = usage.input_tokens;
        state.meta.completionTokens = usage.output_tokens;
        state.meta.cachedTokens = usage.input_tokens_details?.cached_tokens;
        state.meta.reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
      }
      // Reconcile the final call list against the server's own output array
      // (authoritative call_id/name/arguments), in case any per-event
      // bookkeeping above missed something.
      const output = Array.isArray(chunk.response?.output) ? chunk.response.output : [];
      for (const item of output) {
        if (item?.type === 'function_call' && item.call_id) {
          state.calls.set(item.call_id, { name: item.name ?? '', arguments: item.arguments ?? '' });
        }
      }
      state.meta.finishReason = output.some((i: any) => i?.type === 'function_call') ? 'tool_calls' : (chunk.response?.status === 'incomplete' ? 'length' : 'stop');
      return usage ? { usage } : {};
    }
    case 'response.failed':
    case 'response.incomplete': {
      const msg = chunk.response?.error?.message || chunk.response?.incomplete_details?.reason || 'response did not complete';
      return { error: String(msg) };
    }
    default:
      return {};
  }
}

/** Drop-in StreamFn (see agentLoop.ts) — same signature as streamChat, so
 *  streamTurn's `stream?: StreamFn` injection point works unchanged. */
export async function streamResponses(
  ccReq: Record<string, unknown>,
  signal: AbortSignal,
  cb: ChatStreamCallbacks,
): Promise<void> {
  const body = buildResponsesBody(ccReq);
  const t0 = performance.now();
  const state = initResponsesState();
  let firstContentAt: number | null = null;

  try {
    const r = await fetch(API_BASE + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok || !r.body) {
      const text = await r.text().catch(() => '');
      let detail = `HTTP ${r.status}`;
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message || j?.error?.code || detail;
      } catch {
        if (text) detail = text.slice(0, 400);
      }
      cb.onError?.(`engine request failed: ${detail}`);
      return;
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    // Responses SSE carries both `event:` and `data:` lines per event; the
    // JSON payload's own `type` field always mirrors the `event:` line, so
    // only `data:` lines need parsing — `event:`/blank lines are no-ops.
    const handleDataLine = (payload: string) => {
      const effect = applyResponsesEvent(payload, state);
      if (effect.contentDelta !== undefined) {
        if (firstContentAt === null) firstContentAt = performance.now();
        cb.onContentDelta?.(effect.contentDelta);
      }
      if (effect.reasoningDelta !== undefined) cb.onReasoningDelta?.(effect.reasoningDelta);
      if (effect.usage) cb.onUsage?.(effect.usage, state.meta as any);
      if (effect.error) cb.onError?.(effect.error);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload) handleDataLine(payload);
        }
      }
    }
    if (buf.trim().startsWith('data:')) {
      const payload = buf.trim().slice(5).trim();
      if (payload) handleDataLine(payload);
    }

    if (firstContentAt !== null) state.meta.ttftMs = firstContentAt - t0;
    if (state.calls.size) {
      cb.onToolCalls?.([...state.calls.entries()].map(([id, c]) => ({ id, name: c.name, arguments: c.arguments })));
    }
    if (!state.completed) {
      cb.onError?.('The response stream ended before completion — the connection may have dropped.');
      return;
    }
    cb.onDone?.(state.meta as any);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      state.meta.finishReason = state.meta.finishReason || 'cancelled';
      cb.onDone?.(state.meta as any);
      return;
    }
    cb.onError?.(e instanceof Error ? e.message : String(e));
  }
}
