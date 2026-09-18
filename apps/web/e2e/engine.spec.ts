import { test, expect } from '@playwright/test';

test.describe('Engine Screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('nav').getByRole('button', { name: 'Engine', exact: true }).click();
  });

  test('displays Engine management tabs', async ({ page }) => {
    const tabs = ['Basics', 'Advanced', 'Profiles', 'Cloud', 'Usage', 'Performance'];

    for (const tabName of tabs) {
      // Scoped to `main` (excludes the persistent sidebar rail) and via
      // getByRole (excludes same-named controls on other screens — every
      // screen stays mounted, just `hidden`-classed, per app.tsx, and
      // getByRole correctly drops anything under a hidden ancestor from the
      // accessibility tree — a plain `button` + hasText locator would not).
      const tabBtn = page.locator('main').getByRole('tab', { name: tabName, exact: true });
      await expect(tabBtn).toBeVisible();
      await tabBtn.click();
      await expect(tabBtn).toHaveClass(/text-accent/);
    }
  });
});
