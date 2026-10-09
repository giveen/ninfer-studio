import { describe, expect, it } from 'vitest';
import { formatLabels, formatPromValue, parsePrometheus, parsePromLine, promValue } from './prometheus';

describe('parsePromLine', () => {
  it('parses a labeled sample', () => {
    expect(parsePromLine('ninfer_requests_total{outcome="ok"} 42')).toEqual({
      name: 'ninfer_requests_total',
      labels: { outcome: 'ok' },
      value: 42,
    });
  });

  it('parses an unlabeled sample and ignores a timestamp', () => {
    expect(parsePromLine('ninfer_engine_ready 1 1730000000000')).toEqual({
      name: 'ninfer_engine_ready',
      labels: {},
      value: 1,
    });
  });

  it('parses multiple labels and unescapes values', () => {
    expect(parsePromLine('m{a="x",b="y\\"z",c="a\\nb"} 1.5')).toEqual({
      name: 'm',
      labels: { a: 'x', b: 'y"z', c: 'a\nb' },
      value: 1.5,
    });
  });

  it('rejects NaN/invalid payloads', () => {
    expect(parsePromLine('m{a="x"} notanumber')).toBeNull();
    expect(parsePromLine('m{a="x"}')).toBeNull();
    expect(parsePromLine('{a="x"} 1')).toBeNull();
    expect(parsePromLine('m 1.5 extra tokens')).toEqual({ name: 'm', labels: {}, value: 1.5 });
  });
});

describe('parsePrometheus', () => {
  const payload = [
    '# HELP ninfer_engine_ready Engine readiness.',
    '# TYPE ninfer_engine_ready gauge',
    'ninfer_engine_ready 1',
    '# HELP ninfer_requests_total Generation attempts.',
    '# TYPE ninfer_requests_total counter',
    'ninfer_requests_total{outcome="completed"} 7',
    'ninfer_requests_total{outcome="cancelled"} 1',
    '# HELP ninfer_ttft Ninfer ttft.',
    '# TYPE ninfer_ttft histogram',
    'ninfer_ttft_bucket{le="0.5"} 3',
    'ninfer_ttft_bucket{le="+Inf"} 4',
    'ninfer_ttft_sum 1.2',
    'ninfer_ttft_count 4',
    '',
    '# a stray comment',
    'undocumented_series 9',
  ].join('\n');

  it('groups samples under their declared family', () => {
    const fams = parsePrometheus(payload);
    const byName = Object.fromEntries(fams.map((f) => [f.name, f]));

    expect(byName.ninfer_engine_ready.type).toBe('gauge');
    expect(byName.ninfer_engine_ready.help).toBe('Engine readiness.');
    expect(byName.ninfer_engine_ready.samples).toEqual([{ labels: {}, value: 1 }]);

    expect(byName.ninfer_requests_total.samples).toHaveLength(2);
    expect(byName.ninfer_requests_total.samples.map((s) => s.labels.outcome)).toEqual([
      'completed',
      'cancelled',
    ]);
  });

  it('folds histogram component series into the declared family', () => {
    const byName = Object.fromEntries(parsePrometheus(payload).map((f) => [f.name, f]));
    expect(byName.ninfer_ttft.type).toBe('histogram');
    expect(byName.ninfer_ttft.samples).toHaveLength(4);
    expect(byName.ninfer_ttft_bucket).toBeUndefined();
    expect(byName.ninfer_ttft_sum).toBeUndefined();
  });

  it('keeps series with no HELP/TYPE directive as their own family', () => {
    const byName = Object.fromEntries(parsePrometheus(payload).map((f) => [f.name, f]));
    expect(byName.undocumented_series.samples).toEqual([{ labels: {}, value: 9 }]);
    expect(byName.undocumented_series.type).toBeUndefined();
  });

  it('sorts families by name and handles an empty payload', () => {
    const names = parsePrometheus(payload).map((f) => f.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(parsePrometheus('')).toEqual([]);
  });
});

describe('promValue', () => {
  it('returns the value of a single-sample family only', () => {
    const fams = parsePrometheus('a 1\na 2\nb 3\n');
    expect(promValue(fams, 'b')).toBe(3);
    expect(promValue(fams, 'a')).toBeNull();
    expect(promValue(fams, 'missing')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats integers with grouped thousands', () => {
    expect(formatPromValue(0)).toBe('0');
    expect(formatPromValue(1234567)).toBe('1,234,567');
  });

  it('formats fractional values by magnitude', () => {
    expect(formatPromValue(1234.5)).toBe('1,234.50');
    expect(formatPromValue(2.5)).toBe('2.500');
    expect(formatPromValue(0.000123)).toBe('0.0001230');
    expect(formatPromValue(-3)).toBe('-3');
  });

  it('renders labels without unstable ordering', () => {
    expect(formatLabels({})).toBe('');
    expect(formatLabels({ outcome: 'ok' })).toBe('{outcome="ok"}');
    expect(formatLabels({ a: '1', b: '2' })).toBe('{a="1", b="2"}');
  });
});
