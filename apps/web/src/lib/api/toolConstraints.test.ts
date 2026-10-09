import { describe, expect, it } from 'vitest';
import { buildChatRequest } from './chat';
import type { ChatParams } from '../types';

const HISTORY = [{ role: 'user' as const, content: 'hi' }];
const TOOLS = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }];

function body(params: Partial<ChatParams>, extra?: Record<string, unknown>) {
  return buildChatRequest('m', undefined, HISTORY, params as ChatParams, extra);
}

describe('tool constraint mapping', () => {
  it('sends nothing when the request carries no tools', () => {
    const req = body({ toolConstraints: 'auto', parallelToolCalls: false });
    expect(req.tool_constraints).toBeUndefined();
    expect(req.parallel_tool_calls).toBeUndefined();
  });

  it('omits tool_constraints for the engine default (basic)', () => {
    const req = body({ toolConstraints: 'basic' }, { tools: TOOLS });
    expect(req.tools).toEqual(TOOLS);
    expect(req.tool_constraints).toBeUndefined();
  });

  it('sends tool_constraints:auto as the explicit opt-out', () => {
    const req = body({ toolConstraints: 'auto' }, { tools: TOOLS });
    expect(req.tool_constraints).toBe('auto');
  });

  it('sends parallel_tool_calls only when it is disabled', () => {
    expect(body({ parallelToolCalls: true }, { tools: TOOLS }).parallel_tool_calls).toBeUndefined();
    expect(body({ parallelToolCalls: false }, { tools: TOOLS }).parallel_tool_calls).toBe(false);
  });

  it('ignores an empty tools array', () => {
    const req = body({ toolConstraints: 'auto', parallelToolCalls: false }, { tools: [] });
    expect(req.tool_constraints).toBeUndefined();
    expect(req.parallel_tool_calls).toBeUndefined();
  });
});
