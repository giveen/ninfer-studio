import { test, expect } from '@playwright/test';

test.describe('Chat Screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('renders prompt textarea and accepts user input', async ({ page }) => {
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible();

    await textarea.fill('Hello LLM');
    await expect(textarea).toHaveValue('Hello LLM');
  });

  test('toggles sampling params drawer', async ({ page }) => {
    const paramsToggle = page.locator('button').filter({ hasText: /params|thinking/i }).first();
    await expect(paramsToggle).toBeVisible();
    await paramsToggle.click();
    const popover = page.locator('[data-radix-popper-content-wrapper], .bg-panel2, .border-line').first();
    await expect(popover).toBeVisible();
  });
});
