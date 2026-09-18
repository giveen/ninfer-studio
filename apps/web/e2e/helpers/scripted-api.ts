import { expect, type Page } from '@playwright/test';

/** Isolated control-plane storage; no requests reach a developer's running engine. */
export async function mockControl(page: Page) {
  const state = {
    engine: { state: 'running', port: 8080, modelId: 'test-model' },
    config: { enginePort: 8080, modelsDir: '/test/models', ninferPath: '/test/ninfer', apiKey: '', hfCli: '', currencySymbol: '$', costPerKwh: 0 },
    conversations: { conversations: [], params: null } as Record<string, unknown>,
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    let json: unknown = {};
    if (path === '/api/status') json = { ...state, artifacts: [], engines: [], gpu: { available: false } };
    if (path === '/api/config') {
      if (route.request().method() === 'POST') Object.assign(state.config, route.request().postDataJSON());
      json = state.config;
    }
    if (path === '/api/conversations') {
      if (route.request().method() === 'POST') Object.assign(state.conversations, route.request().postDataJSON());
      json = state.conversations;
    }
    if (path === '/api/profile-state') json = { artifact: '/test/model.ninfer', saved: [] };
    if (path === '/api/logs') json = { lines: [], size: 0 };
    if (path === '/api/agent/runs') json = [];
    if (path === '/api/mcp/tools') json = { tools: [] };
    if (path === '/api/coder/workspace') json = { cwd: '/test/workspace' };
    if (path === '/api/coder/memory') json = { bank: '', learnings: [] };
    await route.fulfill({ json });
  });
  await page.route('**/v1/**', route => {
    // These fixtures exercise Chat Completions, not the optional Responses API.
    // A successful probe would select a different streaming transport.
    if (new URL(route.request().url()).pathname === '/v1/responses') {
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ json: { data: [{ id: 'test-model' }] } });
  });
  return state;
}

/** Control only the transport, leaving the production SSE parser and UI intact.
 * Each chunk is released after a DOM assertion, never after an arbitrary sleep. */
export async function installChatStream(page: Page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const streams: { controller: ReadableStreamDefaultController<Uint8Array>; body: unknown; aborted: boolean }[] = [];
    Object.assign(window, { testStreams: streams });
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.includes('/chat/completions')) return original(input, init);
      let entry: typeof streams[number];
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        entry = { controller, body: JSON.parse(String(init?.body)), aborted: false };
        streams.push(entry);
        init?.signal?.addEventListener('abort', () => {
          entry.aborted = true;
          controller.error(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      } });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
}

export async function streamCount(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => (window as any).testStreams.length)).toBe(count);
}
export async function chunk(page: Page, delta: object, index = 0, finish: string | null = null) {
  await page.evaluate(({ delta, index, finish }) => {
    (window as any).testStreams[index].controller.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    ));
  }, { delta, index, finish });
}
export async function finishStream(page: Page, index = 0) {
  await chunk(page, {}, index, 'stop');
  await page.evaluate(index => {
    const c = (window as any).testStreams[index].controller;
    c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    c.close();
  }, index);
}
