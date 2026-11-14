import { expect, test, type Page } from '@playwright/test';
import { askControl, openAsk, scriptAsk } from './support/ask-panel.ts';
import { boxOf } from './support/regions.ts';
import { canvasOf } from './support/workspace.ts';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const ask = (page: Page) => page.getByRole('complementary', { name: 'Ask' });

async function selectFirst(page: Page): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
}

test.describe('the details card beside the Ask panel', () => {
  test('opens to the left of the Ask panel and overlaps none of it, so the plan and the answer stay readable', async ({ page }) => {
    await scriptAsk(page);
    await openAsk(page);
    await selectFirst(page);
    await expect(inspector(page)).toBeVisible();
    await expect(ask(page)).toBeVisible();
    const details = await boxOf(inspector(page));
    const panel = await boxOf(ask(page));
    // no overlap in either direction: the details card ends before the Ask panel begins, and both are inside the window
    expect(details.x + details.width).toBeLessThanOrEqual(panel.x);
    const size = page.viewportSize();
    expect(size).not.toBeNull();
    if (size === null) return;
    expect(details.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(size.width);
    // the Ask panel keeps its question field and is not covered at any point
    const center = { x: panel.x + panel.width / 2, y: panel.y + 40 };
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[aria-label="Ask"]') !== null, center)).toBe(true);
  });

  test('moves back to the edge of the canvas when Ask is closed, and beside Ask again when it is opened', async ({ page }) => {
    await scriptAsk(page);
    await openAsk(page);
    await selectFirst(page);
    await expect(inspector(page)).toBeVisible();
    const beside = await boxOf(inspector(page));
    await askControl(page).click();
    await expect(ask(page)).toHaveCount(0);
    await expect(inspector(page)).toBeVisible();
    await expect.poll(async () => (await boxOf(inspector(page))).x).toBeGreaterThan(beside.x);
    await askControl(page).click();
    await expect(ask(page)).toBeVisible();
    await expect.poll(async () => (await boxOf(inspector(page))).x).toBeCloseTo(beside.x, 0);
  });
});
