// notai.ts
//
// A port of the Not-Ai editorial contract + deterministic "tell" gate
// (https://github.com/udaysharmadev/Not-Ai) adapted for a Chat assistant:
// make the model's *replies* read like a real, competent person wrote them.
//
// Two layers, mirroring the upstream design:
//   1. An editorial contract (system-prompt text) that teaches the model how to
//      write its answers — clarity, specificity, real agency, no em dashes, no
//      empty framing, never invent the user's facts.
//   2. A dependency-free, deterministic gate (evaluate) that flags the classic
//      LLM "tells" so a reply can be silently re-written when it trips them.
//
// Everything here is pure text analysis + prompt assembly. No backend, no IPC.

import { buildChatRequest, streamChat } from './api';
import type { ChatMessage, ChatParams } from './types';

// ---------------------------------------------------------------------------
// Voice / genre profiles
// ---------------------------------------------------------------------------

export type VoiceProfile =
  | 'linkedin'
  | 'personal'
  | 'email'
  | 'social'
  | 'fiction'
  | 'readme'
  | 'technical'
  | 'student'
  | 'academic';

export const VOICE_PROFILES: Array<{ value: VoiceProfile; label: string; hint: string }> = [
  { value: 'personal', label: 'Personal', hint: 'First person, direct, a little informal.' },
  { value: 'email', label: 'Email', hint: 'Professional email: request up top, explicit owners.' },
  { value: 'technical', label: 'Technical', hint: 'Correctness + action; keep identifiers/commands exact.' },
  { value: 'academic', label: 'Academic', hint: 'Precise, cautious claims, necessary terminology.' },
  { value: 'readme', label: 'Docs / README', hint: 'Imperative steps, no marketing language.' },
  { value: 'linkedin', label: 'LinkedIn', hint: 'Hook first, scannable, no engagement bait.' },
  { value: 'social', label: 'Social', hint: 'Short, conversational, first person.' },
  { value: 'student', label: 'Student report', hint: 'First person if you did the work; exact results.' },
  { value: 'fiction', label: 'Fiction', hint: 'Preserve POV, tense, and voice; add nothing.' },
];

// Compact guidance injected into the system prompt, keyed by profile.
const VOICE_SNIPPETS: Record<VoiceProfile, string> = {
  personal:
    'Voice: write in the first person, like you actually did or think the thing. Be direct and a little informal. Keep the reader’s real experience in mind; don’t sand off the specific, odd details.',
  email:
    'Voice: this is a professional email. Put the purpose or request near the top. Match the relationship and level of formality. Make owners, dates, and next steps explicit. Don’t add warmth the sender didn’t express.',
  technical:
    'Voice: technical documentation. Optimize for correctness, navigation, and successful action. Use imperative steps where appropriate. Keep identifiers, commands, code, warnings, and prerequisites exact. Remove marketing language that obscures behavior.',
  academic:
    'Voice: formal academic writing. Preserve disciplinary terminology, cautious claims, and citations. Prefer precision over a conversational tone. Never strengthen causality or generalize beyond the evidence. Don’t add first person unless the venue uses it.',
  readme:
    'Voice: docs / README. Imperative, scannable, correct. Keep code blocks, flags, and filenames exact. No hype.',
  linkedin:
    'Voice: a LinkedIn or social post. Lead with the actual event, observation, or claim. Keep paragraphs easy to scan. Use first person only for a real experience. No manufactured vulnerability, engagement bait, or decorative emoji.',
  social:
    'Voice: casual social reply. Short, conversational, first person. No jargon, no lists for their own sake.',
  student:
    'Voice: a student project report. First person is fine when you actually did the work. Keep methods, datasets, results, limitations, and citations exact. Explain decisions with supplied constraints, not invented stories. Don’t fake casualness.',
  fiction:
    'Voice: fiction or narrative. Preserve point of view, tense, and characterization. Don’t normalize dialect or unusual syntax. Add no sensory detail, motivation, or backstory that wasn’t there.',
};

export function voiceSnippet(voice?: string): string {
  if (voice && voice in VOICE_SNIPPETS) return VOICE_SNIPPETS[voice as VoiceProfile];
  return '';
}

export function effectiveVoice(params: ChatParams, fallback: VoiceProfile = 'personal'): VoiceProfile {
  const v = params.voiceProfile;
  return v && v in VOICE_SNIPPETS ? (v as VoiceProfile) : fallback;
}

// ---------------------------------------------------------------------------
// The editorial contract (system-prompt text)
// ---------------------------------------------------------------------------

export const NOT_AI_CONTRACT = `You are a clear, specific, source-grounded assistant. Write replies that sound like a real, competent person wrote them — not a generic assistant. Follow these rules:

1. Ground every claim in what the user actually said or in shared conversation context. Never invent facts, numbers, names, quotes, code, feelings, or details the user didn't provide. If you need one to answer well, ask a single concise question instead of fabricating it.
2. Lead with the useful information. Put the fact, the answer, or the action first. Cut throat-clearing like "It is worth noting that" or "In today's fast-paced world."
3. Name the actor. Say who decided, built, observed, or changed something. Use first person for your own actions; use passive only when the actor is unknown or irrelevant.
4. Be specific. Replace vague praise or generalities with the concrete detail at hand. Don't inflate significance.
5. Keep it tight. Vary sentence length because the meaning demands it, not to hit a quota. Cut empty framing and decorative transitions ("Moreover", "Additionally", "In conclusion").
6. Don't manufacture warmth, emoji, vulnerability, or "human imperfections." Just be clear and direct.
7. Never use em dashes (—) or en dashes (–) in your prose. Use a period, comma, or parentheses instead. This is a hard rule.
8. Preserve the user's meaning, terminology, code, and requested format exactly. If their message is already clear, just answer — don't pad it out.
9. If you have nothing useful to add, say so briefly. Don't perform a rewrite of something that's already strong.`;

/**
 * Resolve the effective system prompt for a chat request.
 * When humanize is on, the Not-Ai contract (plus the chosen voice profile) is
 * appended after any custom instructions the user wrote. When off, only the
 * user's custom prompt is returned (unchanged behavior).
 */
export function effectiveSystemPrompt(params: ChatParams): string {
  const custom = (params.systemPrompt || '').trim();
  if (!params.humanize) return custom;
  const contract = [NOT_AI_CONTRACT, voiceSnippet(params.voiceProfile)].filter(Boolean).join('\n\n');
  return custom ? `${custom}\n\n${contract}` : contract;
}

// ---------------------------------------------------------------------------
// Deterministic gate (TS port of not_ai_core/gate.py)
// ---------------------------------------------------------------------------

const WORD_RE = /\b[A-Za-z]+(?:'[A-Za-z]+)?\b/g;
const SENTENCE_RE = /(?<=[.!?])\s+(?=[A-Z"'”’])/g;
const CONTRACTION_RE = /\b(?:[A-Za-z]+n't|[A-Za-z]+'(?:re|ve|ll|d|m|s))\b/i;
const PARTICIPIAL_OPENER_RE = /^([A-Za-z]+ing)\b[^.!?]{0,100},/;
const TIER_ONE = new Set([
  'camaraderie', 'tapestry', 'palpable', 'intricate', 'vibrant', 'cacophony', 'solace',
  'fleeting', 'ignite', 'unravel', 'grapple', 'amidst', 'unspoken', 'underscore', 'unease',
  'pang', 'waft', 'prioritize',
]);
const TIER_TWO = new Set([
  'delve', 'leverage', 'utilize', 'facilitate', 'comprehensive', 'robust', 'seamless', 'pivotal',
  'foster', 'meticulous', 'nuanced', 'multifaceted', 'transformative', 'groundbreaking', 'empower',
  'synergy', 'holistic', 'dynamic', 'impactful', 'landscape', 'realm', 'revolutionize', 'harness',
  'unlock', 'elevate', 'garner', 'showcase', 'bolster', 'interplay', 'testament', 'boasts',
  'enhance', 'crucial', 'enduring', 'valuable',
]);
const MECHANICAL_PATTERNS: Array<[string, RegExp]> = [
  // All patterns MUST be global: evaluate() scans them with String.matchAll,
  // which throws TypeError on a non-global regex — and that throw used to
  // unwind runStream mid-flight, leaving the chat stuck "streaming" forever.
  ['template-transition', /\b(?:furthermore|moreover|additionally|in conclusion|to summarize)\b/gi],
  ['empty-frame', /\b(?:it is (?:worth|important) to note that|in today's fast-paced world)\b/gi],
  ['copula-avoidance', /\b(?:serves as|stands as|functions as|operates as|marks a)\b/gi],
  ['negative-parallelism', /\bnot just\b[^.!?]{0,80}\bbut\b/gi],
];

const EM_DASH = '—';
const EN_DASH = '–';
const CURLY = ['“', '”', '‘', '’'];

export interface GateFinding {
  rule: string;
  severity: 'error' | 'warning' | 'review';
  message: string;
  span?: string;
  sentence?: number | null;
}

export interface GateCounts {
  dashes: number;
  curly_quotes: number;
  contractions: number;
  contractions_per_1000: number;
  sentences: number;
  short_under_8: number;
  max_consecutive_short: number;
  long_over_30: number;
  sentence_length_sd: number;
  opening_types: number;
  max_same_opening: number;
}

export interface GateResult {
  genre: string;
  word_count: number;
  counts: GateCounts;
  findings: GateFinding[];
  passed: boolean;
}

function words(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

function sentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return (normalized.split(SENTENCE_RE))
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 2);
}

function pstdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function openingStats(items: string[]): [number, number] {
  const firsts = items.map((it) => {
    const w = words(it);
    return w.length ? w[0].toLowerCase() : '';
  }).filter(Boolean);
  if (!firsts.length) return [0, 0];
  const counts = new Map<string, number>();
  for (const w of firsts) counts.set(w, (counts.get(w) ?? 0) + 1);
  let max = 0;
  for (const c of counts.values()) max = Math.max(max, c);
  return [counts.size, max];
}

function maxConsecutiveShort(lengths: number[], threshold = 8): number {
  let longest = 0;
  let current = 0;
  for (const len of lengths) {
    current = len < threshold ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

export interface EvaluateOptions {
  asciiPunctuation?: boolean;
  protectedTerms?: string[];
}

/**
 * Deterministic, genre-aware check of a reply. Mirrors the upstream gate: empty
 * output and missing protected terms are hard errors; typography becomes an
 * error only under an explicit ASCII house style; everything else is a review
 * finding. Findings never claim to determine authorship or writing quality.
 */
export function evaluate(
  text: string,
  genre: VoiceProfile = 'linkedin',
  opts: EvaluateOptions = {},
): GateResult {
  const tokens = words(text);
  const items = sentences(text);
  const lengths = items.map((it) => words(it).length);
  const [distinctOpenings, maxOpening] = openingStats(items);
  const maxShortRun = maxConsecutiveShort(lengths);
  const contractionCount = (text.match(CONTRACTION_RE) ?? []).length;

  const counts: GateCounts = {
    dashes: countChar(text, EM_DASH) + countChar(text, EN_DASH),
    curly_quotes: CURLY.reduce((n, c) => n + countChar(text, c), 0),
    contractions: contractionCount,
    contractions_per_1000: tokens.length ? Math.round((contractionCount * 1000) / tokens.length * 10) / 10 : 0,
    sentences: items.length,
    short_under_8: lengths.filter((l) => l < 8).length,
    max_consecutive_short: maxShortRun,
    long_over_30: lengths.filter((l) => l > 30).length,
    sentence_length_sd: Math.round(pstdev(lengths) * 10) / 10,
    opening_types: distinctOpenings,
    max_same_opening: maxOpening,
  };

  const findings: GateFinding[] = [];

  if (!text.trim()) {
    findings.push({ rule: 'nonempty', severity: 'error', message: 'Text is empty.' });
    return { genre, word_count: 0, counts, findings, passed: false };
  }

  const punctuationSeverity: GateFinding['severity'] = opts.asciiPunctuation ? 'error' : 'review';
  const punctuationContext = opts.asciiPunctuation
    ? 'The requested ASCII house style does not allow this punctuation.'
    : 'Keep it when it matches the writer, locale, or publication style.';
  if (counts.dashes > 0) {
    findings.push({ rule: 'typography', severity: punctuationSeverity, message: `The text contains em or en dashes. ${punctuationContext}`, span: '—' });
  }
  if (counts.curly_quotes > 0) {
    findings.push({ rule: 'typography', severity: punctuationSeverity, message: `The text contains curly quotes or apostrophes. ${punctuationContext}` });
  }

  const normalized = text.toLowerCase();
  for (const term of new Set(opts.protectedTerms ?? [])) {
    if (typeof term !== 'string' || !term.trim()) continue;
    if (!normalized.includes(term.toLowerCase())) {
      findings.push({ rule: 'protected-content', severity: 'error', message: 'Expected protected text is missing from the deliverable.', span: term });
    }
  }

  const lowered = tokens.map((t) => t.toLowerCase());
  for (const tier of [TIER_ONE, TIER_TWO] as const) {
    const severity: GateFinding['severity'] = tier === TIER_ONE ? 'warning' : 'review';
    const ruleName = tier === TIER_ONE ? 'tier-1-vocabulary' : 'tier-2-vocabulary';
    for (const term of [...new Set(lowered)].filter((t) => tier.has(t))) {
      findings.push({ rule: ruleName, severity, message: 'Review whether this word is precise and needed.', span: term });
    }
  }

  for (const [rule, pattern] of MECHANICAL_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      findings.push({ rule: 'mechanical-pattern', severity: 'review', message: 'Read this pattern in context; rewrite only if it adds no meaning.', span: m[0] });
    }
  }

  items.forEach((item, i) => {
    if (PARTICIPIAL_OPENER_RE.test(item)) {
      findings.push({ rule: 'participial-opener', severity: 'review', message: 'Check whether this opener has a clear subject and earns its complexity.', sentence: i + 1, span: item.slice(0, 120) });
    }
  });

  // Conversational genres expect contractions; flag their total absence.
  const conversational = ['linkedin', 'personal', 'email', 'social', 'fiction'].includes(genre);
  const requireContractions = conversational && !['email', 'fiction'].includes(genre);
  if (requireContractions && tokens.length >= 80 && contractionCount === 0) {
    findings.push({ rule: 'contractions', severity: 'review', message: 'This conversational reply has no contractions; preserve formality only if it matches the user.', sentence: null });
  }
  if (items.length >= 5 && (distinctOpenings < 3 || maxOpening >= 3)) {
    findings.push({ rule: 'sentence-openings', severity: 'review', message: 'Several sentences start alike; vary only where it improves the passage.', sentence: null });
  }
  if (items.length >= 6 && counts.sentence_length_sd < 4) {
    findings.push({ rule: 'sentence-rhythm', severity: 'review', message: 'Sentence lengths are unusually uniform; inspect the paragraph rhythm.', sentence: null });
  }
  const allowFragments = ['linkedin', 'personal', 'social', 'fiction'].includes(genre);
  if (items.length >= 4 && maxShortRun >= 3 && !allowFragments) {
    findings.push({ rule: 'choppy-run', severity: 'review', message: 'Several very short sentences appear in a row; combine only those that express one connected idea.', sentence: null });
  }

  const passed = !findings.some((f) => f.severity === 'error');
  return { genre, word_count: tokens.length, counts, findings, passed };
}

function countChar(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/**
 * Whether a reply should be silently re-written. We deliberately restrict this
 * to the highest-signal tells so the auto-rewrite doesn't fire on every reply:
 * any em/en dash, a tier-1 buzzword, a mechanical transition, or a participial
 * opener. (Dashes alone are the headline Not-Ai rule.)
 */
export function needsHumanize(r: GateResult, opts: { ascii?: boolean } = {}): boolean {
  if (!r.word_count) return false;
  if (r.counts.dashes > 0) return true;
  if (opts.ascii && r.counts.curly_quotes > 0) return true;
  return r.findings.some(
    (f) => f.rule === 'tier-1-vocabulary' || f.rule === 'mechanical-pattern' || f.rule === 'participial-opener',
  );
}

/** Build the "rewrite this reply" instruction sent to the model. */
export function humanizeInstruction(text: string, res: GateResult): string {
  const spans = [...new Set(res.findings.map((f) => f.span).filter((s): s is string => !!s))]
    .slice(0, 12)
    .map((s) => `"${s.length > 60 ? s.slice(0, 57) + '…' : s}"`)
    .join(', ');
  const extra = spans ? ` Pay special attention to removing or rephrasing: ${spans}.` : '';
  return [
    'Rewrite the reply below so it reads like a real, competent person wrote it. Keep every fact, number, name, code snippet, command, and the user’s intended meaning exactly. Do not add information the user did not provide.',
    'Rules:',
    '- Remove all em dashes (—) and en dashes (–). Use a period, comma, or parentheses instead.',
    '- Cut mechanical transitions ("Moreover", "Additionally", "It is worth noting that") and empty framing.',
    '- Avoid participial openers and buzzwords ("delve", "tapestry", "robust", "leverage"); be direct and specific.',
    '- Vary sentence rhythm by meaning, not by a quota.',
    'Reply with ONLY the rewritten text and no preamble or commentary.',
    extra,
    '',
    '=== ORIGINAL REPLY ===',
    text,
    '=== END ===',
  ].join('\n');
}

/**
 * Silently re-write `originalText` through the model and resolve the cleaner
 * version. Used by both Chat and Coder auto-rewrite passes. Returns the trimmed
 * rewritten text (empty string on failure — caller keeps the original).
 */
export async function humanizeRewriteText(opts: {
  model: string;
  baseSystem: string;
  priorMessages: ChatMessage[];
  originalText: string;
  params: ChatParams;
  signal?: AbortSignal;
}): Promise<string> {
  const res = evaluate(opts.originalText, effectiveVoice(opts.params), {});
  const instruction: ChatMessage = { role: 'user', content: humanizeInstruction(opts.originalText, res) };
  const messages = [...opts.priorMessages, instruction];
  const body = buildChatRequest(
    opts.model,
    opts.baseSystem,
    messages,
    // The rewrite can never need more tokens than the reply it is rewriting
    // (that reply was itself generated under this cap). Leaving it uncapped
    // lets the engine's own --default-max-tokens govern — e.g. 32000 tokens —
    // and the rewrite "streams" for many minutes, looking like a reply that
    // never finishes and blocking STOP/persistence the whole time.
    { ...opts.params, maxTokens: opts.params.maxTokens ?? HUMANIZE_REWRITE_MAX_TOKENS },
    {},
  );
  let acc = '';
  await streamChat(body, opts.signal ?? AbortSignal.timeout(120_000), {
    onContentDelta: (d) => { acc += d; },
    onError: (m) => { throw new Error(m); },
  });
  // streamChat resolves (rather than rejects) on abort, so a partial rewrite
  // would otherwise replace the finished reply. Bail out when aborted — the
  // caller keeps the original text.
  if (opts.signal?.aborted) return '';
  return acc.trim();
}

// Match the upstream hard cap on retries so a stubborn reply can't loop forever.
export const HUMANIZE_MAX_DEPTH = 2;

// Hard cap for the Not-Ai rewrite pass (see humanizeRewriteText above).
export const HUMANIZE_REWRITE_MAX_TOKENS = 2048;
