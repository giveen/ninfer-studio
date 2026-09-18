import { test, expect } from '@playwright/test';

test.describe('Coder Harness Screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('nav').getByRole('button', { name: 'Code', exact: true }).click();
  });

  test('displays Coder mode UI components and composer input', async ({ page }) => {
    const activeScreen = page.locator('main > div:not(.hidden)');
    await expect(activeScreen).toBeVisible();

    const composer = activeScreen.locator('textarea[placeholder*="Instruct"], textarea[placeholder*="workspace"]').first();
    await expect(composer).toBeVisible();
  });

  test('renders sidebar or conversation controls', async ({ page }) => {
    const activeScreen = page.locator('main > div:not(.hidden)');
    await expect(activeScreen).toBeVisible();

    const sideButtons = activeScreen.locator('button').first();
    await expect(sideButtons).toBeVisible();
  });
});
