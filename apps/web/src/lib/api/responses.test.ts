import { describe, it, expect } from 'vitest';
import {
  paramsSupportedByResponses,
  toResponsesItems,
  toResponsesTools,
  toResponsesReasoning,
  buildResponsesBody,
  applyResponsesEvent,
  initResponsesState,
} from './responses';
import type { ChatParams } from '../types';

const BASE_PARAMS: ChatParams = { thinking: true };

describe('paramsSupportedByResponses', () => {
  it('is true when no unsupported sampling field is set', () => {
    expect(paramsSupportedByResponses({ ...BASE_PARAMS, temperature: 0.7, topP: 0.9 })).toBe(true);
  });
  it.each(['topK', 'minP', 'presencePenalty', 'frequencyPenalty', 'seed'] as const)(
    'is false when %s is set',
    (field) => {
      expect(paramsSupportedByResponses({ ...BASE_PARAMS, [field]: 1 })).toBe(false);
    },
  );
});

describe('toResponsesItems', () => {
  it('converts a tool-role message to a function_call_output item', () => {
    expect(toResponsesItems({ role: 'tool', content: 'result text', tool_call_id: 'call_1' })).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: 'result text' },
    ]);
  });
  it('JSON-stringifies non-string tool content', () => {
    const [item] = toResponsesItems({ role: 'tool', content: { ok: true } as unknown as string, tool_call_id: 'call_1' });
    expect(item.output).toBe('{"ok":true}');
  });
  it('splits an assistant message with tool_calls into a text item plus one function_call per call', () => {
    const items = toResponsesItems({
      role: 'assistant',
      content: 'thinking out loud',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }],
    });
    expect(items).toEqual([
      { role: 'assistant', content: 'thinking out loud' },
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' },
    ]);
  });
  it('omits the text item when content is empty', () => {
    const items = toResponsesItems({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
    });
    expect(items).toEqual([{ type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{}' }]);
  });
  it('passes a plain user/assistant message through as one role/content item', () => {
    expect(toResponsesItems({ role: 'user', content: 'hi' })).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('toResponsesTools', () => {
  it('returns undefined for no tools', () => {
    expect(toResponsesTools(undefined)).toBeUndefined();
    expect(toResponsesTools([])).toBeUndefined();
  });
  it('flattens {type,function:{...}} into a flat {type,name,description,parameters}', () => {
    const tools = [{ type: 'function', function: { name: 'web_fetch', description: 'fetch a url', parameters: { type: 'object' } } }];
    expect(toResponsesTools(tools)).toEqual([{ type: 'function', name: 'web_fetch', description: 'fetch a url', parameters: { type: 'object' } }]);
  });
});

describe('toResponsesReasoning', () => {
  it('maps enable_thinking:false to effort:none regardless of reasoning_effort', () => {
    expect(toResponsesReasoning({ enable_thinking: false, reasoning_effort: 'high' })).toEqual({ effort: 'none' });
  });
  it('forwards an explicit reasoning_effort when thinking is not explicitly off', () => {
    expect(toResponsesReasoning({ reasoning_effort: 'medium' })).toEqual({ effort: 'medium' });
  });
  it('is undefined when neither is set (engine default applies)', () => {
    expect(toResponsesReasoning({})).toBeUndefined();
  });
});

describe('buildResponsesBody', () => {
  it('assembles model/input/stream plus only the forwarded sampling fields', () => {
    const body = buildResponsesBody({
      model: 'qwen3.8-27b',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      top_p: 0.9,
      top_k: 40, // must NOT be forwarded — unsupported by this transport
      max_completion_tokens: 2048,
    });
    expect(body).toEqual({
      model: 'qwen3.8-27b',
      input: [{ role: 'user', content: 'hi' }],
      stream: true,
      max_output_tokens: 2048,
      temperature: 0.5,
      top_p: 0.9,
    });
  });
  it('adds tools + tool_choice:auto only when tools are present', () => {
    const body = buildResponsesBody({
      model: 'm',
      messages: [],
      tools: [{ type: 'function', function: { name: 'web_search', parameters: {} } }],
    });
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([{ type: 'function', name: 'web_search', description: undefined, parameters: {} }]);
  });
});

describe('applyResponsesEvent', () => {
  it('emits a content delta and never mutates completed/calls', () => {
    const state = initResponsesState();
    const effect = applyResponsesEvent(JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' }), state);
    expect(effect).toEqual({ contentDelta: 'Hello' });
    expect(state.completed).toBe(false);
  });

  it('emits a reasoning delta', () => {
    const state = initResponsesState();
    const effect = applyResponsesEvent(JSON.stringify({ type: 'response.reasoning_text.delta', delta: 'thinking…' }), state);
    expect(effect).toEqual({ reasoningDelta: 'thinking…' });
  });

  it('records the call_id <-> item_id pairing on output_item.added, then assembles the call on function_call_arguments.done', () => {
    const state = initResponsesState();
    applyResponsesEvent(
      JSON.stringify({ type: 'response.output_item.added', item: { id: 'fc_1', call_id: 'call_1', type: 'function_call', name: 'web_search' } }),
      state,
    );
    expect(state.calls.get('call_1')).toEqual({ name: 'web_search', arguments: '' });

    applyResponsesEvent(
      JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'fc_1', name: 'web_search', arguments: '{"query":"rust"}' }),
      state,
    );
    expect(state.calls.get('call_1')).toEqual({ name: 'web_search', arguments: '{"query":"rust"}' });
  });

  it('falls back to item_id as the call key when output_item.added was never seen', () => {
    const state = initResponsesState();
    applyResponsesEvent(
      JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'fc_orphan', name: 'browser', arguments: '{}' }),
      state,
    );
    expect(state.calls.get('fc_orphan')).toEqual({ name: 'browser', arguments: '{}' });
  });

  it('response.completed sets completed=true, fills usage/finishReason, and reconciles calls from the authoritative output array', () => {
    const state = initResponsesState();
    const effect = applyResponsesEvent(
      JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 5 } },
          output: [{ type: 'function_call', call_id: 'call_9', name: 'web_fetch', arguments: '{"url":"https://x"}' }],
        },
      }),
      state,
    );
    expect(state.completed).toBe(true);
    expect(state.meta).toMatchObject({ promptTokens: 100, completionTokens: 20, cachedTokens: 10, reasoningTokens: 5, finishReason: 'tool_calls' });
    expect(state.calls.get('call_9')).toEqual({ name: 'web_fetch', arguments: '{"url":"https://x"}' });
    expect(effect.usage).toBeDefined();
  });

  it('response.completed with no function_call output and status!=incomplete finishes with stop', () => {
    const state = initResponsesState();
    applyResponsesEvent(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } }), state);
    expect(state.meta.finishReason).toBe('stop');
  });

  it('response.completed with status:incomplete and no tool calls finishes with length', () => {
    const state = initResponsesState();
    applyResponsesEvent(JSON.stringify({ type: 'response.completed', response: { status: 'incomplete', output: [] } }), state);
    expect(state.meta.finishReason).toBe('length');
  });

  it('response.failed surfaces the error message', () => {
    const state = initResponsesState();
    const effect = applyResponsesEvent(JSON.stringify({ type: 'response.failed', response: { error: { message: 'boom' } } }), state);
    expect(effect.error).toBe('boom');
  });

  it('an unknown event type is a no-op', () => {
    const state = initResponsesState();
    expect(applyResponsesEvent(JSON.stringify({ type: 'response.some_future_event' }), state)).toEqual({});
  });

  it('malformed JSON is silently ignored rather than throwing', () => {
    const state = initResponsesState();
    expect(() => applyResponsesEvent('{not json', state)).not.toThrow();
    expect(applyResponsesEvent('{not json', state)).toEqual({});
  });
});
