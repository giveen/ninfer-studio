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

const DB_NAME = 'ninfier-observation-pack';
const STORE_NAME = 'observations';
const DB_VERSION = 1;

/** Only tool results larger than this participate. */
export const PACK_THRESHOLD_BYTES = 4 * 1024;
/** Sent in full for this many prior turns before being packed. */
export const PACK_FULL_SENDS = 2;
/** Placeholder excerpt budget, split evenly between head and tail. */
export const PACK_EXCERPT_BYTES = 1024;

const RECALL_MAX_BYTES = 4000;
const RECALL_MAX_LINES = 200;
const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/;
/** Tools whose results are already bounded/paged, or that ARE the recall
 *  path itself — never pack (this module) or AI-summarize (maybeSummarizeTool
 *  in CoderScreen.tsx) these. Shared so the two "large tool output" pipelines
 *  can't drift on what counts as already-bounded. */
export const LARGE_OUTPUT_EXCLUDED_TOOLS = new Set(['grep', 'glob', 'repo_search', 'obs_recall']);

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

export function isObservationId(id: string): boolean {
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

/** Extract the large-text field (and which shape it came from) out of an
 *  already-JSON-parsed tool result — shared by ObservationPack and
 *  maybeSummarizeTool in CoderScreen.tsx so the two "large tool output"
 *  pipelines can't disagree on what counts as a result's text. Returns null
 *  for a result with neither shape. */
export function extractToolResultText(res: Record<string, unknown>): ToolResultText | null {
  const hasStd = typeof res.stdout === 'string' || typeof res.stderr === 'string';
  const hasContent = typeof res.content === 'string';
  if (!hasStd && !hasContent) return null;
  const text = hasStd ? `${(res.stdout as string) || ''}\n${(res.stderr as string) || ''}` : (res.content as string);
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
 *  placeholder. The canonical, displayed message array is never touched —
 *  this returns a new array, or the same reference when nothing changed.
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
    const { text, res } = packable;
    if (new TextEncoder().encode(text).length <= PACK_THRESHOLD_BYTES) continue;

    const id = `obs_${(await hashText(text)).slice(0, 24)}`;
    await ensureStored(id, text);
    const placeholder = placeholderFor(id, m.name || 'tool', text);
    if (typeof res.stdout === 'string' || typeof res.stderr === 'string') {
      res.stdout = placeholder;
      res.stderr = '';
    } else {
      res.content = placeholder;
    }
    const packedContent = JSON.stringify(res);
    packedCache.set(originalContent, packedContent);
    out[idx] = { ...m, content: packedContent };
    changed = true;
  }
  return changed ? out : messages;
}
