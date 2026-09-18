import { test, expect } from '@playwright/test';

test.describe('Settings Screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
  });

  test('navigates through settings tabs', async ({ page }) => {
    const tabs = ['Agent', 'Engine', 'Safety', 'About'];

    for (const tabName of tabs) {
      // Scoped to `main` (excludes the persistent sidebar rail, which has
      // its own same-named "Engine" icon button) and via getByRole, which
      // excludes same-named controls on other screens — every screen stays
      // mounted, just `hidden`-classed, per app.tsx, and getByRole correctly
      // drops anything under a hidden ancestor from the accessibility tree.
      // Not `exact` — the real "Safety" tab label is "Safety & Permissions".
      const tabBtn = page.locator('main').getByRole('tab', { name: tabName });
      await expect(tabBtn).toBeVisible();
      await tabBtn.click();
      await expect(tabBtn).toHaveClass(/text-accent/);
    }
  });
});
