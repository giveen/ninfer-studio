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
export function coderRepoMap(workspace?: string): Promise<{ map: string }> {
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  return getJSON<{ map: string }>(`/api/coder/repo_map${qs}`);
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
export function coderDirs(root: string, workspace?: string): Promise<CoderDirs> {
  const ws = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
  return getJSON<CoderDirs>(`/api/coder/dirs?root=${encodeURIComponent(root)}${ws}`);
}
export function coderTree(depth = 3, root = '.', workspace?: string): Promise<CoderTree> {
  const ws = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
  return getJSON<CoderTree>(`/api/coder/tree?depth=${depth}&root=${encodeURIComponent(root)}${ws}`);
}
export function coderRead(path: string, offset?: number, limit?: number, signal?: AbortSignal, workspace?: string, approvalToken?: string): Promise<CoderReadResult> {
  return postJSON<CoderReadResult>('/api/coder/fs/read', { path, offset, limit, workspace, approvalToken }, 8000, signal);
}
export interface CoderBase64Result {
  path: string;
  mime: string;
  dataUrl: string;
  size: number;
}
export function coderReadBase64(path: string, workspace?: string): Promise<CoderBase64Result> {
  return postJSON<CoderBase64Result>('/api/coder/fs/b64', { path, workspace }, 15_000);
}
export function coderWrite(path: string, content: string, signal?: AbortSignal, workspace?: string, approvalToken?: string): Promise<CoderWriteResult> {
  return postJSON<CoderWriteResult>('/api/coder/fs/write', { path, content, workspace, approvalToken }, 16_000_000, signal);
}
export function coderEdit(path: string, oldStr: string, newStr: string, replaceAll = false, signal?: AbortSignal, workspace?: string, approvalToken?: string): Promise<CoderEditResult> {
  return postJSON<CoderEditResult>('/api/coder/fs/edit', { path, old: oldStr, new: newStr, replaceAll, workspace, approvalToken }, 16_000_000, signal);
}
export interface CoderPatchEdit { old: string; new: string; replaceAll?: boolean; }
export function coderPatch(path: string, edits: CoderPatchEdit[], signal?: AbortSignal, workspace?: string, approvalToken?: string): Promise<CoderEditResult> {
  return postJSON<CoderEditResult>('/api/coder/fs/patch', { path, edits, workspace, approvalToken }, 16_000_000, signal);
}
export function coderExec(command: string, cwd?: string, timeoutMs?: number, sessionId?: string, background?: boolean, signal?: AbortSignal, workspace?: string, approvalToken?: string): Promise<CoderExecResult> {
  // The client-side fetch timeout must be at least as long as the server-side
  // exec timeout it's requesting (timeoutMs, server default 120s) — it used to
  // be hardcoded to 15s regardless, so any command running longer than that
  // threw a spurious client-side timeout while the server kept working.
  const fetchTimeoutMs = Math.max(15_000, (timeoutMs ?? 120_000) + 5_000);
  return postJSON<CoderExecResult>('/api/coder/exec', { command, cwd, timeoutMs, sessionId, background, workspace, approvalToken }, fetchTimeoutMs, signal);
}
export function coderJob(jobId: string, signal?: AbortSignal, workspace?: string): Promise<CoderJob> {
  const ws = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  return getJSON<CoderJob>(`/api/coder/jobs/${encodeURIComponent(jobId)}${ws}`, 15_000, signal);
}
export function coderJobKill(jobId: string, workspace?: string): Promise<CoderJob> {
  return postJSON<CoderJob>(`/api/coder/jobs/${encodeURIComponent(jobId)}/kill`, { workspace }, 15_000);
}
export function coderGrep(
  pattern: string,
  path?: string,
  include?: string,
  ignoreCase?: boolean,
  offset = 0,
  limit = 200,
  signal?: AbortSignal,
  workspace?: string,
  approvalToken?: string,
): Promise<CoderGrepResult> {
  return postJSON<CoderGrepResult>('/api/coder/grep', { pattern, path, include, ignoreCase, offset, limit, workspace, approvalToken }, 15_000, signal);
}
export function coderGlob(pattern: string, path?: string, offset = 0, limit = 200, signal?: AbortSignal, workspace?: string, approvalToken?: string): Promise<CoderGlobResult> {
  return postJSON<CoderGlobResult>('/api/coder/glob', { pattern, path, offset, limit, workspace, approvalToken }, 15_000, signal);
}
export interface CoderSearchResult {
  results: Array<{ file: string; line: number; snippet: string; score: number; kind: string }>;
  truncated: boolean;
}
export function coderSearch(query: string, limit = 15, signal?: AbortSignal, workspace?: string): Promise<CoderSearchResult> {
  const ws = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
  return getJSON<CoderSearchResult>(`/api/coder/search?q=${encodeURIComponent(query)}&limit=${limit}${ws}`, 15000, signal);
}
export interface CoderDiffResult {
  files: Array<{ path: string; bar?: string }>;
  diff: string;
  truncated?: boolean;
  error?: string;
}
export function coderDiff(workspace?: string): Promise<CoderDiffResult> {
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  return getJSON<CoderDiffResult>(`/api/coder/diff${qs}`, 60000);
}
export function coderWebFetch(url: string, signal?: AbortSignal, approvalToken?: string, workspace?: string): Promise<CoderWebFetch> {
  return postJSON<CoderWebFetch>('/api/coder/web/fetch', { url, approvalToken, workspace }, 20_000, signal);
}
export function coderWebSearch(query: string, signal?: AbortSignal, approvalToken?: string, workspace?: string): Promise<CoderWebSearch> {
  return postJSON<CoderWebSearch>('/api/coder/web/search', { query, approvalToken, workspace }, 20_000, signal);
}
export interface CoderBrowserResult {
  ok?: boolean;
  url?: string;
  title?: string;
  content?: string;
  truncated?: boolean;
  result?: unknown;
  found?: boolean;
  open?: boolean;
  /** Idle duration in seconds reported directly from the underlying browser engine payload. */
  idle_seconds?: number;
  error?: string;
}
export function coderBrowser(action: string, args: Record<string, string | number> = {}, signal?: AbortSignal, approvalToken?: string, workspace?: string): Promise<CoderBrowserResult> {
  return postJSON<CoderBrowserResult>('/api/coder/browser', { action, ...args, approvalToken, workspace }, 45_000, signal);
}
const boolToggle = (path: string) => ({
  get: () => getJSON<{ enabled: boolean }>(path, 5000),
  set: (enabled: boolean) => postJSON<{ enabled: boolean }>(path, { enabled }, 5000),
});

const safeMode = boolToggle('/api/coder/safe-mode');
export const coderSafeModeGet = safeMode.get;
export const coderSafeModeSet = safeMode.set;

const commitApproval = boolToggle('/api/coder/commit-approval');
export const coderCommitApprovalGet = commitApproval.get;
export const coderCommitApprovalSet = commitApproval.set;

/** Mirrors the active workspace's tool permission tiers + denied paths to the
 *  control plane, so `deny`/denied-prefix (and, with a valid token from
 *  `coderPermsApprove`, `ask`) are enforced at the endpoint itself — not only
 *  by this client's own dispatcher, which an agent could otherwise route
 *  around (e.g. `bash` curling straight at an endpoint). */
export function coderPermsSet(perms: { tools: Record<string, string>; denyPaths: string[] }, scope?: string): Promise<unknown> {
  return postJSON<unknown>('/api/coder/perms', { ...perms, scope }, 5000);
}
/** Called the moment a human approves an `ask`-tiered tool call in the UI's
 *  own dialog. Mints a short-lived, single-use token the client then attaches
 *  to the actual tool-call request as `approvalToken` — without this, the
 *  endpoint has no way to tell an approved call apart from one that skipped
 *  the dialog entirely. `scope` must match the tool call's target workspace/scope. */
export function coderPermsApprove(tool: string, path?: string, scope?: string): Promise<{ token: string }> {
  return postJSON<{ token: string }>('/api/coder/perms/approve', { tool, path, scope }, 5000);
}
export interface SandboxStatus {
  enabled: boolean;
  sandboxBinds: string[];
  /** Legacy alias — true only when the active mechanism is bwrap AND it can run here. */
  bwrapAvailable: boolean;
  /** Whether the active sandbox mechanism can actually run on this host. */
  available: boolean;
  /** Active mechanism: "bwrap" (Linux) or "windows-job-mic" (Windows). */
  kind: string;
}
export function coderSandboxGet(): Promise<SandboxStatus> {
  return getJSON<SandboxStatus>('/api/coder/sandbox', 5000);
}
export function coderSandboxSet(enabled: boolean): Promise<SandboxStatus> {
  return postJSON<SandboxStatus>('/api/coder/sandbox', { enabled }, 5000);
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
  id: string;
  component: string;
  scope: string;
  target_key: string;
  value: string;
  text: string;
  /** 'success' (a fix that worked), 'tip' (a convention to follow), or 'avoid' (an anti-pattern to steer away from) */
  kind: CoderLearningKind;
  /** Where the learning came from (e.g. "critic:approve", "critic:reject", "tool"). */
  provenance?: string;
  /** Short task description the learning was extracted from, if known. */
  task?: string;
  /** ISO timestamp. */
  ts: string;
}

export interface CoderMemory {
  /** Optional per-repo markdown memory bank content. */
  bank?: string;
  /** Unstructured list of learnings; the active ones are filtered at runtime based on the domain schema. */
  learnings: CoderLearning[];
}

/** Read the current memory bank + learnings for a workspace (falls back to active workspace). */
export function coderMemoryGet(workspace?: string): Promise<CoderMemory> {
  const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  return getJSON<CoderMemory>(`/api/coder/memory${qs}`, 8000);
}

/** Update the per-repo markdown memory bank text for a workspace. */
export function coderMemorySetBank(bank: string, workspace?: string): Promise<CoderMemory> {
  return postJSON<CoderMemory>('/api/coder/memory', { bank, workspace }, 8000);
}

/** Append one structured learning (text + kind) and return the updated memory. */
export function coderMemoryAddLearning(learning: {
  text: string;
  kind: CoderLearningKind;
  component?: string;
  scope?: string;
  target_key?: string;
  value?: string;
  provenance?: string;
  task?: string;
}, signal?: AbortSignal, workspace?: string): Promise<CoderMemory> {
  return postJSON<CoderMemory>('/api/coder/memory', { learning, workspace }, 8000, signal);
}

/** Drop a single learning by id and return the updated memory. */
export function coderMemoryDropLearning(id: string, workspace?: string): Promise<CoderMemory> {
  return postJSON<CoderMemory>('/api/coder/memory', { dropLearningId: id, workspace }, 8000);
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
export async function coderGitLog(limit = 100, signal?: AbortSignal, workspace?: string, approvalToken?: string): Promise<CoderCommit[]> {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const fmt = '%H%x1f%an%x1f%ar%x1f%ad%x1f%s%x1f%b%x1e';
  const r = await coderExec(`git log --pretty=format:${fmt} -n ${safeLimit}`, undefined, undefined, undefined, false, signal, workspace, approvalToken);
  if (r.exitCode !== 0 || !r.stdout.trim()) return [];
  return parseCoderGitLogStdout(r.stdout);
}

export function parseCoderGitLogStdout(stdout: string): CoderCommit[] {
  const HASH_RE = /^[0-9a-f]{7,40}$/;
  return stdout
    .split('\x1e')
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec): CoderCommit | null => {
      const parts = rec.split('\x1f');
      if (parts.length !== 6 || !HASH_RE.test(parts[0] || '')) return null;
      const [hash, author, relDate, date, subject, body] = parts;
      return { hash, author, relDate, date, subject, body: (body || '').trim() };
    })
    .filter((c): c is CoderCommit => c !== null);
}

