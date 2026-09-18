import { test, expect } from '@playwright/test';

test('starts the selected engine artifact', async ({ page }) => {
  let startBody: unknown;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.fallback();
    let json: unknown = {};
    if (path === '/api/status') json = {
      engine: { state: 'stopped', port: 8080 }, config: { enginePort: 8080 },
      artifacts: [], engines: [], gpu: { available: false },
    };
    if (path === '/api/profile-state') json = { artifact: '/test/model.ninfer', saved: [] };
    if (path === '/api/engine/start') {
      startBody = route.request().postDataJSON();
      json = { ok: true };
    }
    if (path === '/api/engine/stop') json = { ok: true };
    if (path === '/api/logs') json = { lines: [], size: 0 };
    await route.fulfill({ json });
  });
  await page.route('**/v1/**', route => route.fulfill({ json: { data: [] } }));
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: 'Engine', exact: true }).click();
  await page.getByRole('button', { name: 'start engine', exact: true }).click();
  await expect.poll(() => startBody).toMatchObject({ artifact: '/test/model.ninfer' });
  await expect(page.getByText('engine starting — watch the log below; it takes a while to load weights.')).toBeVisible();
});
