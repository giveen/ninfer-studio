// Pure chat helpers: model-context building, params normalization, and the
// static tool/capability/slash-command data the composer and request
// builder read. No JSX, no closure over ChatScreen's component state.

import { frameCompactedSummary } from './api';
import { effectiveSystemPrompt } from './notai';
import type { ChatMessage, ChatParams, Conversation } from './types';

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

export const chatSystemWithCapabilities = (params: Parameters<typeof effectiveSystemPrompt>[0]): string => {
  const base = effectiveSystemPrompt(params);
  return [base, localDateTimeBlock(), CHAT_CAPABILITIES].filter(Boolean).join('\n\n');
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
