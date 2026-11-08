import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasOf, drawing, menuOf, openSample, zoomOf } from './support/workspace.ts';

const lines = (page: Page) => page.locator('.graph-scope p');
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Selection actions' });

async function select(page: Page, count = 1): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  for (let more = 1; more < count; more += 1) {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Space');
  }
}

async function box(locator: Locator): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('not on the page');
  return { left: found.x, top: found.y, right: found.x + found.width, bottom: found.y + found.height };
}

const crosses = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test.describe('focus neighborhood', () => {
  let requests: string[] = [];

  test.beforeEach(async ({ page }) => {
    requests = [];
    await openSample(page);
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/v1/')) requests.push(`${request.method()} ${pathname}`);
    });
  });

  test('puts focus on the selected entity with F, counts what is outside, and leaves it from the scope line', async ({ page }) => {
    const before = (await drawing(page)).nodes.length;
    for (let step = 0; step < 3; step += 1) await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(page.getByText('51%', { exact: true })).toBeVisible();
    const zoomBefore = await zoomOf(page);
    await select(page);
    await page.keyboard.press('f');
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(zoomBefore);
    await expect(lines(page).first()).toContainText('outside focus');
    await expect(page.getByRole('button', { name: 'Leave focus' })).toBeVisible();
    const during = (await drawing(page)).nodes.length;
    expect(during).toBeLessThan(before);
    await expect(lines(page).nth(1)).toContainText(`${during} shown`);
    await expect(lines(page).first()).toContainText('10 entities');
    await page.getByRole('button', { name: 'Leave focus' }).click();
    await expect(lines(page).first()).not.toContainText('outside focus');
    await expect(lines(page).nth(1)).toContainText('10 shown');
    await expect(canvasOf(page)).toBeFocused();
    expect((await drawing(page)).nodes.length).toBe(before);
    expect(await zoomOf(page)).toBeCloseTo(zoomBefore, 5);
    expect(requests).toEqual([]);
  });

  test('works from the node menu, leaves from the canvas menu, and leaves with F', async ({ page }) => {
    await select(page);
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Focus neighborhood' }).click();
    await expect(lines(page).first()).toContainText('outside focus');
    await page.keyboard.press('Escape');
    await canvasOf(page).focus();
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Leave focus' }).click();
    await expect(lines(page).first()).not.toContainText('outside focus');
    await select(page);
    await page.keyboard.press('f');
    await expect(lines(page).first()).toContainText('outside focus');
    await page.keyboard.press('Escape');
    await page.keyboard.press('f');
    await expect(lines(page).first()).not.toContainText('outside focus');
    expect(requests).toEqual([]);
  });
});

test.describe('the selection bar and the scope lines', () => {
  for (const width of [1400, 1000, 640]) {
    test(`stay clear of each other, of the tool strip and of an open panel at ${width} px, with every action inside the canvas`, async ({ page }) => {
      await page.setViewportSize({ width, height: 620 });
      await openSample(page);
      await select(page, 7);
      // at 640 px the Legend alone covers nearly the whole canvas, so no place is clear of it
      if (width > 640) {
        await page.keyboard.press('l');
        await expect(page.locator('.floating-panel').first()).toBeVisible();
      }
      await expect(bar(page)).toBeVisible();
      const barBox = await box(bar(page));
      const others = ['.graph-scope', '.region-tool-strip', ...((await page.locator('.floating-panel').count()) > 0 ? ['.floating-panel'] : [])];
      for (const other of others) for (const element of await page.locator(other).all()) expect(crosses(barBox, await box(element)), `the bar covers ${other}`).toBe(false);
      const canvasBox = await box(page.locator('.canvas-region'));
      for (const button of await bar(page).getByRole('button').all()) {
        const at = await box(button);
        expect(at.left).toBeGreaterThanOrEqual(canvasBox.left);
        expect(at.right).toBeLessThanOrEqual(canvasBox.right);
        expect(at.top).toBeGreaterThanOrEqual(canvasBox.top);
        expect(at.bottom).toBeLessThanOrEqual(canvasBox.bottom);
      }
    });
  }

  test('let a click through the scope lines reach the canvas', async ({ page }) => {
    await openSample(page);
    await select(page, 7);
    await expect(bar(page)).toBeVisible();
    const scope = await box(page.locator('.graph-scope'));
    const at = { x: (scope.left + scope.right) / 2, y: (scope.top + scope.bottom) / 2 };
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.graph-scope') === null, at)).toBe(true);
    await page.mouse.click(at.x, at.y);
    await expect(bar(page)).toHaveCount(0);
  });
});
