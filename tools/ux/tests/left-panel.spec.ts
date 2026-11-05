import { expect, test, type Locator, type Page } from '@playwright/test';
import { boxOf } from './support/regions.ts';

test.skip(({ viewport }) => viewport?.width !== 1280, 'the left-anchored panel is checked at 1280 × 720');

const MIN = 240;
const MAX = 480;
const STEP = 16;

async function open(page: Page): Promise<{ readonly handle: Locator; readonly panel: Locator }> {
  await page.goto('/dev/frame-sample?floating=left&dock=none');
  const panel = page.locator('aside.floating-panel');
  await expect(panel).toBeVisible();
  return { handle: page.getByRole('separator', { name: 'Resize Floating test panel' }), panel };
}

const width = async (panel: Locator): Promise<number> => (await boxOf(panel)).width;
const valueOf = async (handle: Locator): Promise<number> => Number(await handle.getAttribute('aria-valuenow'));

async function drag(page: Page, handle: Locator, by: number): Promise<void> {
  const box = await boxOf(handle);
  const x = box.x + box.width / 2;
  // the collapse control sits over the middle of the handle, so the drag takes hold near its top
  const y = box.y + 8;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + by / 2, y, { steps: 4 });
  await page.mouse.move(x + by, y, { steps: 4 });
  await page.mouse.up();
}

test('keeps its width when a key is pressed with the focus elsewhere, and its width never leaves the limits', async ({ page }) => {
  const { handle, panel } = await open(page);
  const before = await width(panel);
  await page.locator('body').click({ position: { x: 700, y: 400 } });
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) await page.keyboard.press(key);
  expect(await width(panel), 'the panel moved without the handle focused').toBe(before);
  await drag(page, handle, 900);
  await expect.poll(() => width(panel), { message: 'a drag far to the right stops at the maximum' }).toBe(MAX);
  await drag(page, handle, -1000);
  await expect.poll(() => width(panel), { message: 'a drag far to the left stops at the minimum' }).toBe(MIN);
});

test('has its handle on its right edge, widens with a drag to the right and narrows with a drag to the left', async ({ page }) => {
  const { handle, panel } = await open(page);
  const edge = await boxOf(panel);
  const grip = await boxOf(handle);
  expect(Math.abs(grip.x + grip.width / 2 - (edge.x + edge.width)), 'the handle is centred on the panel\'s right edge').toBeLessThanOrEqual(4);
  const start = await width(panel);
  await drag(page, handle, 40);
  await expect.poll(() => width(panel), { message: 'a drag of 40 px to the right' }).toBe(start + 40);
  expect(await valueOf(handle), 'the handle reports the width').toBe(start + 40);
  await drag(page, handle, -60);
  await expect.poll(() => width(panel), { message: 'a drag of 60 px to the left' }).toBe(start - 20);
  expect((await boxOf(panel)).x, 'the panel keeps its left edge').toBe(edge.x);
});

test('widens with ArrowRight, narrows with ArrowLeft, and goes to the minimum with Home and the maximum with End', async ({ page }) => {
  const { handle, panel } = await open(page);
  const start = await width(panel);
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  expect(await width(panel)).toBe(start + STEP);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect(await width(panel)).toBe(start - STEP);
  await page.keyboard.press('End');
  expect(await width(panel)).toBe(MAX);
  expect(await valueOf(handle)).toBe(MAX);
  await page.keyboard.press('Home');
  expect(await width(panel)).toBe(MIN);
  expect(await valueOf(handle)).toBe(MIN);
});
