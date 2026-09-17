import { describe, it, expect } from 'vitest';
import { buildChatRequest, parseReflectionVerdict } from './chat';

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

describe('buildChatRequest', () => {
  it('strips mid-history system messages and adds cache_control to system prompt and last user message when cacheSystem is true', () => {
    const req = buildChatRequest(
      'mock-model',
      'System prompt text',
      [
        { role: 'user', content: 'Turn 1' },
        { role: 'assistant', content: 'Reply 1' },
        { role: 'system', content: 'Mid-history system note' },
        { role: 'user', content: 'Turn 2' },
      ],
      {},
      {},
      true,
    );
    const msgs = req.messages as Array<{ role: string; content: unknown }>;
    // Mid-history system message stripped
    expect(msgs.length).toBe(4);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'System prompt text', cache_control: { type: 'ephemeral' } }]);
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toBe('Turn 1');
    expect(msgs[2].role).toBe('assistant');
    expect(msgs[3].role).toBe('user');
    expect(msgs[3].content).toEqual([{ type: 'text', text: 'Turn 2', cache_control: { type: 'ephemeral' } }]);
  });

  it('allows derived parameters (greedy, enable_thinking) to override extraParams defaults', () => {
    const req = buildChatRequest(
      'mock-model',
      'sys',
      [{ role: 'user', content: 'hi' }],
      {},
      { temperature: 0.9, enable_thinking: false },
    );
    expect(req.temperature).toBe(0.9);
    expect(req.enable_thinking).toBeUndefined();
  });
});
