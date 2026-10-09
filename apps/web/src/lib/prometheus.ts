// Minimal Prometheus text-format (0.0.4) reader for the engine's `GET /metrics`.
//
// The control plane proxies the payload unparsed — the Engine owns the metric
// vocabulary — so this reader is deliberately generic: it groups samples into
// the families declared by `# HELP` / `# TYPE` and keeps whatever the running
// build publishes. Histogram and summary series (`_bucket`, `_sum`, `_count`)
// are folded back into their declared family so they render as one block.

export interface PromSample {
  labels: Record<string, string>;
  value: number;
}

export interface PromFamily {
  name: string;
  help?: string;
  type?: string;
  samples: PromSample[];
}

const LABEL_RE = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;

/** Unescape a Prometheus label value (`\\`, `\"`, `\n`). */
function unescapeLabel(v: string): string {
  return v.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
}

function parseLabels(block: string): Record<string, string> {
  const labels: Record<string, string> = {};
  LABEL_RE.lastIndex = 0;
  for (let m = LABEL_RE.exec(block); m; m = LABEL_RE.exec(block)) {
    labels[m[1]] = unescapeLabel(m[2]);
  }
  return labels;
}

/** Parse one `name{labels} value [timestamp]` exposition line. */
export function parsePromLine(
  line: string,
): { name: string; labels: Record<string, string>; value: number } | null {
  const braceStart = line.indexOf('{');
  if (braceStart >= 0) {
    const braceEnd = line.lastIndexOf('}');
    if (braceEnd < braceStart) return null;
    const name = line.slice(0, braceStart).trim();
    if (!name) return null;
    const valueText = line.slice(braceEnd + 1).trim().split(/\s+/)[0];
    if (!valueText) return null;
    const value = Number(valueText);
    if (!Number.isFinite(value)) return null;
    return { name, labels: parseLabels(line.slice(braceStart + 1, braceEnd)), value };
  }
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const value = Number(parts[1]);
  if (!Number.isFinite(value)) return null;
  return { name: parts[0], labels: {}, value };
}

/** Parse a full Prometheus exposition payload into declared families. */
export function parsePrometheus(text: string): PromFamily[] {
  const help = new Map<string, string>();
  const type = new Map<string, string>();
  const samples: Array<{ name: string; labels: Record<string, string>; value: number }> = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = /^#\s+(HELP|TYPE)\s+(\S+)\s*(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === 'HELP') help.set(m[2], m[3]);
      else type.set(m[2], m[3].trim());
      continue;
    }
    const parsed = parsePromLine(line);
    if (parsed) samples.push(parsed);
  }

  // Resolve each sample to a declared family, folding histogram/summary
  // component series back into their base name.
  const families = new Map<string, PromFamily>();
  const familyFor = (name: string): PromFamily => {
    let base = name;
    if (!type.has(name) && !help.has(name)) {
      for (const suffix of ['_bucket', '_sum', '_count']) {
        if (!name.endsWith(suffix)) continue;
        const candidate = name.slice(0, -suffix.length);
        if (type.has(candidate) || help.has(candidate)) {
          base = candidate;
          break;
        }
      }
    }
    let fam = families.get(base);
    if (!fam) {
      fam = { name: base, help: help.get(base), type: type.get(base), samples: [] };
      families.set(base, fam);
    }
    return fam;
  };

  for (const s of samples) familyFor(s.name).samples.push({ labels: s.labels, value: s.value });

  return [...families.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Convenience lookup for a single unlabeled series. */
export function promValue(families: PromFamily[], name: string): number | null {
  const fam = families.find((f) => f.name === name && f.samples.length === 1);
  return fam ? fam.samples[0].value : null;
}

/** Group thousands with a fixed locale so rendering does not shift by host. */
function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Render a metric value without inventing units the engine did not publish. */
export function formatPromValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const neg = v < 0;
  const abs = Math.abs(v);
  let out: string;
  if (Number.isInteger(v)) out = groupThousands(String(abs));
  else if (abs >= 1000) {
    const [i, f = ''] = abs.toFixed(2).split('.');
    out = `${groupThousands(i)}.${f}`;
  } else if (abs >= 1) out = abs.toFixed(3);
  else out = abs.toPrecision(4);
  return neg ? `-${out}` : out;
}

export function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${labels[k]}"`).join(', ')}}`;
}
