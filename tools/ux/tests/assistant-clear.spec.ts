import { expect, test, type Page, type Route } from '@playwright/test';
import type { AssistantThreadResponse } from '@neburyx/contracts';
import { canvasOf } from './support/workspace.ts';

const STORED: AssistantThreadResponse = {
  turns: [{ id: '0192f000-0000-7000-8000-0000000000aa', seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'shared-devices', citedElements: 3, steps: 1 }],
  earlierTurns: 0,
  previousThreadClearedAt: null,
};
const NO_THREAD: AssistantThreadResponse = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };

const header = (page: Page) => page.getByRole('banner', { name: 'Investigation' });
const panel = (page: Page) => page.locator('.assistant-panel');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Clear this chat?' });

/** The synthetic API keeps the thread until the clear call is made, then answers the empty thread, as the application does. */
async function openWithThread(page: Page, clear: (page: Page, calls: string[]) => Promise<void>): Promise<string[]> {
  const calls: string[] = [];
  let cleared = false;
  await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: cleared ? NO_THREAD : STORED }));
  await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread\/clear$/.test(url.pathname), async (route) => {
    calls.push(route.request().postData() ?? '');
    if (route.request().method() !== 'POST') return route.fallback();
    cleared = true;
    return route.fulfill({ json: { cleared: true } });
  });
  await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } } }));
  await clear(page, calls);
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  await header(page).getByRole('button', { name: 'Assistant' }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.assistant-stored')).toBeVisible();
  return calls;
}

test.describe('Clear chat in the Assistant panel', () => {
  test('is reached by keyboard: Enter opens the confirmation with focus on Cancel and the page behind inert, Esc returns to the button, and confirming shows the empty thread', async ({ page }) => {
    const calls = await openWithThread(page, async () => undefined);
    const trash = panel(page).getByRole('button', { name: 'Clear chat' });
    await trash.focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(await page.locator('[inert] .assistant-panel').count()).toBe(1);
    await page.keyboard.press('Tab');
    await expect(dialog(page).getByRole('button', { name: 'Clear chat' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(trash).toBeFocused();
    expect(calls).toEqual([]);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeHidden();
    await expect(panel(page).getByText('Ask about this investigation')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Clear chat' })).toHaveCount(0);
    await expect(page.getByLabel('Your message')).toBeFocused();
    expect(calls).toEqual(['{}']);
  });

  test('draws the dialog 440 px wide, centred across the window and a third of the window from the top, 192 px high, over a scrim, as the frame does', async ({ page }) => {
    await openWithThread(page, async () => undefined);
    await panel(page).getByRole('button', { name: 'Clear chat' }).click();
    const size = page.viewportSize();
    const box = await dialog(page).boundingBox();
    expect(size).not.toBeNull();
    const [width, height] = [size?.width ?? 0, size?.height ?? 0];
    expect(Math.round(box?.width ?? 0)).toBe(440);
    expect(Math.round(box?.height ?? 0)).toBe(192);
    expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs((box?.y ?? 0) - height / 3)).toBeLessThanOrEqual(1);
    const scrim = await page.locator('.clear-chat-scrim').boundingBox();
    expect([Math.round(scrim?.width ?? 0), Math.round(scrim?.height ?? 0)]).toEqual([width, height]);
  });

  test('shows the name of each header icon button as a tip under it, on hover and on keyboard focus', async ({ page }) => {
    await openWithThread(page, async () => undefined);
    const tipOf = (name: string) => panel(page).getByRole('button', { name }).evaluate((element) => getComputedStyle(element, '::after').content);
    const trash = panel(page).getByRole('button', { name: 'Clear chat' });
    expect(await tipOf('Clear chat')).toBe('none');
    await trash.hover();
    expect(await tipOf('Clear chat')).toBe('"Clear chat"');
    await panel(page).getByRole('heading', { name: 'Assistant' }).hover();
    expect(await tipOf('Clear chat')).toBe('none');
    await page.keyboard.press('Tab');
    await panel(page).getByRole('button', { name: 'Close' }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(trash).toBeFocused();
    expect(await tipOf('Clear chat')).toBe('"Clear chat"');
    expect(await tipOf('Close')).toBe('none');
    await panel(page).getByRole('button', { name: 'Close' }).hover();
    expect(await tipOf('Close')).toBe('"Close"');
  });

  const failsOnce = (answer: (route: Route) => Promise<void>) => async (target: Page): Promise<void> => {
    let fail = true;
    await target.route((url) => /\/thread\/clear$/.test(url.pathname), async (route) => {
      if (!fail) return route.fallback();
      fail = false;
      return answer(route);
    });
  };

  test('says nothing was deleted when the server answers with an error, stays open, and clears when it is pressed again', async ({ page }) => {
    await openWithThread(page, failsOnce((route) => route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Quote the trace ID if you contact support.', retryable: false, traceId: 't' } } })));
    await panel(page).getByRole('button', { name: 'Clear chat' }).click();
    await dialog(page).getByRole('button', { name: 'Clear chat' }).click();
    await expect(dialog(page).getByText('The chat could not be cleared. Nothing was deleted. Try again.')).toBeVisible();
    await expect(panel(page).locator('.assistant-stored')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Clear chat' }).click();
    await expect(dialog(page)).toBeHidden();
  });

  test('says it could not be confirmed when the network fails, stays open, and clears when it is pressed again', async ({ page }) => {
    await openWithThread(page, failsOnce((route) => route.abort()));
    await panel(page).getByRole('button', { name: 'Clear chat' }).click();
    await dialog(page).getByRole('button', { name: 'Clear chat' }).click();
    await expect(dialog(page).getByText('Clearing the chat could not be confirmed. It may or may not have been cleared. Try again.')).toBeVisible();
    await expect(panel(page).locator('.assistant-stored')).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Clear chat' }).click();
    await expect(dialog(page)).toBeHidden();
  });

  test('takes the chat off the screen with the access-lost notice, and focuses the composer, when the clear is answered not found', async ({ page }) => {
    await openWithThread(page, failsOnce((route) => route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 't' } } })));
    await panel(page).getByLabel('Your message').fill('typed but not sent');
    await panel(page).getByRole('button', { name: 'Clear chat' }).click();
    await dialog(page).getByRole('button', { name: 'Clear chat' }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(panel(page).getByRole('alert')).toHaveText('You no longer have access to this investigation, so the thread was cleared.');
    await expect(panel(page).locator('.assistant-stored')).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Clear chat' })).toHaveCount(0);
    await expect(panel(page).getByLabel('Your message')).toHaveValue('');
    await expect(panel(page).getByLabel('Your message')).toBeFocused();
  });

  test('empties the other window of the browser: by the notice at once, and by a read of the server when the window is shown again if the notice is missed', async ({ context, page }) => {
    let cleared = false;
    await context.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: cleared ? { ...NO_THREAD, epoch: 1 } : { ...STORED, epoch: 0 } }));
    await context.route((url) => /\/thread\/clear$/.test(url.pathname), (route) => {
      cleared = true;
      return route.fulfill({ json: { cleared: true } });
    });
    await context.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } } }));
    const other = await context.newPage();
    const openOn = async (target: typeof page): Promise<void> => {
      await target.goto('/dev/open-entity');
      await target.getByRole('button', { name: 'banking-demo' }).click();
      const form = target.getByRole('form', { name: 'Open an entity' });
      await form.getByLabel('Stable ID').fill('AC-1');
      await form.getByRole('button', { name: 'Open' }).click();
      await expect(canvasOf(target)).toHaveAttribute('data-drawn-entities', '1');
      await header(target).getByRole('button', { name: 'Assistant' }).click();
      await expect(panel(target).locator('.assistant-stored')).toBeVisible();
    };
    await openOn(page);
    await openOn(other);
    await panel(page).getByRole('button', { name: 'Clear chat' }).click();
    await dialog(page).getByRole('button', { name: 'Clear chat' }).click();
    await expect(dialog(page)).toBeHidden();
    await other.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(panel(other).getByText('Ask about this investigation')).toBeVisible();
    await expect(panel(other).locator('.assistant-stored')).toHaveCount(0);
    await expect(panel(other).getByRole('button', { name: 'Clear chat' })).toHaveCount(0);
  });
});
