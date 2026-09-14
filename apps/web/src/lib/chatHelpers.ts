// Pure chat helpers: model-context building, params normalization, and the
// static tool/capability/slash-command data the composer and request
// builder read. No JSX, no closure over ChatScreen's component state.

import { frameCompactedSummary } from './api';
import { effectiveSystemPrompt } from './notai';
import type { ChatMessage, ChatParams, Conversation } from './types';
import type { CoderMemory } from './api/coder';
import { TOOLS, type PermConfig } from './coderTools';

// Build the model context for a conversation. When compacted, prepend the summary
// as leading context and keep only the messages added after compaction; the full
// visible history is preserved separately for browsing. Also drops empty/
// incomplete assistant turns (e.g. an aborted placeholder) so every call site
// gets the same "don't send a blank assistant message" behavior instead of
// each caller having to remember to filter it out itself.
export function modelHistory(conv: Conversation): ChatMessage[] {
  const tail = conv.compactedSummary ? conv.messages.slice(conv.compactedCount ?? 0) : conv.messages;
  const filtered = tail.filter((m) => m.role !== 'assistant' || m.meta?.finishReason || m.content);
  if (conv.compactedSummary) {
    const prefix: ChatMessage = { role: 'user', content: frameCompactedSummary(conv.compactedSummary) };
    return [prefix, ...filtered];
  }
  return filtered;
}

// A compacted conversation's summary is only valid as a prefix for a message
// array at least as long as compactedCount. Deleting/branching/regenerating/
// editing/clearing can shorten `messages` back to or past that boundary —
// keeping the old compaction state then makes modelHistory's slice come back
// empty, silently dropping every real message from the next request. Use
// this instead of a raw `{ ...conv, messages }` spread anywhere `messages`
// is being shortened or replaced.
export function withMessages(conv: Conversation, messages: ChatMessage[]): Conversation {
  if (conv.compactedSummary && messages.length <= (conv.compactedCount ?? 0)) {
    return { ...conv, messages, compactedSummary: undefined, compactedCount: undefined };
  }
  return { ...conv, messages };
}

// Windowing, not full virtualization: a conversation with hundreds of
// messages only mounts the most recent ones by default (each MessageRow
// pulls in markdown parsing, syntax highlighting, etc.) — a "show earlier
// messages" banner reveals the rest on demand. Deliberately simpler than a
// virtualized list: it doesn't need to touch find-in-conversation's
// scrollIntoView, the ResizeObserver-driven stick-to-bottom effect, or the
// lazy-loaded Markdown Suspense boundary, since it's just a plain array
// slice — the rendered DOM shrinks, but nothing about how it's measured or
// scrolled changes.
export const RECENT_MESSAGE_WINDOW = 60;

export const DEFAULT_PARAMS: ChatParams = {
  thinking: true,
  reasoningEffort: '',
  preserveThinking: true,
  maxTokens: null as unknown as number,
};

/** The chat UI renders full Markdown (images included), but without a
 *  capability statement the model assumes a text-only terminal and refuses
 *  to show pictures. Tell it what the interface can do. */
const CHAT_CAPABILITIES = [
  '# Rendering capabilities',
  '- This chat renders full Markdown, including images: to show a picture inline, emit `![alt](https://direct-image-url)` — the UI displays it as a real image.',
  '- You cannot generate images yourself. When the user attaches images or video, you can see their contents (vision input).',
  '- web_fetch returns a page as text/Markdown and cannot fetch binary image data itself, but its output includes an "## Images on this page" section listing every image URL found on the page (already resolved to absolute URLs) — copy one of those verbatim into a Markdown image tag to actually display it. Do not invent or guess an image URL; if the page has none listed, say so instead of fabricating one.',
].join('\n');

/** Current local date/time, in the user's own timezone (read from the OS via
 *  `Intl`, same source the UI's own clocks use). Without this the model has
 *  no notion of "today" beyond its training cutoff and can't reason about
 *  relative dates ("last week", "is this expired") or the user's local time
 *  of day. Recomputed on every call — never cache the result — so a
 *  long-running Chat/Coder session doesn't drift onto a stale date. */
export function localDateTimeBlock(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatted = now.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  return `# Current date and time\n${formatted} (${tz})`;
}

/** Bank + up to 15 most recent learnings, formatted the same way Coder
 *  injects its per-repo memory — omitted entirely when there's nothing to
 *  show, so an empty/never-used store adds no prompt overhead. */
function memoryBlock(memory: CoderMemory | undefined): string {
  if (!memory) return '';
  const blocks: string[] = [];
  if (memory.bank && memory.bank.trim()) {
    blocks.push(`# What you know about this user\n${memory.bank.trim()}`);
  }
  const recent = (memory.learnings ?? []).slice(-15);
  if (recent.length) {
    const tagged = recent.map((l) => `- [${l.kind}] ${l.text}`).join('\n');
    blocks.push(`# Learnings from prior conversations (most recent first)\n${tagged}`);
  }
  return blocks.join('\n\n');
}

/** Tells the model Computer Use's current directory so it can decide to call
 *  `set_directory` proactively (e.g. the user asks to work in their home
 *  folder) instead of needing a `pwd`-style round trip first. Omitted when
 *  Computer Use is off/unconfigured, matching `memoryBlock`'s pattern. */
function computerUseBlock(dir: string): string {
  if (!dir) return '';
  return `# Computer Use\nCurrent working directory for read/write/edit/bash/grep/glob/git_* below: ${dir}\nIf the user asks you to work somewhere else (their home folder, a project directory, ...), call \`set_directory\` first — don't assume the current one.`;
}

/** Without this the model guesses at its own tool list from generic training
 *  priors — and guesses wrong, both inventing tools that don't exist (e.g.
 *  "web_extractor") and denying ones it actually has (e.g. `read` when
 *  Computer Use is on). List exactly what this turn's request actually
 *  attaches, since that's the only source of truth the toggles produce. */
function toolsAvailableBlock(toolNames: string[]): string {
  if (!toolNames.length) return '';
  return `# Tools available\nYou have access to exactly these tools and no others this turn: ${toolNames.join(', ')}.\nDo not claim to have a tool that isn't in this list. Do not claim to lack a tool that is in this list — call it instead of guessing or refusing.`;
}

export const chatSystemWithCapabilities = (params: Parameters<typeof effectiveSystemPrompt>[0], memory?: CoderMemory, computerUseDir?: string, toolNames?: string[]): string => {
  const base = effectiveSystemPrompt(params);
  return [base, localDateTimeBlock(), CHAT_CAPABILITIES, toolsAvailableBlock(toolNames ?? []), memoryBlock(memory), computerUseBlock(computerUseDir ?? '')].filter(Boolean).join('\n\n');
};

export const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch web content (extracts Markdown).",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for up-to-date information.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }
  }
];

/** Agent Mode "research" tier adds this on top of CHAT_TOOLS — same schema
 *  as Coder's `browser` tool (coderTools.ts), workspace-independent (runs a
 *  sandboxed headless browser session, never touches the host filesystem),
 *  so it's safe to offer in Chat with no permission-tier gating. */
export const CHAT_BROWSER_TOOL = {
  type: "function",
  function: {
    name: "browser",
    description: "Built-in headless web browser (runs page JavaScript, unlike web_fetch). Use for JS-rendered pages. Actions: navigate (url), snapshot (page URL/title/Markdown), click (selector), fill (selector, value), press_key (key, optional selector), select_option (selector, value), evaluate (expression), wait_for (selector, optional timeout), close, status. Prefer web_fetch for simple static pages; use the browser when the content only renders via JavaScript.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["navigate", "snapshot", "click", "fill", "press_key", "select_option", "evaluate", "wait_for", "close", "status"] },
        url: { type: "string", description: "For navigate." },
        wait_until: { type: "string", enum: ["domcontentloaded", "load"], description: "navigate only, default domcontentloaded." },
        selector: { type: "string", description: "CSS selector for click/fill/press_key/select_option/wait_for." },
        value: { type: "string", description: "For fill / select_option." },
        key: { type: "string", description: "press_key: key name, e.g. \"Enter\"." },
        expression: { type: "string", description: "evaluate: JavaScript expression to run in the page." },
        timeout: { type: "number", description: "wait_for: seconds to poll (default 5, max 15)." }
      },
      required: ["action"]
    }
  }
};

/** Memory toggle adds this tool — exact schema copy of Coder's `memory_update`
 *  (coderTools.ts), routed by ChatScreen's registry to the global chat store
 *  (/api/chat/memory) instead of the per-workspace coder one. */
export const CHAT_MEMORY_TOOL = {
  type: "function",
  function: {
    name: "memory_update",
    description: "Record a durable learning to your persistent memory bank so future conversations start smarter. Use it proactively when you discover something non-obvious about the user: a preference, an ongoing project, a durable fact worth recalling. Pass kind='avoid' for mistakes/anti-patterns to steer future replies away from them.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "One concise, self-contained learning (imperative, e.g. 'User prefers terse replies with no trailing summary.')." },
        kind: { type: "string", enum: ["success", "tip", "avoid"], description: "success = a working approach/fix; tip = a preference/fact worth remembering; avoid = a mistake or anti-pattern." }
      },
      required: ["text", "kind"]
    }
  }
};

/** Computer Use defaults to the OS temp dir (see `AppSettings::default` in
 *  the control plane) so it's useful the instant it's switched on — this
 *  tool is how the model honors "do that in my home folder instead"
 *  mid-conversation rather than requiring a trip to Settings. Takes effect
 *  immediately, including for later tool calls in the same turn. */
export const CHAT_SET_DIRECTORY_TOOL = {
  type: "function",
  function: {
    name: "set_directory",
    description: "Change Computer Use's working directory for the rest of this conversation — the root every read/write/edit/bash/grep/glob/git_* call below resolves against. Use when the user asks to work somewhere other than the current directory (e.g. their home folder). Accepts `~` for home.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  }
};

/** Computer Use's tool permission template: full parity with Coder's own
 *  Safety & Permissions grid (same TOOLS list) plus `set_directory`, which
 *  only exists on the Chat side. This is the FULL set shown in Settings so
 *  every tool name Chat's agent could ever call has a pre-configurable tier
 *  — the runtime `tools` array Chat actually sends to the model (built in
 *  ChatScreen.tsx) is a de-duplicated subset of this, since web_fetch/
 *  web_search/browser/memory_update already have dedicated homes (always-on
 *  baseline, Agent Mode, Memory) that must not appear twice. */
export const COMPUTER_USE_TOOLS = [...TOOLS, CHAT_SET_DIRECTORY_TOOL];

/** Drop later entries whose `function.name` already appeared — used when
 *  merging tool lists from independent toggles (Agent Mode, Memory,
 *  Computer Use) that can overlap (e.g. `browser`), so the model is never
 *  handed two schema entries for the same tool name. First occurrence wins;
 *  callers order the input so the more specific/dedicated toggle comes
 *  first. */
export function dedupeTools<T extends { function: { name: string } }>(tools: T[]): T[] {
  const seen = new Set<string>();
  return tools.filter((t) => {
    if (seen.has(t.function.name)) return false;
    seen.add(t.function.name);
    return true;
  });
}

/** Client-side permission gate for Computer Use tools — mirrors Coder's own
 *  `checkPerm` (CoderScreen.tsx) minus plan-mode, which Chat has no concept
 *  of. Returns a denial reason, `'ask'` to pause for approval, or `null` to
 *  proceed. The control plane re-checks `deny`/`denyPaths` itself (see
 *  `coder::common::enforce_perm`, scoped to the same directory) so a tool
 *  routing around this client-side check (e.g. `bash` curling an endpoint
 *  directly) still can't bypass a `deny` tier. */
export function checkComputerUsePerm(perms: PermConfig, name: string, args: Record<string, unknown>): string | 'ask' | null {
  if ((perms.tools[name] ?? 'allow') === 'deny') {
    return `Denied by Computer Use permissions (${name} is set to deny).`;
  }
  const target = typeof args.path === 'string' ? args.path : '';
  if (target) {
    const hit = perms.denyPaths.find((d) => {
      const clean = d.trim().replace(/\/+$/, '');
      return clean !== '' && (target === clean || target.startsWith(clean + '/'));
    });
    if (hit) return `Denied by Computer Use permissions (path is under denied prefix "${hit.trim()}").`;
  }
  if ((perms.tools[name] ?? 'allow') === 'ask') return 'ask';
  return null;
}

// Slash-command palette (type `/` in the composer to see suggestions).
export const SLASH_COMMANDS: Array<{ cmd: string; desc: string; needsArg?: boolean }> = [
  { cmd: '/clear', desc: 'Clear the current chat' },
  { cmd: '/retry', desc: 'Regenerate the last reply' },
  { cmd: '/model', desc: 'Switch model', needsArg: true },
  { cmd: '/think', desc: 'Toggle reasoning on|off', needsArg: true },
  { cmd: '/params', desc: 'Open the parameter popover' },
  { cmd: '/compact', desc: 'Summarize chat into a checkpoint' },
];

function pickDefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') (out as any)[k] = v;
  return out;
}

// Normalize persisted params (from the profile dir) into a valid ChatParams,
// filling unset sampling fields with undefined so the UI shows "model preset".
export function normalizeParams(raw: unknown): ChatParams {
  if (raw && typeof raw === 'object') {
    const p = raw as Record<string, unknown>;
    return { ...DEFAULT_PARAMS, ...p, maxTokens: undefined, ...pickDefined(p) };
  }
  return { ...DEFAULT_PARAMS, maxTokens: undefined, greedy: undefined, seed: undefined, temperature: undefined, topP: undefined, topK: undefined, minP: undefined, presencePenalty: undefined, frequencyPenalty: undefined };
}
