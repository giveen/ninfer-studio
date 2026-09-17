import { describe, it, expect } from 'vitest';
import {
  buildChatRequest,
  parseReflectionVerdict,
  validateOutputReceipt,
  parseFollowUps,
  formatSummarizedOutput,
} from './chat';
import type { ChatParams } from '../types';

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
  it('returns valid critiques mentioning tools without false-positive rejection', () => {
    const raw = 'VERDICT: NEEDS_REVISION\nYou called the read tool on a binary file.';
    expect(parseReflectionVerdict(raw)).toBe('You called the read tool on a binary file.');
  });
  it('returns null when NEEDS_REVISION has no actual critique text', () => {
    expect(parseReflectionVerdict('VERDICT: NEEDS_REVISION')).toBeNull();
  });
  it('returns null for text with no verdict line at all (nothing to act on)', () => {
    expect(parseReflectionVerdict('I have no opinion.')).toBeNull();
  });
  it('returns null for spurious critiques flagging system time/date context or tool fabrications', () => {
    expect(parseReflectionVerdict('VERDICT: NEEDS_REVISION\nThe time and timezone came from your system context.')).toBeNull();
    expect(parseReflectionVerdict('VERDICT: NEEDS_REVISION\nI made up those NWS numbers without a live source.')).toBeNull();
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
      { thinking: false },
      {},
      true,
    );
    const msgs = req.messages as Array<{ role: string; content: unknown }>;
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
      {} as ChatParams,
      { temperature: 0.9, enable_thinking: false },
    );
    expect(req.temperature).toBe(0.9);
    expect(req.enable_thinking).toBeUndefined();
  });

  it('preserves message role and metadata for attachments', () => {
    const req = buildChatRequest(
      'mock-model',
      undefined,
      [
        {
          role: 'user',
          content: 'Here is code:',
          attachments: [{ kind: 'file', name: 'main.py', path: 'main.py', content: 'print("hello")' }],
        },
      ],
      { thinking: false },
    );
    const msgs = req.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content.length).toBe(2);
    expect(msgs[0].content[1].text).toContain('[Attached file: main.py]');
  });

  it('sanitizes orphaned tool messages and unfulfilled tool_calls for API compliance', () => {
    const req = buildChatRequest(
      'mock-model',
      undefined,
      [
        { role: 'user', content: 'Run test' },
        { role: 'tool', tool_call_id: 'orphaned_1', name: 'bash', content: 'orphaned result' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'todo_write', arguments: '{}' }] },
      ],
      { thinking: false },
    );
    const msgs = req.messages as Array<{ role: string; content: unknown; tool_call_id?: string }>;
    expect(msgs.length).toBe(4);
    // Orphaned tool message converted to user context message
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('[Historical tool result for bash]');
    // Assistant message preserved
    expect(msgs[2].role).toBe('assistant');
    // Missing tool response fulfilled with dummy tool result
    expect(msgs[3].role).toBe('tool');
    expect(msgs[3].tool_call_id).toBe('call_1');
  });
});

describe('validateOutputReceipt', () => {
  const sourceText = 'Compiling target x...\nError: syntax error at line 42\nBuild failed with exit code 1';

  it('validates a correct receipt with exact matching quotes', () => {
    const receiptJson = JSON.stringify({
      schema: 'ninfer_output_receipt_v1',
      status: 'failure',
      uncertain: false,
      evidence: [{ kind: 'failure', quote: 'Error: syntax error at line 42' }],
    });

    const validated = validateOutputReceipt(receiptJson, sourceText, true);
    expect(validated).not.toBeNull();
    expect(validated?.status).toBe('failure');
    expect(validated?.evidence[0].quote).toBe('Error: syntax error at line 42');
  });

  it('rejects receipts with unquoted / hallucinated evidence', () => {
    const receiptJson = JSON.stringify({
      schema: 'ninfer_output_receipt_v1',
      status: 'failure',
      uncertain: false,
      evidence: [{ kind: 'failure', quote: 'Non-existent error message' }],
    });

    expect(validateOutputReceipt(receiptJson, sourceText, true)).toBeNull();
  });

  it('rejects a success receipt when isError is true', () => {
    const receiptJson = JSON.stringify({
      schema: 'ninfer_output_receipt_v1',
      status: 'success',
      uncertain: false,
      evidence: [{ kind: 'summary', quote: 'Compiling target x...' }],
    });

    expect(validateOutputReceipt(receiptJson, sourceText, true)).toBeNull();
  });
});

describe('parseFollowUps', () => {
  it('parses JSON array of follow-up questions', () => {
    const raw = '["What is the next step?", "Can you explain this function?", "How do I run the tests?"]';
    expect(parseFollowUps(raw)).toEqual([
      'What is the next step?',
      'Can you explain this function?',
      'How do I run the tests?',
    ]);
  });

  it('parses fenced JSON arrays', () => {
    const raw = '```json\n["Step 1?", "Step 2?", "Step 3?"]\n```';
    expect(parseFollowUps(raw)).toEqual(['Step 1?', 'Step 2?', 'Step 3?']);
  });

  it('falls back to quoted string extraction if JSON is truncated', () => {
    const raw = '["How do I fix this?", "Where is the file?", "What';
    expect(parseFollowUps(raw)).toEqual(['How do I fix this?', 'Where is the file?']);
  });

  it('strips <think> blocks before parsing JSON array', () => {
    const raw = '<think>\nLet me think about natural follow ups.\n</think>\n["Option A?", "Option B?", "Option C?"]';
    expect(parseFollowUps(raw)).toEqual(['Option A?', 'Option B?', 'Option C?']);
  });
});

describe('formatSummarizedOutput', () => {
  it('formats output with receipt and tail', () => {
    const receipt = {
      status: 'failure' as const,
      uncertain: false,
      evidence: [{ kind: 'failure' as const, quote: 'Error on line 10' }],
    };
    const formatted = formatSummarizedOutput(5000, receipt, 'line 10 error tail');
    expect(formatted).toContain('AI-summarized output');
    expect(formatted).toContain('status: failure');
    expect(formatted).toContain('line 10 error tail');
  });
});

