import { test, expect } from '@playwright/test';
import { mockControl } from './helpers/scripted-api';

for (const failFirst of [false, true]) {
  test(failFirst ? 'failed engine startup shows error and permits retry' : 'engine progresses through loading, running and stopped', async ({ page }) => {
    const state = await mockControl(page);
    state.engine.state = 'stopped';
    let starts = 0;
    let stops = 0;
    await page.route('**/api/engine/start', async route => {
      expect(route.request().postDataJSON()).toMatchObject({ artifact: '/test/model.ninfer' });
      starts++;
      if (failFirst && starts === 1) {
        state.engine.state = 'failed';
        await route.fulfill({ status: 500, json: { message: 'Test weights could not load' } });
      } else {
        state.engine.state = 'starting';
        await route.fulfill({ json: { ok: true } });
      }
    });
    await page.route('**/api/engine/stop', async route => {
      stops++;
      state.engine.state = 'stopped';
      await route.fulfill({ json: { ok: true, message: 'Engine stopped' } });
    });
    await page.goto('/');
    await page.getByRole('navigation').getByRole('button', { name: 'Engine', exact: true }).click();
    const screen = page.locator('main > div:not(.hidden)');
    const start = screen.getByRole('button', { name: 'start engine', exact: true });
    await expect(screen.getByText('stopped', { exact: true })).toBeVisible();
    await start.click();
    if (failFirst) {
      await expect(screen.getByText(/Test weights could not load/)).toBeVisible();
      await expect(start).toBeEnabled();
      await start.click();
    }
    await expect(screen.getByText('starting', { exact: true })).toBeVisible();
    await expect(screen.getByRole('button', { name: 'working…', exact: true })).toBeDisabled();
    state.engine.state = 'running';
    await expect(screen.getByText('running', { exact: true })).toBeVisible();
    await screen.getByRole('button', { name: 'stop', exact: true }).click();
    await expect(screen.getByText('stopped', { exact: true })).toBeVisible();
    await expect(start).toBeEnabled();
    expect(starts).toBe(failFirst ? 2 : 1);
    expect(stops).toBe(starts + 1); // Start first stops any previously adopted process.
  });
}
