// Coding harness control-plane endpoints (sandboxed to the workspace):
// filesystem, exec/jobs, grep/glob/search, git diff, web fetch/search, safe
// mode, permissions, sandbox toggle, memory bank/learnings, git log, and the
// tool-calling chat request builder.

import type {
  CoderEditResult,
  CoderExecResult,
  CoderGlobResult,
  CoderGrepResult,
  CoderJob,
  CoderMessage,
  CoderReadResult,
  CoderTree,
  CoderWebFetch,
  CoderWebSearch,
  CoderWorkspace,
  CoderWriteResult,
  ChatParams,
} from '../types';
import { getJSON, postJSON } from './core';

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
export function coderRead(path: string, offset?: number, limit?: number, signal?: AbortSignal): Promise<CoderReadResult> {
  return postJSON<CoderReadResult>('/api/coder/fs/read', { path, offset, limit }, 8000, signal);
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
export function coderWrite(path: string, content: string, signal?: AbortSignal): Promise<CoderWriteResult> {
  return postJSON<CoderWriteResult>('/api/coder/fs/write', { path, content }, 16_000_000, signal);
}
export function coderEdit(path: string, oldStr: string, newStr: string, replaceAll = false, signal?: AbortSignal): Promise<CoderEditResult> {
  return postJSON<CoderEditResult>('/api/coder/fs/edit', { path, old: oldStr, new: newStr, replaceAll }, 16_000_000, signal);
}
export interface CoderPatchEdit { old: string; new: string; replaceAll?: boolean; }
export function coderPatch(path: string, edits: CoderPatchEdit[], signal?: AbortSignal): Promise<CoderEditResult> {
  return postJSON<CoderEditResult>('/api/coder/fs/patch', { path, edits }, 16_000_000, signal);
}
export function coderExec(command: string, cwd?: string, timeoutMs?: number, sessionId?: string, background?: boolean, signal?: AbortSignal): Promise<CoderExecResult> {
  // The client-side fetch timeout must be at least as long as the server-side
  // exec timeout it's requesting (timeoutMs, server default 120s) — it used to
  // be hardcoded to 15s regardless, so any command running longer than that
  // threw a spurious client-side timeout while the server kept working.
  const fetchTimeoutMs = Math.max(15_000, (timeoutMs ?? 120_000) + 5_000);
  return postJSON<CoderExecResult>('/api/coder/exec', { command, cwd, timeoutMs, sessionId, background }, fetchTimeoutMs, signal);
}
export function coderJob(jobId: string, signal?: AbortSignal): Promise<CoderJob> {
  return getJSON<CoderJob>(`/api/coder/jobs/${encodeURIComponent(jobId)}`, 15_000, signal);
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
  signal?: AbortSignal,
): Promise<CoderGrepResult> {
  return postJSON<CoderGrepResult>('/api/coder/grep', { pattern, path, include, ignoreCase, offset, limit }, 15_000, signal);
}
export function coderGlob(pattern: string, path?: string, offset = 0, limit = 200, signal?: AbortSignal): Promise<CoderGlobResult> {
  return postJSON<CoderGlobResult>('/api/coder/glob', { pattern, path, offset, limit }, 15_000, signal);
}
export interface CoderSearchResult {
  results: Array<{ file: string; line: number; snippet: string; score: number; kind: string }>;
  truncated: boolean;
}
export function coderSearch(query: string, limit = 15, signal?: AbortSignal): Promise<CoderSearchResult> {
  return getJSON<CoderSearchResult>(`/api/coder/search?q=${encodeURIComponent(query)}&limit=${limit}`, 4000, signal);
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
export function coderWebFetch(url: string, signal?: AbortSignal): Promise<CoderWebFetch> {
  return postJSON<CoderWebFetch>('/api/coder/web/fetch', { url }, 20_000, signal);
}
export function coderWebSearch(query: string, signal?: AbortSignal): Promise<CoderWebSearch> {
  return postJSON<CoderWebSearch>('/api/coder/web/search', { query }, 20_000, signal);
}
export function coderSafeModeGet(): Promise<{ enabled: boolean }> {
  return getJSON<{ enabled: boolean }>('/api/coder/safe-mode', 5000);
}
export function coderSafeModeSet(enabled: boolean): Promise<{ enabled: boolean }> {
  return postJSON<{ enabled: boolean }>('/api/coder/safe-mode', { enabled }, 5000);
}
/** Mirrors the active workspace's tool permission tiers + denied paths to the
 *  control plane, so a `deny` tier or denied prefix is enforced at the
 *  endpoint itself — not only by this client's own dispatcher, which an
 *  agent could otherwise route around (e.g. `bash` curling straight at an
 *  endpoint whose tool is denied). `ask` isn't sent — the server has no way
 *  to pause and prompt a human, so that tier stays client-only. */
export function coderPermsSet(perms: { tools: Record<string, string>; denyPaths: string[] }): Promise<unknown> {
  return postJSON<unknown>('/api/coder/perms', perms, 5000);
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
}, signal?: AbortSignal): Promise<CoderMemory> {
  return postJSON<CoderMemory>('/api/coder/memory', { learning }, 8000, signal);
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
 * `coderExec` (which executes in the workspace root), so no control-plane change
 * is needed. Returns [] when the workspace isn't a git repo or has no commits yet.
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
  // Order matters: greedy must win over a lingering temperature value, not
  // the other way round, or "deterministic" silently turns into "sampled".
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.greedy) body.temperature = 0;
  if (params.topP !== undefined) body.top_p = params.topP;
  if (params.topK !== undefined) body.top_k = params.topK;
  if (params.minP !== undefined) body.min_p = params.minP;
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty;
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty;
  if (params.seed !== undefined) body.seed = params.seed;
  return body;
}
