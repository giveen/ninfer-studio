import { test, expect } from '@playwright/test';

test.describe('Settings Screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
  });

  test('navigates through settings tabs', async ({ page }) => {
    const tabs = ['Agent', 'Engine', 'Safety', 'About'];

    for (const tabName of tabs) {
      const tabBtn = page.locator('button').filter({ hasText: new RegExp(tabName, 'i') }).first();
      await expect(tabBtn).toBeVisible();
      await tabBtn.click();
      await expect(tabBtn).toHaveClass(/text-accent/);
    }
  });
});
