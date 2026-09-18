// The coder harness's persisted conversation store: a workspace holds an
// ordered list of independent conversations (mirrors deepseek-harness's
// Sessions-per-Workspace tree). Selecting a workspace expands it; clicking a
// conversation row loads that conversation's messages, ledger, and todos, so
// you can hop between threads and come back to them later. Pure data shapes
// + localStorage load/normalize — no React, no closure state.

import { ChatMessage } from './types';
import { PermConfig, DEFAULT_PERMS } from './coderTools';
import { getConfig, coderRead } from './api';

export type LogEntry = { id: string; time: number; type: 'bash' | 'read' | 'write' | 'edit' | 'grep' | 'glob' | 'web' | 'todo' | 'error' | 'compact' | 'ask'; label: string; detail?: string; durationMs?: number; provider?: 'cloud' | 'local' };
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
  messageCount: number;
  ledgerCount: number;
  /** Legacy field aliases retained for backward-compatibility with older persisted JSON. */
  messages?: number;
  ledger?: number;
  todos: TodoItem[];
  /** Taken automatically before the turn's first mutating tool call, rather
   *  than via the manual "+ checkpoint" button — kept out of the way (not
   *  auto-opened) and capped separately so a long session doesn't grow
   *  localStorage unbounded. */
  auto?: boolean;
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
const CONV_V1_KEY = 'ninfier.coder.conversations.v1';

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
  if (diff < 0) return 'now';
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
    const candidate = activeConv || wsd.activeConv;
    activeConv = (candidate && wsd.conversations[candidate]) ? candidate : (wsd.activeConv && wsd.conversations[wsd.activeConv]) ? wsd.activeConv : (wsd.order[0] ?? '');
    wsd.activeConv = activeConv;
  }
  return { activeWs, activeConv, workspaces };
}
export function pruneStoreForStorage(store: CoderStore): CoderStore {
  const cloned: CoderStore = JSON.parse(JSON.stringify(store));
  for (const [wsKey, ws] of Object.entries(cloned.workspaces)) {
    for (const [convId, conv] of Object.entries(ws.conversations)) {
      const isActive = wsKey === cloned.activeWs && convId === cloned.activeConv;
      // Cap ledger entries (active: 300, non-active: 50)
      const maxLedger = isActive ? 300 : 50;
      if (conv.ledger && conv.ledger.length > maxLedger) {
        conv.ledger = conv.ledger.slice(-maxLedger);
      }
      // Cap checkpoints (active: 10, non-active: 2)
      if (conv.checkpoints && conv.checkpoints.length > (isActive ? 10 : 2)) {
        conv.checkpoints = conv.checkpoints.slice(-(isActive ? 10 : 2));
      }
      // Truncate non-active conversation messages if excessive (keep last 60 messages)
      if (!isActive && conv.messages && conv.messages.length > 60) {
        conv.messages = conv.messages.slice(-60);
      }
    }
  }
  return cloned;
}

export function saveStore(store: CoderStore): boolean {
  try {
    localStorage.setItem(CONV_KEY, JSON.stringify(store));
    return true;
  } catch (err) {
    console.warn('Failed to persist conversation store to localStorage, attempting pruned save...', err);
    try {
      const pruned = pruneStoreForStorage(store);
      localStorage.setItem(CONV_KEY, JSON.stringify(pruned));
      return true;
    } catch (prunedErr) {
      console.warn('Failed to persist pruned conversation store to localStorage:', prunedErr);
      return false;
    }
  }
}

let debouncedSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingStoreToSave: CoderStore | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (pendingStoreToSave !== null) {
      saveStore(pendingStoreToSave);
      pendingStoreToSave = null;
    }
  });
}

export function saveStoreDebounced(store: CoderStore, delayMs = 500, onError?: (err: unknown) => void): void {
  pendingStoreToSave = store;
  if (debouncedSaveTimer !== null) {
    clearTimeout(debouncedSaveTimer);
  }
  debouncedSaveTimer = setTimeout(() => {
    debouncedSaveTimer = null;
    if (pendingStoreToSave) {
      const ok = saveStore(pendingStoreToSave);
      if (!ok && onError) onError(new Error('QuotaExceededError: Failed to persist conversation store'));
      pendingStoreToSave = null;
    }
  }, delayMs);
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
      const migrated: CoderStore = { activeWs: first, activeConv, workspaces };
      try {
        saveStore(migrated);
        localStorage.removeItem(CONV_V1_KEY);
      } catch { /* ignore */ }
      return migrated;
    }
  } catch { /* ignore */ }
  return { activeWs: '', activeConv: '', workspaces: {} };
}

// ---- Default permissions template ---------------------------------------------
// The tool-tier/denyPaths template used to seed a NEW workspace's `perms` the
// first time it's created (Settings > Safety & Permissions). Purely additive:
// changing the template never touches a workspace that already has its own
// `perms` value written (see the two WsData-construction sites in
// CoderScreen.tsx that call loadDefaultPerms()).
const DEFAULT_PERMS_KEY = 'ninfier.coder.defaultPerms.v1';

export function loadDefaultPerms(): PermConfig {
  try {
    const raw = localStorage.getItem(DEFAULT_PERMS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        return { tools: p.tools ?? {}, denyPaths: Array.isArray(p.denyPaths) ? p.denyPaths : [] };
      }
    }
  } catch { /* ignore */ }
  return { tools: { ...DEFAULT_PERMS.tools }, denyPaths: [...DEFAULT_PERMS.denyPaths] };
}

export function saveDefaultPerms(perms: PermConfig): void {
  try {
    localStorage.setItem(DEFAULT_PERMS_KEY, JSON.stringify({ tools: perms.tools, denyPaths: perms.denyPaths }));
  } catch { /* ignore */ }
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
  if (pkg) {
    try {
      const s = (JSON.parse(pkg).scripts) || {};
      if (s.lint || s.test || s.build) {
        return { lint: s.lint, test: s.test, build: s.build };
      }
    } catch { /* not json */ }
  }
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
