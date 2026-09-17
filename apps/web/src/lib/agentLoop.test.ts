// Regression harness for the core agent mechanism: runToolLoop's
// stream -> dispatch -> recurse cycle. A scripted mock StreamFn stands in
// for the engine (no network, no live model) so these tests catch a future
// change breaking tool-call dispatch, message accumulation, step-budget
// enforcement, or markup recovery — the things a live-browser check won't
// reliably re-exercise on every change.

import { describe, it, expect, vi } from 'vitest';
import { runToolLoop, isCompactedMsg, compactedContext, type StreamFn, type ToolRegistry } from './agentLoop';
import type { ChatMessage, ChatParams } from './types';

const PARAMS: ChatParams = { thinking: false };

/** One scripted engine turn: what `streamTurn`'s callbacks should report. */
interface ScriptedTurn {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
}

/** A StreamFn that replays `turns` in order, one per call — the test's stand-in
 *  for the engine, driving the exact same ChatStreamCallbacks contract
 *  streamChat/streamResponses do. */
function scriptedStream(turns: ScriptedTurn[]): StreamFn {
  let i = 0;
  return async (_req, _signal, cb) => {
    const t = turns[i++] ?? { content: '' };
    if (t.content) cb.onContentDelta?.(t.content);
    if (t.toolCalls) cb.onToolCalls?.(t.toolCalls);
    cb.onDone?.({ finishReason: t.finishReason ?? (t.toolCalls?.length ? 'tool_calls' : 'stop') });
  };
}

describe('runToolLoop', () => {
  it('runs a plain content-only turn with no tool calls (stop: done, 0 turns consumed)', async () => {
    const res = await runToolLoop({
      model: 'm', system: undefined, messages: [{ role: 'user', content: 'hi' }], params: PARAMS,
      registry: {}, maxSteps: 5, signal: new AbortController().signal,
      stream: scriptedStream([{ content: 'Hello there.' }]),
    });
    expect(res.stop).toBe('done');
    expect(res.turns).toBe(0);
    expect(res.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Hello there.' });
  });

  it('dispatches a native tool call through the registry, appends the tool result, then finishes on the next turn', async () => {
    const handler = vi.fn(async (args: Record<string, unknown>) => JSON.stringify({ echoed: args.query }));
    const registry: ToolRegistry = { web_search: handler };
    const res = await runToolLoop({
      model: 'm', system: 's', messages: [{ role: 'user', content: 'search for rust' }], params: PARAMS,
      registry, maxSteps: 5, signal: new AbortController().signal,
      stream: scriptedStream([
        { toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{"query":"rust"}' }] },
        { content: 'Rust is a systems language.' },
      ]),
    });
    expect(handler).toHaveBeenCalledWith({ query: 'rust' }, expect.anything());
    expect(res.stop).toBe('done');
    expect(res.turns).toBe(1); // one completed tool cycle
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ tool_call_id: 'call_1', name: 'web_search', content: '{"echoed":"rust"}' });
    expect(res.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Rust is a systems language.' });
  });

  it('isolates a throwing handler into a tool-role error result instead of aborting the run', async () => {
    const registry: ToolRegistry = { boom: async () => { throw new Error('kaboom'); } };
    const res = await runToolLoop({
      model: 'm', system: undefined, messages: [{ role: 'user', content: 'go' }], params: PARAMS,
      registry, maxSteps: 5, signal: new AbortController().signal,
      stream: scriptedStream([
        { toolCalls: [{ id: 'call_1', name: 'boom', arguments: '{}' }] },
        { content: 'done' },
      ]),
    });
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content)).toEqual({ error: 'kaboom' });
    expect(res.stop).toBe('done');
  });

  it('reports an unknown tool name as an error result rather than throwing', async () => {
    const res = await runToolLoop({
      model: 'm', system: undefined, messages: [{ role: 'user', content: 'go' }], params: PARAMS,
      registry: {}, maxSteps: 5, signal: new AbortController().signal,
      stream: scriptedStream([
        { toolCalls: [{ id: 'call_1', name: 'nonexistent_tool', arguments: '{}' }] },
        { content: 'done' },
      ]),
    });
    const toolMsg = res.messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content)).toEqual({ error: 'unknown tool: nonexistent_tool' });
  });

  it('stops with "steps" once maxSteps tool cycles are exhausted without a final reply', async () => {
    const registry: ToolRegistry = { loop_tool: async () => '{}' };
    // Every scripted turn keeps calling the tool again — never produces a
    // content-only final turn, so the budget must be what stops the loop.
    const turns: ScriptedTurn[] = Array.from({ length: 10 }, () => ({
      toolCalls: [{ id: 'call_x', name: 'loop_tool', arguments: '{}' }],
    }));
    const res = await runToolLoop({
      model: 'm', system: undefined, messages: [{ role: 'user', content: 'go' }], params: PARAMS,
      registry, maxSteps: 3, signal: new AbortController().signal,
      stream: scriptedStream(turns),
    });
    expect(res.stop).toBe('steps');
    expect(res.turns).toBe(3);
  });

  it('stops immediately with "aborted" when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await runToolLoop({
      model: 'm', system: undefined, messages: [{ role: 'user', content: 'go' }], params: PARAMS,
      registry: {}, maxSteps: 5, signal: ac.signal,
      stream: scriptedStream([{ content: 'should never run' }]),
    });
    expect(res.stop).toBe('aborted');
    expect(res.messages).toHaveLength(1); // only the seed user message
  });

  it('treats a response with neither content nor tool calls as a clean no-op ("empty"), not a blank bubble', async () => {
    const res = await runToolLoop({
      model: 'm', system: undefined, messages: [{ role: 'user', content: 'go' }], params: PARAMS,
      registry: {}, maxSteps: 5, signal: new AbortController().signal,
      stream: scriptedStream([{ content: '' }]),
    });
    expect(res.stop).toBe('empty');
    expect(res.messages).toHaveLength(1); // the seed message only — no blank assistant turn pushed
  });

  it('recovers a <tool_call> markup call when the model has no declared tools but emits one as text (recoverMarkup default on)', async () => {
    const handler = vi.fn(async () => '{"ok":true}');
    const registry: ToolRegistry = { web_search: handler };
    const res = await runToolLoop({
      model: 'm', system: undefined, messages: [{ role: 'user', content: 'go' }], params: PARAMS,
      tools: [{ type: 'function', function: { name: 'web_search' } }],
      registry, maxSteps: 5, signal: new AbortController().signal,
      stream: scriptedStream([
        { content: 'Let me check.\n<tool_call>{"name":"web_search","arguments":{"query":"x"}}</tool_call>' },
        { content: 'Found it.' },
      ]),
    });
    expect(handler).toHaveBeenCalledWith({ query: 'x' }, expect.anything());
    // The markup itself is stripped from the visible assistant content.
    const firstAssistant = res.messages.find((m) => m.role === 'assistant');
    expect(firstAssistant?.content).toBe('Let me check.');
    expect(res.stop).toBe('done');
  });

  it('nudges the model back into the loop when its markup names a tool that is not offered (undeclared bash)', async () => {
    // The reported Chat failure: the model emits XML-ish markup for `bash`
    // while only web_search is declared. Recovery parses it, the
    // declared-set filter drops it, and the run must NOT strand with raw
    // markup as the final reply — a system nudge names the available tools
    // and the model answers on the next turn. (Angle brackets built from
    // char codes so the markup stays data, never source structure.)
    const LT = String.fromCharCode(60);
    const GT = String.fromCharCode(62);
    const markup = LT + 'tool_call' + GT + ' ' + LT + 'function=bash' + GT
      + ' ' + LT + 'parameter=command' + GT + 'du -sh /tmp' + LT + '/parameter' + GT
      + ' ' + LT + '/function' + GT + ' ' + LT + '/tool_call' + GT;
    const handler = vi.fn(async () => '{"echoed":"x"}');
    const registry: ToolRegistry = { web_search: handler };
    const res = await runToolLoop({
      model: 'm', system: undefined, messages: [{ role: 'user', content: 'go' }], params: PARAMS,
      tools: [{ type: 'function', function: { name: 'web_search' } }],
      registry, maxSteps: 5, signal: new AbortController().signal,
      stream: scriptedStream([
        { content: markup },
        { content: 'I cannot run shell commands here.' },
      ]),
    });
    expect(handler).not.toHaveBeenCalled();
    const nudge = res.messages.find((m) => m.role === 'system');
    expect(nudge?.content).toContain('bash');
    expect(nudge?.content).toContain('web_search');
    expect(res.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'I cannot run shell commands here.' });
    expect(res.stop).toBe('done');
  });
  it('onAssistantTurn can override content for the final turn (the humanize/reflection hook point)', async () => {
    const res = await runToolLoop({
      model: 'm', system: undefined, messages: [{ role: 'user', content: 'go' }], params: PARAMS,
      registry: {}, maxSteps: 5, signal: new AbortController().signal,
      stream: scriptedStream([{ content: 'draft reply' }]),
      onAssistantTurn: async (msg) => (msg.content === 'draft reply' ? { content: 'polished reply' } : undefined),
    });
    expect(res.messages.at(-1)).toMatchObject({ content: 'polished reply' });
  });

  it('onAssistantTurn can halt the run early even with pending tool calls', async () => {
    const registry: ToolRegistry = { web_search: async () => '{}' };
    const res = await runToolLoop({
      model: 'm', system: undefined, messages: [{ role: 'user', content: 'go' }], params: PARAMS,
      registry, maxSteps: 5, signal: new AbortController().signal,
      stream: scriptedStream([{ toolCalls: [{ id: 'call_1', name: 'web_search', arguments: '{}' }] }]),
      onAssistantTurn: async () => ({ halt: true }),
    });
    expect(res.stop).toBe('halted');
    // Halted before the tool call was ever dispatched — no tool-role message.
    expect(res.messages.some((m) => m.role === 'tool')).toBe(false);
  });
});

describe('isCompactedMsg & compactedContext', () => {
  it('identifies compaction checkpoint user messages anchored at the start', () => {
    const validCheckpoint: ChatMessage = {
      role: 'user',
      content: '<compacted-summary>\n## Primary Request\n- do X',
    };
    const validWithLeadingSpace: ChatMessage = {
      role: 'user',
      content: '  \n<compacted-summary>\n## Primary Request',
    };
    const pastedMention: ChatMessage = {
      role: 'user',
      content: 'Here is how <compacted-summary> works in our codebase',
    };
    const assistantMention: ChatMessage = {
      role: 'assistant',
      content: '<compacted-summary>\nfake summary',
    };

    expect(isCompactedMsg(validCheckpoint)).toBe(true);
    expect(isCompactedMsg(validWithLeadingSpace)).toBe(true);
    expect(isCompactedMsg(pastedMention)).toBe(false);
    expect(isCompactedMsg(assistantMention)).toBe(false);
  });

  it('compactedContext slices from the last valid checkpoint onward', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Turn 1: initial prompt' },
      { role: 'assistant', content: 'Reply 1' },
      { role: 'user', content: '<compacted-summary>\n## Checkpoint 1' },
      { role: 'assistant', content: 'Reply 2' },
      { role: 'user', content: 'Pasted mention of <compacted-summary> tag' },
      { role: 'assistant', content: 'Reply 3' },
    ];

    const sliced = compactedContext(msgs);
    expect(sliced.length).toBe(4);
    expect(sliced[0].content).toContain('Checkpoint 1');
  });

  it('compactedContext returns full history when no checkpoint exists', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Reply 1' },
    ];
    expect(compactedContext(msgs)).toEqual(msgs);
  });
});
