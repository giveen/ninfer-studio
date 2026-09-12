// The coder harness's persisted conversation store: a workspace holds an
// ordered list of independent conversations (mirrors deepseek-harness's
// Sessions-per-Workspace tree). Selecting a workspace expands it; clicking a
// conversation row loads that conversation's messages, ledger, and todos, so
// you can hop between threads and come back to them later. Pure data shapes
// + localStorage load/normalize — no React, no closure state.

import { ChatMessage } from './types';
import { PermConfig } from './coderTools';
import { getConfig, coderRead } from './api';

export type LogEntry = { id: string; time: number; type: 'bash' | 'read' | 'write' | 'edit' | 'grep' | 'glob' | 'web' | 'todo' | 'error' | 'compact' | 'ask'; label: string; detail?: string; durationMs?: number };
export type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed' };

export interface ConvMeta {
  /** Linked worktree path for this conversation, relative to the main workspace. */
  worktree?: string;
  /** Files/folders pinned from the Tree panel so the system prompt "follows" them. */
  boundPaths?: string[];
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  ledger: LogEntry[];
  todos: TodoItem[];
  /** When this conversation's task list last changed (tool call or user
   *  edit) — persisted per conversation so switching never shows another
   *  conversation's "last updated" time. */
  todosUpdatedAt?: number;
  lastPromptTokens: number;
  archived?: boolean;
  checkpoints?: Checkpoint[];
}
/** A restore point: transcript/todo snapshot + the workspace commit to reset to. */
export interface Checkpoint {
  id: string;
  time: number;
  label: string;
  commit: string;
  messages: number;
  ledger: number;
  todos: TodoItem[];
}
export interface WsData {
  expanded: boolean;
  conversations: Record<string, ConvMeta>;
  order: string[];
  activeConv?: string;
  /** Per-workspace tool permission tiers + denied path prefixes. */
  perms?: PermConfig;
}
export interface CoderStore {
  activeWs: string;
  activeConv: string;
  workspaces: Record<string, WsData>;
}

export const CONV_KEY = 'ninfier.coder.conversations.v2';
export const CONV_V1_KEY = 'ninfier.coder.conversations.v1';

export function newConvId(): string {
  return 'conv-' + crypto.randomUUID();
}
export function emptyConv(id: string): ConvMeta {
  return { id, title: 'New conversation', updatedAt: Date.now(), messages: [], ledger: [], todos: [], lastPromptTokens: 0 };
}
export function baseName(p: string): string {
  const t = p.replace(/[/\\]+$/, '');
  const parts = t.split(/[/\\]/);
  return parts[parts.length - 1] || t || p || '(root)';
}
export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  if (diff < MIN) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}mo`;
  return `${Math.floor(diff / (365 * DAY))}y`;
}
export function stripExtPrefix(p: string): string {
  let rest: string | null = null;
  for (const pre of ['\\\\?\\', '\\\\?/', '//?/']) {
    if (p.startsWith(pre)) { rest = p.slice(pre.length); break; }
  }
  if (rest === null) return p;
  for (const unc of ['UNC\\', 'UNC/']) {
    if (rest.startsWith(unc)) return '\\\\' + rest.slice(unc.length).replace(/\//g, '\\');
  }
  return rest;
}

/** Render the live task list as a system-prompt block. Injected into the
 *  supervisor's system prompt every turn so the plan (a) survives
 *  auto-compaction of the conversation and (b) reflects user edits made
 *  mid-run (added/removed/retasked items) on the very next LLM call. */
export function todoSystemBlock(todos: TodoItem[]): string {
  const mark = (s: string) => (s === 'completed' ? 'x' : s === 'in_progress' ? '~' : ' ');
  // An empty list still gets a block, with an explicit marker: the
  // conversation (and any compaction summary) may still contain an older
  // non-empty list, so without this the next turn has no system-level
  // signal the plan is now empty and could resume stale work.
  const lines = todos.length
    ? todos.map((t, i) => `${i + 1}. [${mark(t.status)}] ${t.content}`)
    : ['(no active tasks — the task list was cleared; do not resume work from an earlier plan unless the user asks or re-adds a task)'];
  return `\n\n# Current task list (live — maintained by todo_write, editable by the user; keep it in sync with your actual progress)\n${lines.join('\n')}\n`;
}
export function normalizeStore(s: CoderStore): CoderStore {
  const workspaces = { ...s.workspaces };
  // Windows migration: older builds stored the workspace key with Rust's
  // extended-length prefix (`\\?\\C:\tmp` from canonicalize) while the
  // picker produces the plain form — the mismatch made every start seed a
  // duplicate workspace with a fresh conversation. Merge prefixed entries
  // into their plain twin (deduped by conversation id).
  for (const [key, ws] of Object.entries(workspaces)) {
    const plain = stripExtPrefix(key);
    if (plain === key) continue;
    delete workspaces[key];
    const twin = workspaces[plain];
    if (!twin) {
      workspaces[plain] = ws;
      continue;
    }
    const merged: WsData = { ...twin, conversations: { ...twin.conversations }, order: [...twin.order], expanded: twin.expanded || ws.expanded };
    for (const [cid, conv] of Object.entries(ws.conversations)) {
      if (!merged.conversations[cid]) {
        merged.conversations[cid] = conv;
        merged.order.push(cid);
      }
    }
    merged.activeConv = twin.activeConv && merged.conversations[twin.activeConv] ? twin.activeConv : merged.order[0] ?? '';
    workspaces[plain] = merged;
  }
  let activeWs = stripExtPrefix(s.activeWs);
  let activeConv = s.activeConv;
  if (!activeWs || !workspaces[activeWs]) {
    activeWs = Object.keys(workspaces)[0] ?? '';
    activeConv = activeWs ? (workspaces[activeWs].activeConv ?? workspaces[activeWs].order[0] ?? '') : '';
  } else {
    const wsd = workspaces[activeWs];
    activeConv = wsd.activeConv ?? wsd.order[0] ?? '';
    if (activeConv && !wsd.conversations[activeConv]) activeConv = wsd.order[0] ?? '';
  }
  return { activeWs, activeConv, workspaces };
}
export function loadStore(): CoderStore {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CoderStore;
      if (parsed && parsed.workspaces) return normalizeStore(parsed);
    }
  } catch { /* ignore */ }
  // Migrate the previous single-conversation-per-workspace format.
  try {
    const raw = localStorage.getItem(CONV_V1_KEY);
    if (raw) {
      const v1 = JSON.parse(raw) as Record<string, { messages: ChatMessage[]; ledger: LogEntry[]; todos: TodoItem[]; lastPromptTokens: number }>;
      const workspaces: Record<string, WsData> = {};
      for (const [ws, conv] of Object.entries(v1)) {
        const id = newConvId();
        workspaces[ws] = {
          expanded: true,
          conversations: { [id]: { id, title: 'Conversation', updatedAt: Date.now(), messages: conv.messages || [], ledger: conv.ledger || [], todos: conv.todos || [], lastPromptTokens: conv.lastPromptTokens || 0 } },
          order: [id],
          activeConv: id,
        };
      }
      const first = Object.keys(workspaces)[0] ?? '';
      const activeConv = first ? workspaces[first].activeConv! : '';
      return { activeWs: first, activeConv, workspaces };
    }
  } catch { /* ignore */ }
  return { activeWs: '', activeConv: '', workspaces: {} };
}

// ---- Verification gate helpers ------------------------------------------------
/** Detect lint/test/build commands: explicit config first, else infer from manifests. */
export async function detectCommands(): Promise<{ lint?: string; test?: string; build?: string }> {
  try {
    const cfg = await getConfig();
    if (cfg.lintCommand || cfg.testCommand || cfg.buildCommand) {
      return { lint: cfg.lintCommand, test: cfg.testCommand, build: cfg.buildCommand };
    }
  } catch { /* ignore */ }
  const read = async (p: string): Promise<string | null> => {
    try { const r = await coderRead(p, 0, 200); return r.binary ? null : (r.content || null); } catch { return null; }
  };
  const pkg = await read('package.json');
  if (pkg) { try { const s = (JSON.parse(pkg).scripts) || {}; return { lint: s.lint, test: s.test, build: s.build }; } catch { /* not json */ } }
  const cargo = await read('Cargo.toml');
  if (cargo) return { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy -- -D warnings' };
  const mk = await read('Makefile');
  if (mk) {
    const has = (t: string) => new RegExp(`^${t}:`, 'm').test(mk);
    return { lint: has('lint') ? 'make lint' : undefined, test: has('test') ? 'make test' : undefined, build: has('build') ? 'make build' : undefined };
  }
  const py = await read('pyproject.toml');
  if (py) return { test: 'pytest', lint: 'ruff check .' };
  return {};
}
