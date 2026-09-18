import { test, expect } from '@playwright/test';
import type { RunSnapshot } from '../src/lib/agentRuns';
import { mockControl } from './helpers/scripted-api';

// Server workers survive page loss; the sidebar reattaches by ID and replaces
// its transcript from canonical snapshots rather than appending replayed text.
test('coder reattaches to a live server run after a dropped stream and reload', async ({ page }) => {
  await mockControl(page);
  const snap: RunSnapshot = {
    id: 'worker-reconnect', kind: 'worker', label: 'Reconnect fixture', model: 'test-model',
    status: 'running', turns: 1, maxSteps: 10, updatedAt: 1,
    messages: [{ role: 'assistant', content: 'Before disconnect' }],
    finishReason: null, error: null, stop: null, pendingApprovals: [], userQuestion: null,
    pendingGate: null, scope: '/test/workspace', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, lastMeta: null,
  };
  let connections = 0;
  let starts = 0;
  let stops = 0;
  await page.route('**/api/agent/runs', async route => {
    if (route.request().method() === 'POST') starts++;
    await route.fulfill({ json: [snap] });
  });
  await page.route('**/api/agent/runs/worker-reconnect', route => route.fulfill({ json: snap }));
  await page.route('**/api/agent/runs/worker-reconnect/events', async route => {
    connections++;
    // A transport failure drives the real RunStream resynchronization loop.
    await route.abort('failed');
  });
  await page.route('**/api/agent/runs/worker-reconnect/stop', async route => {
    stops++;
    snap.status = 'stopped';
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Code', exact: true }).click();
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.getByRole('button', { name: 'Reconnect fixture', exact: true }).click();
  await expect(page.getByText('Before disconnect', { exact: true })).toBeVisible();
  await expect.poll(() => connections).toBeGreaterThan(0);
  snap.messages.push({ role: 'assistant', content: 'Recovered while disconnected' });
  await expect(page.getByText('Recovered while disconnected', { exact: true })).toBeVisible();
  await expect(page.getByText('Before disconnect', { exact: true })).toHaveCount(1);
  const beforeReload = connections;
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: 'Code', exact: true }).click();
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await page.getByRole('button', { name: 'Reconnect fixture', exact: true }).click();
  await expect(page.getByText('Recovered while disconnected', { exact: true })).toBeVisible();
  await expect.poll(() => connections).toBeGreaterThan(beforeReload);
  snap.status = 'done';
  snap.messages.push({ role: 'assistant', content: 'Worker completed' });
  await expect(page.getByText('Worker completed', { exact: true })).toBeVisible();
  await expect(page.getByText('Recovered while disconnected', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeHidden();
  expect(starts).toBe(0);
  expect(stops).toBe(0);
});
