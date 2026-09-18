import { test, expect } from '@playwright/test';
import { mockControl, installChatStream, streamCount, chunk, finishStream } from './helpers/scripted-api';

for (const decision of ['Approve once', 'Deny', 'Stop'] as const) {
  test(`coder permission request: ${decision}`, async ({ page }) => {
    await mockControl(page);
    await installChatStream(page);
    await page.addInitScript(() => {
      localStorage.setItem('ninfier.coder.conversations.v2', JSON.stringify({
        activeWs: '/test/workspace', activeConv: 'approval-test', workspaces: {
          '/test/workspace': { expanded: true, order: ['approval-test'], perms: { tools: { read: 'ask' }, denyPaths: [] }, conversations: {
            'approval-test': { id: 'approval-test', title: 'Approval test', updatedAt: Date.now(), messages: [], ledger: [], todos: [], lastPromptTokens: 0 },
          } },
        },
      }));
    });
    const reads: unknown[] = [];
    const approvals: unknown[] = [];
    await page.route('**/api/coder/perms/approve', async route => {
      approvals.push(route.request().postDataJSON());
      await route.fulfill({ json: { token: 'test-ticket' } });
    });
    await page.route('**/api/coder/fs/read', async route => {
      if (route.request().postDataJSON().path !== 'approval-fixture.txt') return route.fallback();
      reads.push(route.request().postDataJSON());
      await route.fulfill({ json: { content: 'Approval fixture content', totalLines: 1 } });
    });
    await page.goto('/');
    await page.getByRole('navigation').getByRole('button', { name: 'Code', exact: true }).click();
    await page.getByPlaceholder('Instruct the coder agent').fill('Read approval-fixture.txt');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await streamCount(page, 1);
    await chunk(page, { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'approval-fixture.txt' }) } }] });
    await finishStream(page);
    await expect(page.getByText('Agent requests approval', { exact: true })).toBeVisible();
    expect(approvals).toHaveLength(0);
    expect(reads).toHaveLength(0);
    const button = page.getByRole('button', { name: decision, exact: true });
    // The approval overlay covers the composer, but keyboard activation of Stop
    // remains available; do not force a pointer through the modal backdrop.
    if (decision === 'Stop') { await button.focus(); await page.keyboard.press('Enter'); }
    else await button.click();
    await expect(page.getByText('Agent requests approval', { exact: true })).toBeHidden();
    if (decision !== 'Stop') {
      await streamCount(page, 2);
      const next = await page.evaluate(() => (window as any).testStreams[1].body);
      expect(JSON.stringify(next)).toContain(decision === 'Deny' ? 'Denied by the user' : 'Approval fixture content');
      await chunk(page, { content: 'Finished reviewing the requested file.' }, 1);
      await finishStream(page, 1);
    }
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
    expect(approvals).toHaveLength(decision === 'Approve once' ? 1 : 0);
    expect(reads).toHaveLength(decision === 'Approve once' ? 1 : 0);
    if (decision === 'Approve once') expect(approvals[0]).toMatchObject({ tool: 'read', path: 'approval-fixture.txt', workspace: '/test/workspace' });
  });
}
