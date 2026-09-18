import { test, expect } from '@playwright/test';
import { mockControl, installChatStream, streamCount, chunk, finishStream } from './helpers/scripted-api';

test.beforeEach(async ({ page }) => {
  await mockControl(page);
  await installChatStream(page);
  await page.goto('/');
});

async function send(page: import('@playwright/test').Page, text: string) {
  await page.locator('textarea').first().fill(text);
  await page.getByRole('button', { name: 'send', exact: true }).click();
}

test('renders incremental text before successfully finishing a prompt', async ({ page }) => {
  await send(page, 'Tell me a short story');
  await streamCount(page, 1);
  // Use realistic chunks: the parser buffers a suffix to recognize split think tags.
  await chunk(page, { content: 'Once upon a time, a traveler' });
  await expect(page.getByText('Once upon a time', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'stop', exact: true })).toBeVisible();
  await chunk(page, { content: ' discovered a hidden garden.' });
  await expect(page.getByText('a traveler discovered', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'stop', exact: true })).toBeVisible();
  await finishStream(page);
  await expect(page.getByText('Once upon a time, a traveler discovered a hidden garden.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'stop', exact: true })).toBeHidden();
  await page.locator('textarea').first().fill('Another story');
  await expect(page.getByRole('button', { name: 'send', exact: true })).toBeEnabled();
});

test('stop cancels a mid-response stream and leaves the composer usable', async ({ page }) => {
  await send(page, 'Keep talking');
  await streamCount(page, 1);
  await chunk(page, { content: 'Partial answer that is still arriving' });
  await expect(page.getByText('Partial answer', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'stop', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).testStreams[0].aborted)).toBe(true);
  await expect(page.getByRole('button', { name: 'stop', exact: true })).toBeHidden();
  await send(page, 'Try again');
  await streamCount(page, 2);
  await chunk(page, { content: 'Fresh answer' }, 1);
  await finishStream(page, 1);
  await expect(page.getByText('Fresh answer', { exact: true })).toBeVisible();
});

test('connection failure shows an error and permits a successful retry', async ({ page }) => {
  await send(page, 'First attempt');
  await streamCount(page, 1);
  await page.evaluate(() => (window as any).testStreams[0].controller.error(new TypeError('Test connection lost')));
  await expect(page.getByText(/Test connection lost/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'stop', exact: true })).toBeHidden();
  await send(page, 'Retry request');
  await streamCount(page, 2);
  await chunk(page, { content: 'Recovered successfully' }, 1);
  await finishStream(page, 1);
  await expect(page.getByText('Recovered successfully', { exact: true })).toBeVisible();
});

test('switching conversations keeps streamed output in its owner and saves history', async ({ page }) => {
  await send(page, 'Original conversation');
  await streamCount(page, 1);
  await chunk(page, { content: 'Original response began here and' });
  await expect(page.getByText('Original response', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'new chat', exact: true }).click();
  await expect(page.getByText('Original response', { exact: false })).toBeHidden();
  await chunk(page, { content: ' finished.' });
  await finishStream(page);
  await expect(page.getByText('Original response began here and finished.', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: /^Original conversation/ }).click();
  await expect(page.getByText('Original response began here and finished.', { exact: true })).toBeVisible();
  // Wait for the real debounced history save, not a fixed timeout.
  await expect.poll(async () => {
    const response = await page.evaluate(() => fetch('/api/conversations').then(r => r.json()));
    return JSON.stringify(response);
  }).toContain('Original response began here and finished.');
  await page.reload();
  await page.getByRole('button', { name: /^Original conversation/ }).click();
  await expect(page.getByText('Original response began here and finished.', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Original response began here and finished.', { exact: true })).toBeVisible();
});
