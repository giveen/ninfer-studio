// Observation Pack: a large tool result that has already appeared in
// PACK_FULL_SENDS prior turns is replaced — in the request sent to the
// model only, never in the persisted/displayed transcript — with a compact
// placeholder (head/tail excerpt + a recall handle) instead of being
// re-transmitted in full forever. The original is preserved losslessly in
// local IndexedDB and can be paged back in on demand via `obs_recall`.
//
// This targets a different failure mode than the evidence-verified reducer
// in api.ts: that one compresses a SINGLE result that's too big to send
// even once; this one stops re-sending a result that was fine to send once
// or twice but is now just wasted, repeated context on every later turn.
//
// Inspired by SoL-Pi's ObservationPack (github.com/NVlabs/SoL-Pi).

import type { ChatMessage } from './types';
import { CHARS_PER_TOKEN } from './format';
import { summarizeOutputVerified, renderOutputReceipt } from './api/chat';

const SUMMARY_THRESHOLD = 16 * 1024;
const SUMMARY_TAIL = 1500;

const DB_NAME = 'ninfier-observation-pack';
const STORE_NAME = 'observations';
const DB_VERSION = 1;

/** Only tool results larger than this participate. */
const PACK_THRESHOLD_BYTES = 4 * 1024;
/** Sent in full for this many prior turns before being packed. */
const PACK_FULL_SENDS = 2;
/** Minimum number of newly-eligible tool results to pack in one pass. Once a
 *  message is packed, the caller is expected to persist that shrink into
 *  real history (see useCoderAgentLoop.ts's runAgent), so it never needs
 *  reprocessing — but the FIRST turn any given message gets packed still
 *  changes a byte the engine already cached a continuation against, and
 *  that turn's whole request misses the KV/prefix cache no matter what
 *  (confirmed empirically: the engine only ever matches an exact extension
 *  of the last request it processed, not a merely-overlapping prefix). In a
 *  tool-call-heavy run a new result crosses PACK_FULL_SENDS on nearly every
 *  turn, so packing one at a time means nearly every turn pays that miss.
 *  Batching multiple eligible results into a single pack event cuts how
 *  often that happens by roughly this factor, at the cost of carrying a
 *  slightly larger backlog of not-yet-packed (but already-old) results in
 *  context in the meantime. */
const PACK_BATCH_SIZE = 8;
/** Placeholder excerpt budget, split evenly between head and tail. */
const PACK_EXCERPT_BYTES = 1024;

const RECALL_MAX_BYTES = 4000;
const RECALL_MAX_LINES = 200;
const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/;
/** Tools that ARE the recall path itself — packing or AI-summarizing
 *  (maybeSummarizeTool in CoderScreen.tsx) obs_recall's own output would be
 *  circular. Shared so the two "large tool output" pipelines can't drift on
 *  what's excluded.
 *
 *  grep/glob/repo_search used to be excluded too, on the assumption their
 *  own result caps made them "already bounded" — but grep's default
 *  maxMatches is 2000 (each line truncated to only 400 chars, so a single
 *  broad grep can still return ~800KB) and glob truncates to 4000 paths, both
 *  far past PACK_THRESHOLD_BYTES. Since neither pipeline ever touched them,
 *  repeated searches over a long session accumulated in context forever
 *  instead of aging out like every other tool result. */
export const LARGE_OUTPUT_EXCLUDED_TOOLS = new Set(['obs_recall']);

let dbPromise: Promise<IDBDatabase> | null = null;
function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('failed to open observation-pack store'));
    });
  }
  return dbPromise;
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isObservationId(id: string): boolean {
  return OBSERVATION_ID_PATTERN.test(id);
}

async function ensureStored(id: string, text: string): Promise<void> {
  const db = await getDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(text, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('failed to store observation'));
  });
}

async function getObservationText(id: string): Promise<string | null> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
    req.onerror = () => reject(req.error ?? new Error('failed to read observation'));
  });
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split('\n').length;
  return text.endsWith('\n') ? parts - 1 : parts;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function completeLineExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
  const lines = text.split(/(?<=\n)/);
  const selected: string[] = [];
  let selectedBytes = 0;
  let index = fromEnd ? lines.length - 1 : 0;
  while (index >= 0 && index < lines.length) {
    const line = lines[index];
    const lineBytes = new TextEncoder().encode(line).length;
    if (selectedBytes + lineBytes > budgetBytes) break;
    if (fromEnd) selected.unshift(line);
    else selected.push(line);
    selectedBytes += lineBytes;
    index += fromEnd ? -1 : 1;
  }
  return selected.join('');
}

function placeholderFor(id: string, toolName: string, text: string): string {
  const headBudget = Math.floor(PACK_EXCERPT_BYTES / 2);
  const tailBudget = PACK_EXCERPT_BYTES - headBudget;
  const head = completeLineExcerpt(text, headBudget, false);
  const tail = completeLineExcerpt(text, tailBudget, true);
  return [
    `[large ${toolName} result — sent in full for the last ${PACK_FULL_SENDS} turns, now replaced with an excerpt to save context; nothing is lost, page it back in with obs_recall]`,
    `id: ${id}`,
    `original_bytes: ${new TextEncoder().encode(text).length}`,
    `original_lines: ${countLines(text)}`,
    `estimated_tokens: ${estimateTokens(text)}`,
    `retrieve: call obs_recall with {"id":"${id}","offset":0}; continue with the returned next_offset until eof is true`,
    `[first complete lines, up to ${headBudget} bytes]`,
    head,
    `[middle omitted; last complete lines, up to ${tailBudget} bytes]`,
    tail,
  ].join('\n');
}

export interface RecallResult {
  text?: string;
  nextOffset?: number;
  eof?: boolean;
  error?: string;
}

/** Page through a stored observation from `offset`. */
export async function readRecallChunk(id: string, offset: number): Promise<RecallResult> {
  if (!isObservationId(id)) return { error: `invalid observation id: ${id}` };
  const text = await getObservationText(id);
  if (text === null) return { error: `no stored observation for id ${id} (it may have been from a previous session)` };
  const bytes = new TextEncoder().encode(text);
  if (!Number.isFinite(offset) || offset < 0 || offset > bytes.length) {
    return { error: `offset ${offset} out of range (0-${bytes.length})` };
  }
  const available = bytes.length - offset;
  let end = Math.min(available, RECALL_MAX_BYTES);
  let newlineCount = 0;
  for (let i = 0; i < end; i += 1) {
    if (bytes[offset + i] !== 0x0a) continue;
    newlineCount += 1;
    if (newlineCount === RECALL_MAX_LINES) {
      end = i + 1;
      break;
    }
  }
  const chunk = bytes.subarray(offset, offset + end);
  // fatal:false tolerates a chunk boundary landing mid-character (rare, and
  // only ever cosmetic — one stray replacement character at a page edge).
  const text2 = new TextDecoder('utf-8', { fatal: false }).decode(chunk);
  const nextOffset = offset + chunk.length;
  return { text: text2, nextOffset, eof: nextOffset >= bytes.length };
}

export interface ToolResultText {
  text: string;
  hasStd: boolean;
}

/** Replace a tool result's large field with `placeholder`, whichever shape
 *  it came from. For the matches/files array shapes the bulky original
 *  array is deleted, not left dangling alongside the new `content` field —
 *  otherwise the result would grow instead of shrink. */
export function applyResultPlaceholder(res: Record<string, unknown>, placeholder: string): void {
  if (typeof res.stdout === 'string' || typeof res.stderr === 'string') {
    res.stdout = placeholder;
    res.stderr = '';
    return;
  }
  delete res.matches;
  delete res.files;
  res.content = placeholder;
}

/** Render a JSON array field (grep's `matches`, glob's `files`) as
 *  readable lines so the placeholder's head/tail excerpt stays meaningful
 *  instead of showing a JSON fragment. */
function renderListField(list: unknown[]): string {
  return list
    .map((item) => {
      if (item && typeof item === 'object' && 'file' in item) {
        const m = item as { file: unknown; line?: unknown; text?: unknown };
        return m.line !== undefined ? `${m.file}:${m.line}: ${m.text ?? ''}` : String(m.file);
      }
      return typeof item === 'string' ? item : JSON.stringify(item);
    })
    .join('\n');
}

/** Extract the large-text field (and which shape it came from) out of an
 *  already-JSON-parsed tool result — shared by ObservationPack and
 *  maybeSummarizeTool in CoderScreen.tsx so the two "large tool output"
 *  pipelines can't disagree on what counts as a result's text. Handles the
 *  stdout/stderr shape (bash/exec-style tools), a plain `content` string,
 *  and grep's `matches`/glob's `files` array shapes — those two used to be
 *  excluded entirely (see LARGE_OUTPUT_EXCLUDED_TOOLS) on the assumption
 *  their own result caps made them small enough not to need this, but
 *  grep's default 2000-match cap and glob's 4000-path cap both run well
 *  past PACK_THRESHOLD_BYTES in practice. Returns null for a result with
 *  none of these shapes. */
export function extractToolResultText(res: Record<string, unknown>): ToolResultText | null {
  const hasStd = typeof res.stdout === 'string' || typeof res.stderr === 'string';
  const hasContent = typeof res.content === 'string';
  const hasMatches = Array.isArray(res.matches);
  const hasFiles = Array.isArray(res.files);
  if (!hasStd && !hasContent && !hasMatches && !hasFiles) return null;
  const text = hasStd
    ? `${(res.stdout as string) || ''}\n${(res.stderr as string) || ''}`
    : hasContent
      ? (res.content as string)
      : renderListField((hasMatches ? res.matches : res.files) as unknown[]);
  return { text, hasStd };
}

/** Parse a tool-result message's content and extract its packable text, or
 *  null if it isn't eligible (wrong shape, excluded tool, already a compact
 *  receipt). Returns the parsed object too so callers don't have to
 *  re-parse the same JSON a second time. */
function extractPackable(toolName: string | undefined, content: unknown): { text: string; res: Record<string, unknown> } | null {
  if (!toolName || LARGE_OUTPUT_EXCLUDED_TOOLS.has(toolName) || typeof content !== 'string') return null;
  let res: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    res = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (res._summarized === true) return null; // already a compact receipt
  const extracted = extractToolResultText(res);
  return extracted ? { text: extracted.text, res } : null;
}

/** Cache of already-packed placeholders, keyed by the exact original raw
 *  content string. A message's content string is immutable and (history
 *  being append-only within a run) never recurs with a different meaning,
 *  so once packed it never needs re-hashing or re-writing to IndexedDB
 *  again — without this, packForRequest would redo that work for every
 *  already-packed message on every subsequent turn of a long run. */
const packedCache = new Map<string, string>();

/** Build the request-only view of `messages`: any tool-result message old
 *  enough (PACK_FULL_SENDS turns behind the newest tool result) and large
 *  enough (PACK_THRESHOLD_BYTES) gets its content field replaced with a
 *  placeholder — but only once at least PACK_BATCH_SIZE such messages are
 *  eligible at once, packed together in one pass (see PACK_BATCH_SIZE). This
 *  function itself never mutates `messages` — it returns a new array, or
 *  the same reference when nothing changed — but a caller that wants the
 *  batching to actually reduce cache misses (rather than just deferring
 *  them) needs to adopt the result as real history, not just a wire-only
 *  view of it: see useCoderAgentLoop.ts's runAgent.
 *
 *  History here is append-only within a run (aside from compaction, which
 *  replaces the whole array), so "N tool-result messages appear later in
 *  the array" is equivalent to "this result has been sent N more times" —
 *  no separate send-counter is needed. */
export async function packForRequest(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const toolIndices: number[] = [];
  messages.forEach((m, i) => { if (m.role === 'tool') toolIndices.push(i); });
  if (toolIndices.length <= PACK_FULL_SENDS) return messages;

  let changed = false;
  const out = messages.slice();

  // Pass 1: reapply placeholders already decided on a prior call (cheap,
  // and never a NEW divergence — just reproducing an existing decision) and
  // collect candidates that would be newly eligible this call.
  const newlyEligible: Array<{ idx: number; text: string; res: Record<string, unknown> }> = [];
  for (let rank = 0; rank < toolIndices.length; rank += 1) {
    const laterCount = toolIndices.length - 1 - rank;
    if (laterCount < PACK_FULL_SENDS) continue; // still within its full-send window
    const idx = toolIndices[rank];
    const m = out[idx];
    const originalContent = m.content;

    const cached = packedCache.get(originalContent);
    if (cached !== undefined) {
      out[idx] = { ...m, content: cached };
      changed = true;
      continue;
    }

    const packable = extractPackable(m.name, originalContent);
    if (!packable) continue;
    if (new TextEncoder().encode(packable.text).length <= PACK_THRESHOLD_BYTES) continue;
    newlyEligible.push({ idx, ...packable });
  }

  // Pass 2: only actually pack once PACK_BATCH_SIZE have piled up, and pack
  // all of them together — see PACK_BATCH_SIZE for why one-at-a-time is
  // costly. Below the batch size, leave these full for now; they'll be
  // reconsidered (still eligible, plus whatever else piles up) next call.
  if (newlyEligible.length < PACK_BATCH_SIZE) return changed ? out : messages;
  for (const { idx, text, res } of newlyEligible) {
    const m = out[idx];
    const id = `obs_${(await hashText(text)).slice(0, 24)}`;
    await ensureStored(id, text);
    const placeholder = placeholderFor(id, m.name || 'tool', text);
    applyResultPlaceholder(res, placeholder);
    const packedContent = JSON.stringify(res);
    packedCache.set(m.content, packedContent);
    out[idx] = { ...m, content: packedContent };
    changed = true;
  }
  return changed ? out : messages;
}

export async function maybeSummarizeTool(
  name: string,
  resultStr: string,
  model: string,
  signal?: AbortSignal,
  cloudOpts?: { baseUrl?: string; apiKey?: string; extraHeaders?: string },
): Promise<string> {
  if (LARGE_OUTPUT_EXCLUDED_TOOLS.has(name)) return resultStr;
  let res: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(resultStr);
    if (parsed && typeof parsed === 'object') res = parsed as Record<string, unknown>;
  } catch {
    return resultStr;
  }
  if (!res) return resultStr;
  const extracted = extractToolResultText(res);
  if (!extracted) return resultStr;
  const { text, hasStd } = extracted;
  if (text.length <= SUMMARY_THRESHOLD) return resultStr;
  const isError = hasStd && typeof res.exitCode === 'number' ? res.exitCode !== 0 : undefined;
  try {
    const receipt = await summarizeOutputVerified({
      model,
      baseUrl: cloudOpts?.baseUrl,
      apiKey: cloudOpts?.apiKey,
      extraHeaders: cloudOpts?.extraHeaders,
      output: text,
      isError,
      signal,
    });
    if (!receipt) return resultStr;
    const tail = text.slice(-SUMMARY_TAIL);
    const wrapped = `[AI-summarized output — ${text.length} chars condensed for brevity; evidence quotes below are verified byte-for-byte against the original]\n${renderOutputReceipt(receipt)}\n\n--- raw tail (last ${SUMMARY_TAIL} chars) ---\n${tail}`;
    applyResultPlaceholder(res, wrapped);
    res._summarized = true;
    return JSON.stringify(res);
  } catch {
    return resultStr;
  }
}
