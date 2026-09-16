import { test, expect } from '@playwright/test';

test.describe('Engine Screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('nav').getByRole('button', { name: 'Engine', exact: true }).click();
  });

  test('displays Engine management tabs', async ({ page }) => {
    const tabs = ['Basics', 'Advanced', 'Profiles', 'Cloud', 'Usage', 'Performance'];

    for (const tabName of tabs) {
      const tabBtn = page.locator('button').filter({ hasText: new RegExp(`^${tabName}$`, 'i') }).first();
      await expect(tabBtn).toBeVisible();
      await tabBtn.click();
      await expect(tabBtn).toHaveClass(/text-accent/);
    }
  });
});
