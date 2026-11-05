import { expect, test, type Page } from '@playwright/test';
import { boxOf } from './support/regions.ts';

test.skip(({ viewport }) => viewport?.width !== 1280, 'the floating panel is checked at 1280 wide, with its own heights');

const HEADER = 48;
const EDGE = 16;
const OFFSET = 64;
const BAR = 40;

async function gaps(page: Page): Promise<{ readonly top: number; readonly bottom: number; readonly height: number }> {
  const panel = await boxOf(page.locator('aside.floating-panel'));
  const canvas = await boxOf(page.locator('.canvas-region'));
  return { top: panel.y - canvas.y, bottom: canvas.y + canvas.height - (panel.y + panel.height), height: panel.height };
}

test.describe('with room', () => {
  test('a floating panel keeps its normal top offset and its own height', async ({ page }) => {
    await page.goto('/dev/frame-sample?floating&dock=none');
    await expect(page.locator('aside.floating-panel')).toBeVisible();
    const { top, height } = await gaps(page);
    expect(top, 'the top offset').toBe(OFFSET);
    expect(height, 'the panel is taller than the collapsed bar').toBeGreaterThan(BAR);
  });
});

test.describe('in a canvas too short for it', () => {
  // The offset yields below a canvas of 64 + 40 + 16 = 120 px; 148 px under the 48 px header gives a 100 px canvas.
  test.use({ viewport: { width: 1280, height: HEADER + 100 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/dev/frame-sample?floating&dock=none');
    await expect(page.locator('aside.floating-panel')).toBeVisible();
  });

  test('puts the 40 px bar exactly 16 px above the canvas bottom, collapsed', async ({ page }) => {
    await page.getByRole('button', { name: /Collapse Floating test panel/ }).click();
    await expect(page.getByRole('button', { name: /Expand Floating test panel/ })).toBeVisible();
    const { top, bottom, height } = await gaps(page);
    expect(height, 'the bar is 40 px high').toBe(BAR);
    expect(bottom, 'the bar is 16 px above the canvas bottom').toBe(EDGE);
    expect(top, 'the offset has yielded').toBeLessThan(OFFSET);
    expect(top, 'the bar lies inside the canvas').toBeGreaterThanOrEqual(0);
  });

  test('keeps the expanded panel inside the canvas and scrolls its content inside it', async ({ page }) => {
    const { top, bottom, height } = await gaps(page);
    expect(top, 'the panel starts inside the canvas').toBeGreaterThanOrEqual(0);
    expect(bottom, 'the panel stays 16 px above the canvas bottom').toBe(EDGE);
    expect(height, 'the panel is no taller than the room').toBeLessThanOrEqual(100 - EDGE);
    const content = page.locator('aside.floating-panel .panel-content');
    expect(await content.evaluate((element) => element.scrollHeight > element.clientHeight), 'the content scrolls').toBe(true);
    expect(await content.evaluate((element) => getComputedStyle(element).overflowY), 'the content is allowed to scroll').toMatch(/auto|scroll/);
    await content.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    expect(await content.evaluate((element) => element.scrollTop), 'the content moved').toBeGreaterThan(0);
  });
});
