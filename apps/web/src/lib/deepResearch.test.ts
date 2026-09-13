import { describe, it, expect } from 'vitest';
import { parseResearchAngles } from './deepResearch';

describe('parseResearchAngles', () => {
  it('parses a numbered list into trimmed angle strings', () => {
    const raw = '1. Performance characteristics\n2. Ecosystem maturity\n3. Learning curve';
    expect(parseResearchAngles(raw, 3, 'fallback')).toEqual([
      'Performance characteristics',
      'Ecosystem maturity',
      'Learning curve',
    ]);
  });

  it('accepts "1)" style numbering too', () => {
    expect(parseResearchAngles('1) one\n2) two', 3, 'fallback')).toEqual(['one', 'two']);
  });

  it('caps at maxAngles even when the model returns more', () => {
    const raw = '1. a\n2. b\n3. c\n4. d';
    expect(parseResearchAngles(raw, 2, 'fallback')).toEqual(['a', 'b']);
  });

  it('drops blank lines', () => {
    expect(parseResearchAngles('1. a\n\n2. b\n', 3, 'fallback')).toEqual(['a', 'b']);
  });

  it('falls back to the original question when nothing parseable comes back', () => {
    expect(parseResearchAngles('', 3, 'the original question')).toEqual(['the original question']);
    expect(parseResearchAngles('   \n  \n', 3, 'the original question')).toEqual(['the original question']);
  });

  it('treats un-numbered lines as angles too (no numbering requirement)', () => {
    expect(parseResearchAngles('just one plain line', 3, 'fallback')).toEqual(['just one plain line']);
  });
});
