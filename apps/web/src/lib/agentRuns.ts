// Server-side agent runs — the control plane now owns the tool loop (the
// webview's runToolLoop, ported to Rust). The screens no longer drive
// stream → tool-call → recurse themselves: they start a RUN and ATTACH to
// it. Runs survive window close; several clients can attach at once (each
// gets a snapshot frame + the live event stream, so a second client
// re-syncs by reading the snapshot, not the delta history).
//
//   POST /api/agent/runs                     start
//   GET  /api/agent/runs                     list (light summaries)
//   GET  /api/agent/runs/{id}                full snapshot
//   POST /api/agent/runs/{id}/stop           abort (in-flight reads die)
//   POST /api/agent/runs/{id}/approvals/{aid}  decide a paused approval
//   POST /api/agent/runs/{id}/questions/{qid} answer a paused ask_user
//   GET  /api/agent/runs/{id}/events         SSE attach (snapshot frame,
//                                            then one frame per event)
//
// Wire notes:
//  * the first SSE frame is `event: state` with a RunSnapshot as its data —
//    treat it as the source of truth, then apply events on top;
//  * `delta` frames carry {kind: 'content'|'reasoning', text} for the turn
//    that is currently streaming (start rendering on `turn_started`);
//  * `appended` frames carry the finished messages (assistant turn and/or
//    tool results) to commit into the transcript;
//  * `approval_requested` pauses the run — mint a one-shot token through
//    the existing /api/coder/perms/approve flow, then POST the decision;
//  * `done`/`error` are terminal; the snapshot's `status` is always the
//    ground truth a re-attaching client reads first.

import { API_BASE, getJSON, postJSON } from './api/core';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type RunStatusWire = 'running' | 'awaiting_approval' | 'awaiting_user' | 'awaiting_hook' | 'awaiting_gate' | 'done' | 'stopped' | 'error';

export interface PendingApprovalWire {
  id: string;
  tool: string;
  rel: string | null;
  args: string;
  askedAt: number;
}

export interface RunUsageWire {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  [k: string]: number;
}

/** One entry of the run's canonical transcript (engine wire shape). */
export interface RunMessageWire {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning?: string | null;
  tool_calls?: { id: string; name: string; arguments: string }[] | null;
  tool_call_id?: string;
  name?: string;
  [k: string]: unknown;
}

export interface RunSnapshot {
  id: string;
  kind: string;
  label: string;
  model: string;
  system?: string | null;
  maxSteps?: number;
  createdAt?: number;
  toolSet?: string;
  toolNames?: string[];
  parent?: string | null;
  status: RunStatusWire;
  messages: RunMessageWire[];
  turns: number;
  updatedAt: number;
  finishReason: string | null;
  error: string | null;
  stop: string | null;
  pendingApprovals: PendingApprovalWire[];
  userQuestion: { id: string; question: string } | null;
  /** A pending risky/commit gate pause (the polling client's dialog). */
  pendingGate: { id: string; kind: 'risky' | 'commit'; command: string; reason: string | null } | null;
  scope: string | null;
  todo?: unknown | null;
  usage: RunUsageWire;
  lastMeta: Record<string, unknown> | null;
  hookMode?: string;
  pendingHook?: string | null;
  plan?: boolean;
  todoRev?: number;
}

export interface RunSummary {
  id: string;
  kind: string;
  label: string;
  model: string;
  status: RunStatusWire;
  turns: number;
  maxSteps: number;
  createdAt: number;
  updatedAt: number;
  stop: string | null;
  parent: string | null;
  pendingApprovals: number;
}

/** Body for POST /api/agent/runs. */
export interface StartRunBody {
  /** Seed transcript (engine wire shape) — the conversation so far. */
  messages: RunMessageWire[];
  /** 'chat' | 'coder' | 'scout' | 'worker' — drives prompts/tool-set docs. */
  kind?: string;
  label?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** JSON string of extra headers forwarded to the cloud provider. */
  extraHeaders?: string;
  /** Fall back to the local engine on cloud 429/5xx (default true for cloud runs). */
  allowFallback?: boolean;
  system?: string | null;
  maxSteps?: number;
  /** 'chat' | 'coder' — selects the tool table the server enforces. */
  toolSet?: string;
  /** Names this run may call (server filters against the table). */
  toolNames?: string[];
  /** Tool specs to advertise (OpenAI function shape). */
  tools?: unknown[];
  /** Engine request params (thinking, temperature, …). */
  params?: Record<string, unknown> | null;
  /** Permission scope bucket (workspace path) for in-process dispatch. */
  scope?: string | null;
  /** Child runs set this (the parent run's id). */
  parent?: string | null;
  /** 'client' pauses at each turn end for this screen's rewrite/gate decision (reflection, humanize); omit for uninterrupted runs. */
  hookMode?: 'client' | 'auto';
  /** Risky-command gate: pause bash on risky-but-allowed commands. */
  riskyGate?: boolean;
  /** Commit-approval gate: pause bash on `git commit` commands. */
  commitGate?: boolean;
  /** Pre-approved (normalized) commands for the risky gate. */
  approvedCommands?: string[];
}
export interface RunEvent {
  type:
    | 'state'
    | 'delta'
    | 'turn_started'
    | 'appended'
    | 'tool_call'
    | 'tool_result'
    | 'approval_requested'
    | 'approval_resolved'
    | 'user_question_requested'
    | 'todo'
    | 'hook_requested'
    | 'hook_resolved'
    | 'gate_requested'
    | 'gate_resolved'
    | 'child_run'
    | 'status'
    | 'done'
    | 'error';
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export const agentRunsApi = {
  start(body: StartRunBody, signal?: AbortSignal): Promise<{ id: string; status: string }> {
    return postJSON('/api/agent/runs', body, 10_000, signal);
  },
  list(): Promise<RunSummary[]> {
    return getJSON<RunSummary[]>('/api/agent/runs', 4000);
  },
  get(id: string): Promise<RunSnapshot> {
    return getJSON<RunSnapshot>(`/api/agent/runs/${encodeURIComponent(id)}`, 4000);
  },
  stop(id: string): Promise<{ ok: boolean }> {
    return postJSON(`/api/agent/runs/${encodeURIComponent(id)}/stop`, {}, 5000);
  },
  /** Decide a paused approval. `token` is the one-shot ticket minted via
   *  the existing /api/coder/perms/approve flow (required to approve). */
  approve(id: string, approvalId: string, decision: 'approve' | 'deny', token?: string): Promise<{ ok: boolean }> {
    return postJSON(
      `/api/agent/runs/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`,
      { decision, token },
      5000,
    );
  },
  answer(id: string, questionId: string, answer: string): Promise<{ ok: boolean }> {
    return postJSON(
      `/api/agent/runs/${encodeURIComponent(id)}/questions/${encodeURIComponent(questionId)}`,
      { answer },
      5000,
    );
  },
  /** Turn-hook mode: 'client' pauses at each turn end (hook_requested) for
   *  the screen's rewrite/gate decision, 'auto' finishes turns unpaused.
   *  Prefer StartRunBody.hookMode — this is for runs already started. */
  setHookMode(id: string, mode: 'client' | 'auto'): Promise<{ ok: boolean }> {
    return postJSON(`/api/agent/runs/${encodeURIComponent(id)}/hook`, { mode }, 5000);
  },
  /** Resolve a pending turn-hook pause. `content` replaces the turn's reply
   *  (replace), or rides along with the gate note (continue). */
  decideHook(
    id: string,
    hookId: string,
    body: { action: 'done' | 'replace' | 'continue' | 'abort'; content?: string; note?: string; transcript?: unknown[] },
  ): Promise<{ ok: boolean }> {
    return postJSON(`/api/agent/runs/${encodeURIComponent(id)}/hooks/${encodeURIComponent(hookId)}`, body, 5000);
  },
  /** Resolve a pending risky/commit gate. Risky: once|remember|deny;
   *  commit: approve|deny. */
  decideGate(
    id: string,
    gateId: string,
    decision: 'once' | 'remember' | 'deny' | 'approve',
  ): Promise<{ ok: boolean; decision: string }> {
    return postJSON(
      `/api/agent/runs/${encodeURIComponent(id)}/gates/${encodeURIComponent(gateId)}`,
      { decision },
      5000,
    );
  },
};
// ---------------------------------------------------------------------------
// SSE attach
// ---------------------------------------------------------------------------

/**
 * Attach to a run's event stream. Fetch-based (not EventSource) so the
 * Tauri loopback origin + abort signals work the way every other api/*.ts
 * call does. Sequence per attach:
 *
 *   1. `onSnapshot(snapshot)` — the run's full state (resync point);
 *   2. `onEvent(ev)` per frame;
 *   3. if the stream drops while the run is still live, re-attach from a
 *      fresh snapshot (the server never lost events; a dropped socket
 *      just missed its window) — `onDrop` fires so the UI can blink.
 *
 * Call `close()` on unmount / when the run is terminal.
 */
export class RunStream {
  private ctrl: AbortController;
  private closed = false;
  private running = false;
  private terminal: boolean;

  constructor(
    private runId: string,
    private onSnapshot: (snap: RunSnapshot) => void,
    private onEvent: (ev: RunEvent) => void,
    private onDrop: (reason: 'resync' | 'closed' | 'error') => void,
  ) {
    this.ctrl = new AbortController();
    this.terminal = false;
  }

  /** Start attaching. Returns when the run is terminal (or closed()). */
  attach(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    return this.loop().finally(() => {
      this.running = false;
    });
  }

  close(): void {
    this.closed = true;
    this.ctrl.abort();
  }

  private get done(): boolean {
    return this.closed || this.terminal;
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (this.done) return;
      let snap: RunSnapshot;
      try {
        snap = await agentRunsApi.get(this.runId);
      } catch {
        // Run vanished (or server hiccups) — nothing to resync to.
        this.onDrop('closed');
        return;
      }
      if (this.done) return;
      this.onSnapshot(snap);
      if (isTerminalStatus(snap.status)) {
        this.terminal = true;
        return;
      }
      try {
        await this.consume();
      } catch {
        if (this.done) return;
        // Stream cut mid-run: the run is (presumably) still going — resync.
        this.onDrop('resync');
        await sleep(750);
        if (this.done) return;
        continue;
      }
      // Stream ended cleanly.
      const cur = await agentRunsApi.get(this.runId).catch(() => null);
      if (!cur) {
        this.onDrop('closed');
        return;
      }
      if (isTerminalStatus(cur.status)) {
        this.terminal = true;
        this.onSnapshot(cur);
        return;
      }
      this.onDrop('resync');
      await sleep(400);
    }
  }

  private async consume(): Promise<void> {
    const r = await fetch(`${API_BASE}/api/agent/runs/${encodeURIComponent(this.runId)}/events`, {
      signal: this.ctrl.signal,
    });
    if (!r.ok || !r.body) {
      // 404 → the run is gone; anything else → treat as a cut.
      if (r.status === 404) {
        this.onDrop('closed');
        throw new Error('run gone');
      }
      throw new Error(`events → HTTP ${r.status}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    // The server re-sends the snapshot as its first frame (`event: state`)
    // — apply it (it is newer than the one we fetched moments ago).
    let sawStateFrame = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const ev = parseFrame(frame);
        if (!ev) continue;
        if (ev.type === 'state') {
          if (!sawStateFrame) {
            sawStateFrame = true;
            this.onSnapshot((ev as unknown as { snapshot: RunSnapshot }).snapshot);
          }
          continue;
        }
        this.onEvent(ev);
        if (ev.type === 'done' || ev.type === 'error') {
          this.terminal = true;
          return;
        }
      }
      if (this.done) return;
    }
  }
}

function parseFrame(frame: string): RunEvent | null {
  const lines = frame.split('\n');
  let data = '';
  for (const line of lines) {
    if (line.startsWith('data: ')) data += (data ? '\n' : '') + line.slice(6);
    else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5);
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as RunEvent;
  } catch {
    return null;
  }
}

export function isTerminalStatus(s: RunStatusWire): boolean {
  return s === 'done' || s === 'stopped' || s === 'error';
}

/** Map a snapshot's transcript to the client's ChatMessage[] shape (the
 *  shape the screens render and the shape the NEXT run's seed messages
 *  need — so `snapshotToMessages` output round-trips into StartRunBody). */
export function snapshotToMessages(snap: Pick<RunSnapshot, 'messages'>) {
  return snap.messages;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
