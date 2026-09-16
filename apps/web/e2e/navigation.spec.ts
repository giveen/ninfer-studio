import { test, expect } from '@playwright/test';

test.describe('Navigation & Layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('loads NInfer Studio header and default Chat screen', async ({ page }) => {
    await expect(page.locator('header').first()).toContainText('NInfer Studio');
    const chatNav = page.locator('nav').getByRole('button', { name: 'Chat', exact: true });
    await expect(chatNav).toHaveAttribute('aria-current', 'true');
  });

  test('navigates through all sidebar screens', async ({ page }) => {
    const screens = ['Code', 'Engine', 'Log', 'Models', 'Settings', 'Chat'] as const;

    for (const screenName of screens) {
      const navBtn = page.locator('nav').getByRole('button', { name: screenName, exact: true });
      await navBtn.click();
      await expect(navBtn).toHaveAttribute('aria-current', 'true');
    }
  });

  test('toggles theme between dark and light mode', async ({ page }) => {
    const themeBtn = page.locator('nav').getByRole('button', { name: /Switch to (light|dark) theme/ });
    await expect(themeBtn).toBeVisible();

    const initialLabel = await themeBtn.getAttribute('aria-label');
    await themeBtn.click();

    const toggledLabel = await themeBtn.getAttribute('aria-label');
    expect(toggledLabel).not.toBe(initialLabel);
  });
});
