import { useEffect, useRef, useState } from 'react';
import type {
  AgentToolCall,
  AppSettings,
  ChatMessage,
  ChatParams,
  CoderEditResult,
  CoderExecResult,
  CoderGlobResult,
  CoderGrepResult,
  CoderJob,
  CoderMessage,
  CoderReadResult,
  CoderTodo,
  CoderTree,
  CoderWebFetch,
  CoderWebSearch,
  CoderWorkspace,
  CoderWriteResult,
  FileNode,
  MessageMeta,
  ProfileState,
  SavedProfile,
  StatusPayload,
} from './types';
import type { ChatAttachment } from './types';

// In dev (Vite) the web is served on :5173 and /api is proxied to the sidecar on
// :8787, so relative paths work. In a bundled desktop build the webview is loaded
// from the Tauri asset origin (tauri://localhost) and must reach the in-process
// control plane by its absolute loopback URL instead.
const API_BASE = import.meta.env.DEV ? '' : 'http://127.0.0.1:8787';

async function getJSON<T>(path: string, timeoutMs = 4000): Promise<T> {
  const r = await fetch(API_BASE + path, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function postJSON<T>(path: string, body: unknown, timeoutMs = 10_000): Promise<T> {
  const r = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} → HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return data;
}

export function getStatus(): Promise<StatusPayload> {
  return getJSON<StatusPayload>('/api/status', 6000);
}

export function getConfig(): Promise<AppSettings> {
  return getJSON<AppSettings>('/api/config');
}

/** Read the engine's context window (max_model_len) for `model` from its
 *  /v1/models advertisement. Falls back to null so callers can try the
 *  sidecar-reported maxContext instead. */
export async function getEngineContextSize(model = 'qwen-coder'): Promise<number | null> {
  try {
    const data = await getJSON<{ data?: Array<{ id: string; max_model_len?: number }> }>('/v1/models');
    const models = data?.data ?? [];
    const hit = models.find((m) => m.id === model) ?? models[0];
    return hit?.max_model_len != null ? hit.max_model_len : null;
  } catch {
    return null;
  }
}

export function saveConfig(patch: Partial<AppSettings>): Promise<AppSettings> {
  return postJSON<AppSettings>('/api/config', patch, 5000);
}

// ---------------------------------------------------------------------------
// Per-user profile state (engine profile + artifact + saved named profiles).
// Persisted by the control plane under the user's profile dir, not the browser.
// ---------------------------------------------------------------------------
export function getProfileState(): Promise<ProfileState> {
  return getJSON<ProfileState>('/api/profile-state', 5000);
}

export function saveProfileState(
  patch: Partial<{ profile: import('./types').EngineProfile; artifact: string; saved: SavedProfile[] }>,
): Promise<unknown> {
  return postJSON('/api/profile-state', patch, 5000);
}

// ---------------------------------------------------------------------------
// Conversations + chat params — persisted by the control plane under the user's
// profile dir (not the browser), so chat history survives a fresh install.
// ---------------------------------------------------------------------------
export interface ConversationsState {
  conversations: import('./types').Conversation[];
  params: ChatParams | null;
}

export function getConversations(): Promise<ConversationsState> {
  return getJSON<ConversationsState>('/api/conversations', 8000);
}

export function saveConversations(
  patch: Partial<{ conversations: import('./types').Conversation[]; params: ChatParams }>,
): Promise<unknown> {
  return postJSON('/api/conversations', patch, 20_000);
}

export interface EngineActionResult {
  ok: boolean;
  code?: string;
  message?: string;
  engine?: StatusPayload['engine'];
  /** set by the control plane when the profile failed to deserialize */
  profileParseError?: string;
}

export function startEngine(profile: unknown, artifact: string | null): Promise<EngineActionResult> {
  // Empty strings are how the form represents "unset" for some fields, but the
  // Rust control plane deserializes typed Option<u64>/Option<f64> fields — a ''
  // value fails the whole profile parse there and (with its fallback) silently
  // drops EVERY setting. Strip '' values here so both the Node sidecar and the
  // control plane receive a clean profile; `undefined` keys are dropped by
  // JSON.stringify.
  const clean = JSON.parse(JSON.stringify(profile, (_k, v) => (v === '' ? undefined : v)));
  return postJSON<EngineActionResult>('/api/engine/start', { profile: clean, artifact }, 15_000);
}

export function stopEngine(externalPid?: number): Promise<EngineActionResult> {
  return postJSON<EngineActionResult>('/api/engine/stop', { externalPid }, 15_000);
}

export function startEngineUpdate(action: 'pull' | 'build'): Promise<EngineActionResult> {
  return postJSON('/api/engine/update', { action });
}

export function getLogs(n = 400): Promise<{ lines: string[]; size: number }> {
  return getJSON<{ lines: string[]; size: number }>(`/api/logs?n=${n}`, 6000);
}

export function downloadModel(repo: string, file: string, localDir?: string) {
  return postJSON<{ ok: boolean; id?: string; message?: string }>('/api/models/download', {
    repo,
    file,
    localDir,
  });
}

/** Poll /api/status on an interval and keep it fresh in state. */
export function useStatus(intervalMs = 2500): { status: StatusPayload | null; error: string | null } {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const tick = async () => {
      try {
        const s = await getStatus();
        if (!alive.current) return;
        setStatus(s);
        setError(null);
      } catch (e) {
        if (!alive.current) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return { status, error };
}

// ---------------------------------------------------------------------------
// Streaming chat over OpenAI-compatible /v1/chat/completions (SSE)
// ---------------------------------------------------------------------------
export interface ChatStreamCallbacks {
  onReasoningDelta?: (text: string) => void;
  onContentDelta?: (text: string) => void;
  onUsage?: (usage: Record<string, unknown>, meta: MessageMeta) => void;
  onDone?: (meta: MessageMeta) => void;
  onError?: (message: string) => void;
  /** Coding harness: tool calls assembled from streamed `delta.tool_calls`. Fires at finish. */
  onToolCalls?: (calls: import('./types').AgentToolCall[]) => void;
}

export function buildChatRequest(
  model: string,
  systemPrompt: string | undefined,
  history: ChatMessage[],
  params: ChatParams,
  extra?: Record<string, unknown>,
  /** When true, mark the system prompt with `cache_control` so the engine can
   *  cache it across turns (Anthropic-style prefix caching). Opt-in: only enable
   *  if your engine supports it; some OpenAI-compatible servers reject the field. */
  cacheSystem = false,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (systemPrompt?.trim()) {
    const sys: Record<string, unknown> = { role: 'system', content: systemPrompt.trim() };
    if (cacheSystem) sys.cache_control = { type: 'ephemeral' };
    messages.push(sys);
  }
  for (const m of history) {
    if (m.role === 'system') continue;
    if (m.attachments && m.attachments.length) {
      const content: Array<Record<string, unknown>> = [];
      if (m.content.trim()) content.push({ type: 'text', text: m.content });
      for (const a of m.attachments) {
        if (a.kind === 'image') content.push({ type: 'image_url', image_url: { url: a.dataUrl! } });
        else if (a.kind === 'video') content.push({ type: 'video_url', video_url: { url: a.dataUrl! } });
        else if (a.kind === 'file') {
          const p = a.path ?? a.name;
          content.push({ type: 'text', text: `\n\n[Attached file: ${p}]\n\`\`\`\n${a.content ?? ''}\n\`\`\`\n` });
        }
      }
      messages.push({ role: 'user', content });
    } else {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.role === 'assistant' && m.reasoning) msg.reasoning_content = m.reasoning;
      if (m.tool_calls) msg.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments }
      }));
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.name) msg.name = m.name;
      messages.push(msg);
    }
  }
  // Thinking switch + effort: a contradictory enable_thinking/reasoning_effort
  // pair is rejected by the engine, so derive both from one intent.
  let enableThinking = params.thinking;
  let effort: string | undefined;
  if (params.reasoningEffort === 'none') {
    enableThinking = false;
    effort = 'none';
  } else if (params.reasoningEffort) {
    enableThinking = true;
    effort = params.reasoningEffort;
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    enable_thinking: enableThinking,
  };
  if (effort) body.reasoning_effort = effort;
  if (params.preserveThinking !== undefined) body.preserve_thinking = params.preserveThinking;
  if (params.maxTokens) body.max_completion_tokens = params.maxTokens;
  if (params.greedy) body.temperature = 0;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.topK !== undefined) body.top_k = params.topK;
  if (params.minP !== undefined) body.min_p = params.minP;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
  if (params.seed !== undefined) body.seed = params.seed;
  Object.assign(body, extra ?? {});
  return body;
}

export async function streamChat(
  body: Record<string, unknown>,
  signal: AbortSignal,
  cb: ChatStreamCallbacks,
): Promise<void> {
  const t0 = performance.now();
  const meta: MessageMeta = {};
  let firstContentAt: number | null = null;
  let sawDone = false;
  // Accumulate streamed tool calls (native OpenAI function calling).
  const toolAcc: Array<{ id: string; type: string; name: string; arguments: string }> = [];

  const finish = () => {
    if (firstContentAt !== null) meta.ttftMs = firstContentAt - t0;
    const calls = toolAcc
      .filter(Boolean)
      .map((t, i) => ({ id: t.id || `call_${i}`, name: t.name, arguments: t.arguments }));
    if (calls.length) cb.onToolCalls?.(calls);
    cb.onDone?.(meta);
  };

  try {
    const r = await fetch(API_BASE + '/v1/chat/completions', {
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

    // Parse one SSE line (already stripped of its trailing newline). Returns true
    // when the stream is finished ([DONE] seen).
    const handleLine = (raw: string): boolean => {
      const line = raw.replace(/\r$/, '');
      if (!line.startsWith('data:')) return false; // skip comments / keep-alives / event: lines
      const payload = line.slice(5).trim();
      if (!payload) return false;
      if (payload === '[DONE]') { sawDone = true; return true; }
      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return false;
      }
      if (chunk.timings) {
        const t = chunk.timings;
        meta.promptTokPerSec = t.prompt_per_second;
        meta.decodeTokPerSec = t.predicted_per_second;
        meta.cachedTokens = t.cache_n;
        meta.promptTokens = t.cache_n + t.prompt_n;
        meta.completionTokens = t.predicted_n;
        if (t.draft_n !== undefined) meta.draftN = t.draft_n;
        if (t.draft_n_accepted !== undefined) meta.draftNAccepted = t.draft_n_accepted;
      }
      if (chunk.usage) {
        meta.promptTokens = chunk.usage.prompt_tokens ?? meta.promptTokens;
        meta.completionTokens = chunk.usage.completion_tokens ?? meta.completionTokens;
        meta.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? meta.cachedTokens;
        meta.reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens;
      }
      const choice = chunk.choices?.[0];
      if (choice) {
        const d = choice.delta ?? {};
        if (d.reasoning_content) cb.onReasoningDelta?.(d.reasoning_content);
        if (d.content) {
          if (firstContentAt === null) firstContentAt = performance.now();
          cb.onContentDelta?.(d.content);
        }
        // Native tool calling: accumulate streamed tool_call deltas by index.
        const tcs = (choice.delta as { tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> } | undefined)?.tool_calls;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const idx = tc.index ?? toolAcc.length;
            if (!toolAcc[idx]) toolAcc[idx] = { id: '', type: 'function', name: '', arguments: '' };
            if (tc.id) toolAcc[idx].id = tc.id;
            if (tc.type) toolAcc[idx].type = tc.type;
            if (tc.function?.name) toolAcc[idx].name = tc.function.name;
            if (tc.function?.arguments) toolAcc[idx].arguments += tc.function.arguments;
          }
        }
        if (choice.finish_reason) meta.finishReason = choice.finish_reason;
      }
      if (chunk.usage) cb.onUsage?.(chunk.usage, meta);
      return false;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (handleLine(line)) {
          finish();
          return;
        }
      }
    }
    // Flush any trailing bytes not terminated by a newline. Some servers close
    // the connection without a final LF, which would otherwise drop the last
    // event — typically the final content delta and [DONE] — leaving the UI
    // showing an empty/partial response even though the request completed.
    if (buf.length) {
      const tail = buf;
      buf = '';
      if (handleLine(tail)) {
        finish();
        return;
      }
    }
    // The SSE stream closed without a [DONE] event — treat it as an interrupted
    // connection (proxy/engine dropped mid-response) and surface a retry
    // affordance instead of a silently empty/partial answer.
    if (!sawDone) {
      cb.onError?.('The response stream ended before completion — the connection may have dropped.');
      return;
    }
    finish();
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      meta.finishReason = meta.finishReason || 'cancelled';
      finish();
      return;
    }
    cb.onError?.(e instanceof Error ? e.message : String(e));
  }
}

export function attachmentsToParts(att: ChatAttachment[]): Array<Record<string, unknown>> | null {
  if (!att.length) return null;
  return att.map((a) =>
    a.kind === 'image'
      ? { type: 'image_url', image_url: { url: a.dataUrl } }
      : { type: 'video_url', video_url: { url: a.dataUrl } },
  );
}

// ---------------------------------------------------------------------------
// Conversation compaction (/compact): condense the current chat into a
// structured checkpoint so context is preserved while token usage drops. The
// directive + framing mirror the deepseek-harness compaction engine.
// ---------------------------------------------------------------------------
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n');

const SUMMARY_OPEN_TAG = '<compacted-summary>';
const SUMMARY_CLOSE_TAG = '</compacted-summary>';
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

/** Wrap a raw summary into the checkpoint framing used as the new chat context. */
export function frameCompactedSummary(summary: string): string {
  return `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${summary.trim()}\n${SUMMARY_CLOSE_TAG}`;
}

/**
 * Stream a structured summary of `history` from the engine. The compaction
 * directive is appended as a final user message (thinking disabled) so the
 * engine produces the checkpoint text, which we return as a single string.
 */
export function summarizeConversation(opts: {
  model: string;
  systemPrompt?: string;
  history: ChatMessage[];
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  maxTokens?: number;
}): Promise<string> {
  const instruction: ChatMessage = { role: 'user', content: COMPACTION_INSTRUCTION };
  // Thinking off for the condensation pass; bound the output so it can't run away.
  const summaryParams: ChatParams = {
    thinking: false,
    reasoningEffort: '',
    preserveThinking: false,
    maxTokens: opts.maxTokens ?? 2048,
  };
  const body = buildChatRequest(opts.model, opts.systemPrompt, [...opts.history, instruction], summaryParams);
  return new Promise<string>((resolve, reject) => {
    let acc = '';
    streamChat(body, opts.signal ?? AbortSignal.timeout(180_000), {
      onContentDelta: (d) => {
        acc += d;
        opts.onDelta?.(d);
      },
      onDone: () => resolve(acc.trim()),
      onError: (m) => reject(new Error(m)),
    });
  });
}

// ---------------------------------------------------------------------------
// Tool-output summarization: condense a giant tool result (command output, a
// large file read, a fetched page) into an actionable summary so the agent's
// context stays small instead of ingesting a raw multi-hundred-KB dump.
// ---------------------------------------------------------------------------
const OUTPUT_SUMMARY_INSTRUCTION = [
  'You are a tool-output summarizer for a coding agent. Condense the tool output below into a tight, actionable summary a software engineer can act on without seeing the raw dump.',
  '',
  'Preserve verbatim: exact error messages and stack traces, exit codes, key numeric values (IDs, counts, sizes, ports, addresses), file paths and line numbers, command output that indicates success/failure, and the final state.',
  'Drop: boilerplate, banners, repeated lines, progress bars, ANSI/carriage-return noise, and irrelevant verbose dumps.',
  'Use terse bullets. If the output is already short, say so. Output ONLY the summary — no preamble, no tools.',
].join('\n');

/** Stream an AI summary of a single tool output from the engine. */
export function summarizeOutput(opts: {
  model: string;
  output: string;
  signal?: AbortSignal;
  maxTokens?: number;
}): Promise<string> {
  const instruction: ChatMessage = { role: 'user', content: OUTPUT_SUMMARY_INSTRUCTION };
  const params: ChatParams = {
    thinking: false,
    reasoningEffort: '',
    preserveThinking: false,
    maxTokens: opts.maxTokens ?? 1024,
  };
  const body = buildChatRequest(opts.model, undefined, [{ role: 'user', content: opts.output }, instruction], params);
  return new Promise<string>((resolve, reject) => {
    let acc = '';
    streamChat(body, opts.signal ?? AbortSignal.timeout(180_000), {
      onContentDelta: (d) => {
        acc += d;
      },
      onDone: () => resolve(acc.trim()),
      onError: (m) => reject(new Error(m)),
    });
  });
}

// ---------------------------------------------------------------------------
// Coding harness control-plane endpoints (sandboxed to the workspace)
// ---------------------------------------------------------------------------
export function getCoderWorkspace(): Promise<CoderWorkspace> {
  return getJSON<CoderWorkspace>('/api/coder/workspace');
}
export function coderRepoMap(): Promise<{ map: string }> {
  return getJSON<{ map: string }>('/api/coder/repo_map');
}
export function setCoderWorkspace(path: string): Promise<CoderWorkspace> {
  return postJSON<CoderWorkspace>('/api/coder/workspace', { path }, 8000);
}
export interface CoderDirs {
  root: string;
  exists: boolean;
  isDir: boolean;
  dirs: string[];
  error?: string;
}
export function coderDirs(root: string): Promise<CoderDirs> {
  return getJSON<CoderDirs>(`/api/coder/dirs?root=${encodeURIComponent(root)}`);
}
export function coderTree(depth = 3, root = '.'): Promise<CoderTree> {
  return getJSON<CoderTree>(`/api/coder/tree?depth=${depth}&root=${encodeURIComponent(root)}`);
}
export function coderRead(path: string, offset?: number, limit?: number): Promise<CoderReadResult> {
  return postJSON<CoderReadResult>('/api/coder/fs/read', { path, offset, limit }, 8000);
}
export interface CoderBase64Result {
  path: string;
  mime: string;
  dataUrl: string;
  size: number;
}
export function coderReadBase64(path: string): Promise<CoderBase64Result> {
  return postJSON<CoderBase64Result>('/api/coder/fs/b64', { path }, 15_000);
}
export function coderWrite(path: string, content: string): Promise<CoderWriteResult> {
  return postJSON<CoderWriteResult>('/api/coder/fs/write', { path, content }, 16_000_000);
}
export function coderEdit(path: string, oldStr: string, newStr: string, replaceAll = false): Promise<CoderEditResult> {
  return postJSON<CoderEditResult>('/api/coder/fs/edit', { path, old: oldStr, new: newStr, replaceAll }, 16_000_000);
}
export interface CoderPatchEdit { old: string; new: string; replaceAll?: boolean; }
export function coderPatch(path: string, edits: CoderPatchEdit[]): Promise<CoderEditResult> {
  return postJSON<CoderEditResult>('/api/coder/fs/patch', { path, edits }, 16_000_000);
}
export function coderExec(command: string, cwd?: string, timeoutMs?: number, sessionId?: string, background?: boolean): Promise<CoderExecResult> {
  return postJSON<CoderExecResult>('/api/coder/exec', { command, cwd, timeoutMs, sessionId, background }, 15_000);
}
export function coderJob(jobId: string): Promise<CoderJob> {
  return getJSON<CoderJob>(`/api/coder/jobs/${encodeURIComponent(jobId)}`, 15_000);
}
export function coderJobKill(jobId: string): Promise<CoderJob> {
  return postJSON<CoderJob>(`/api/coder/jobs/${encodeURIComponent(jobId)}/kill`, {}, 15_000);
}
export function coderGrep(
  pattern: string,
  path?: string,
  include?: string,
  ignoreCase?: boolean,
  offset = 0,
  limit = 200,
): Promise<CoderGrepResult> {
  return postJSON<CoderGrepResult>('/api/coder/grep', { pattern, path, include, ignoreCase, offset, limit }, 15_000);
}
export function coderGlob(pattern: string, path?: string, offset = 0, limit = 200): Promise<CoderGlobResult> {
  return postJSON<CoderGlobResult>('/api/coder/glob', { pattern, path, offset, limit }, 15_000);
}
export interface CoderSearchResult {
  results: Array<{ file: string; line: number; snippet: string; score: number; kind: string }>;
  truncated: boolean;
}
export function coderSearch(query: string, limit = 15): Promise<CoderSearchResult> {
  return getJSON<CoderSearchResult>(`/api/coder/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}
export interface CoderDiffResult {
  files: Array<{ path: string; bar?: string }>;
  diff: string;
  truncated?: boolean;
  error?: string;
}
export function coderDiff(): Promise<CoderDiffResult> {
  return getJSON<CoderDiffResult>('/api/coder/diff', 60000);
}
export function coderWebFetch(url: string): Promise<CoderWebFetch> {
  return postJSON<CoderWebFetch>('/api/coder/web/fetch', { url }, 20_000);
}
export function coderWebSearch(query: string): Promise<CoderWebSearch> {
  return postJSON<CoderWebSearch>('/api/coder/web/search', { query }, 20_000);
}
export function coderSafeModeGet(): Promise<{ enabled: boolean }> {
  return getJSON<{ enabled: boolean }>('/api/coder/safe-mode', 5000);
}
export function coderSafeModeSet(enabled: boolean): Promise<{ enabled: boolean }> {
  return postJSON<{ enabled: boolean }>('/api/coder/safe-mode', { enabled }, 5000);
}
export function coderSandboxGet(): Promise<{ enabled: boolean }> {
  return getJSON<{ enabled: boolean }>('/api/coder/sandbox', 5000);
}
export function coderSandboxSet(enabled: boolean): Promise<{ enabled: boolean }> {
  return postJSON<{ enabled: boolean }>('/api/coder/sandbox', { enabled }, 5000);
}

// ---------------------------------------------------------------------------
// Self-improving memory (Hybrid A+B).
//   A: a per-repo markdown *memory bank* (read at session start, the agent
//      sees it only via system-prompt injection — never as a normal file).
//   B: structured *learnings* extracted by the item-5 critic (success/tip/avoid)
//      plus agent-proactive records via the `memory_update` tool.
// Both are persisted OUTSIDE the repo under the control plane's data dir, so
// they survive across sessions and are never committed by accident.
// ---------------------------------------------------------------------------
export type CoderLearningKind = 'success' | 'tip' | 'avoid';

export interface CoderLearning {
  /** Stable id (sha1 of text+ts) so the UI can drop individual entries. */
  id: string;
  text: string;
  kind: CoderLearningKind;
  /** Where the learning came from (e.g. "critic:approve", "critic:reject", "tool"). */
  provenance?: string;
  /** Short task description the learning was extracted from, if known. */
  task?: string;
  /** ISO timestamp. */
  ts: string;
}

export interface CoderMemory {
  /** Full markdown bank text. */
  bank: string;
  learnings: CoderLearning[];
}

/** Read the current bank + learnings for the active workspace. */
export function coderMemoryGet(): Promise<CoderMemory> {
  return getJSON<CoderMemory>('/api/coder/memory', 8000);
}

/** Replace the markdown bank wholesale (used by the Memory modal's save). */
export function coderMemorySetBank(bank: string): Promise<CoderMemory> {
  return postJSON<CoderMemory>('/api/coder/memory', { bank }, 8000);
}

/** Append one structured learning (text + kind) and return the updated memory. */
export function coderMemoryAddLearning(learning: {
  text: string;
  kind: CoderLearningKind;
  provenance?: string;
  task?: string;
}): Promise<CoderMemory> {
  return postJSON<CoderMemory>('/api/coder/memory', { learning }, 8000);
}

/** Drop a single learning by id and return the updated memory. */
export function coderMemoryDropLearning(id: string): Promise<CoderMemory> {
  return postJSON<CoderMemory>('/api/coder/memory', { dropLearningId: id }, 8000);
}

export interface CoderCommit {
  hash: string;
  author: string;
  /** Human-friendly relative date, e.g. "3 hours ago" (git %ar). */
  relDate: string;
  /** ISO-ish commit date (git %ad). */
  date: string;
  /** First line of the commit message (git %s). */
  subject: string;
  /** Full commit message body (git %b), may be empty. */
  body: string;
}

/**
 * List recent commits in the active Coder workspace via `git log`. Runs through
 * `coderExec` (which executes in the workspace root), so no sidecar change is
 * needed. Returns [] when the workspace isn't a git repo or has no commits yet.
 */
export async function coderGitLog(limit = 100): Promise<CoderCommit[]> {
  const fmt = '%H%x1f%an%x1f%ar%x1f%ad%x1f%s%x1f%b%x1e';
  const r = await coderExec(`git log --pretty=format:${fmt} -n ${limit}`);
  if (r.exitCode !== 0 || !r.stdout.trim()) return [];
  const HASH_RE = /^[0-9a-f]{7,40}$/;
  return r.stdout
    .split('\x1e')
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec): CoderCommit | null => {
      const parts = rec.split('\x1f');
      // A record whose body happened to contain a separator byte would yield the
      // wrong arity; skip it rather than mis-mapping author/date/subject (M1).
      if (parts.length !== 6 || !HASH_RE.test(parts[0] || '')) return null;
      const [hash, author, relDate, date, subject, body] = parts;
      return { hash, author, relDate, date, subject, body: (body || '').trim() };
    })
    .filter((c): c is CoderCommit => c !== null);
}

/**
 * Build an OpenAI-style chat completion body for the coding agent. Converts the
 * CoderMessage history (user / assistant-with-tool_calls / tool) into the wire
 * format and attaches the tool schema + `tool_choice: auto`. The engine executes
 * no tools itself — it returns `tool_calls`, which the agent loop runs locally.
 */
export function buildCoderRequest(
  model: string,
  systemPrompt: string | undefined,
  history: CoderMessage[],
  tools: unknown[],
  params: ChatParams,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (systemPrompt?.trim()) messages.push({ role: 'system', content: systemPrompt.trim() });
  for (const m of history) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content });
    } else if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content });
    } else {
      const a = m as Extract<CoderMessage, { role: 'assistant' }>;
      const o: Record<string, unknown> = { role: 'assistant', content: a.content || '' };
      if (a.toolCalls && a.toolCalls.length) {
        o.tool_calls = a.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }));
      }
      messages.push(o);
    }
  }
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    tools,
    tool_choice: 'auto',
    enable_thinking: params.thinking,
  };
  if (params.maxTokens) body.max_completion_tokens = params.maxTokens;
  if (params.greedy) body.temperature = 0;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.topK !== undefined) body.top_k = params.topK;
  if (params.minP !== undefined) body.min_p = params.minP;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
  if (params.seed !== undefined) body.seed = params.seed;
  return body;
}

export type { ChatAttachment };
