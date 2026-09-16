import { describe, it, expect } from 'vitest';
import { parseReflectionVerdict } from './chat';

describe('parseReflectionVerdict', () => {
  it('returns null for an approved verdict', () => {
    expect(parseReflectionVerdict('VERDICT: APPROVED')).toBeNull();
  });
  it('is case-insensitive on the verdict keyword', () => {
    expect(parseReflectionVerdict('verdict: approved')).toBeNull();
  });
  it('returns the critique text, stripped of the verdict line, for NEEDS_REVISION', () => {
    const raw = 'VERDICT: NEEDS_REVISION\nThe reply ignores the second part of the question.';
    expect(parseReflectionVerdict(raw)).toBe('The reply ignores the second part of the question.');
  });
  it('returns null when NEEDS_REVISION has no actual critique text', () => {
    expect(parseReflectionVerdict('VERDICT: NEEDS_REVISION')).toBeNull();
  });
  it('returns null for text with no verdict line at all (nothing to act on)', () => {
    expect(parseReflectionVerdict('I have no opinion.')).toBeNull();
  });
  it('returns null for spurious critiques flagging system time/date context or tool fabrications', () => {
    expect(parseReflectionVerdict('VERDICT: NEEDS_REVISION\nThe time and timezone came from your system context.')).toBeNull();
    expect(parseReflectionVerdict('VERDICT: NEEDS_REVISION\nI made up those NWS numbers without a live tool source.')).toBeNull();
  });
});
