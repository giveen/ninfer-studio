import { test, expect, type Page } from '@playwright/test';
import { mockControl } from './helpers/scripted-api';

async function openSettings(page: Page) {
  await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Engine', exact: true }).click();
}

for (const failFirst of [false, true]) {
  test(failFirst ? 'failed settings save retains draft and can be retried' : 'saved settings survive navigation and reload', async ({ page }) => {
    const state = await mockControl(page);
    let saves = 0;
    await page.route('**/api/config', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      saves++;
      if (failFirst && saves === 1) {
        await route.fulfill({ status: 500, json: { message: 'Could not persist settings' } });
      } else {
        await route.fallback();
      }
    });
    await page.goto('/');
    await openSettings(page);
    const field = page.getByPlaceholder('npm test', { exact: true });
    await field.fill('pnpm test:e2e');
    const save = page.getByRole('button', { name: 'save settings', exact: true });
    await save.click();
    if (failFirst) {
      await expect(page.getByText(/Could not persist settings/)).toBeVisible();
      await expect(field).toHaveValue('pnpm test:e2e');
      expect(state.config).not.toHaveProperty('testCommand', 'pnpm test:e2e');
      await save.click();
    }
    await expect.poll(() => state.config).toHaveProperty('testCommand', 'pnpm test:e2e');
    await expect(page.getByText(/Could not persist settings/)).toBeHidden();
    await page.getByRole('navigation').getByRole('button', { name: 'Chat', exact: true }).click();
    await openSettings(page);
    await expect(field).toHaveValue('pnpm test:e2e');
    await page.reload();
    await openSettings(page);
    await expect(field).toHaveValue('pnpm test:e2e');
    expect(saves).toBe(failFirst ? 2 : 1);
  });
}
