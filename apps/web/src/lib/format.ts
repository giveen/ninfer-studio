/** Rough chars-per-token ratios used wherever a real tokenizer isn't worth the cost.
 *  - Prose (English text): ~4 chars / token
 *  - Code / JSON / Tool output: ~3.2 chars / token */
export const CHARS_PER_TOKEN_PROSE = 4;
export const CHARS_PER_TOKEN_CODE = 3.2;
/** Default rough ratio for mixed content. */
export const CHARS_PER_TOKEN = CHARS_PER_TOKEN_PROSE;

export function estimateTokens(text: string | null | undefined, isCode = false): number {
  if (!text) return 0;
  const ratio = isCode ? CHARS_PER_TOKEN_CODE : CHARS_PER_TOKEN_PROSE;
  return Math.ceil(text.length / ratio);
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 99.95 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatRate(tps: number | null | undefined): string {
  if (tps === null || tps === undefined || !Number.isFinite(tps) || tps < 0) return '—';
  if (tps >= 1000) return `${(tps / 1000).toFixed(2)}k tok/s`;
  return `${tps.toFixed(1)} tok/s`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function formatUptime(startedAt: number | null | undefined, now: number = Date.now()): string {
  if (!startedAt || !Number.isFinite(startedAt) || startedAt < 0) return '—';
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function formatTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatPct(part: number | null | undefined, total: number | null | undefined): string {
  if (part === null || part === undefined || total === null || total === undefined || !total || !Number.isFinite(part) || !Number.isFinite(total)) return '—';
  const pct = Math.min(100, Math.max(0, Math.round((part / total) * 100)));
  return `${pct}%`;
}

export function uid(): string {
  return crypto.randomUUID();
}
