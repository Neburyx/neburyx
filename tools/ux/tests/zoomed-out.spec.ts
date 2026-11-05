import { expect, test, type Page } from '@playwright/test';
import { canvasOf, CAPTION_LIMIT, drawing, focusCanvas, modifier, openFixture, openSample, screenOf, zoomOf, zoomPast } from './support/workspace.ts';

const tip = (page: Page) => page.locator('.canvas-tip');
const tipLines = (page: Page): Promise<string[]> => tip(page).locator('p').allTextContents();

test.describe('above the caption limit', () => {
  test('draws every entity caption and every relationship label, and tells nothing in a tip', async ({ page }) => {
    await openSample(page);
    expect(await zoomOf(page), 'the sample opens above the limit').toBeGreaterThan(CAPTION_LIMIT);
    const now = await drawing(page);
    expect(now.nodes.every((node) => node.captionShown), 'every caption is drawn').toBe(true);
    expect(now.edges.filter((edge) => edge.label !== '').every((edge) => edge.labelShown), 'every label is drawn').toBe(true);
    const at = await screenOf(page, 'holder');
    await page.mouse.move(at.x, at.y);
    await expect(tip(page)).toHaveCount(0);
  });
});

test.describe('below the caption limit', () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page);
    await zoomPast(page, 'below');
  });

  test('leaves out every entity caption and relationship label, and keeps the glyphs, the lines and the pin badge', async ({ page }) => {
    expect(await zoomOf(page)).toBeLessThan(CAPTION_LIMIT);
    const now = await drawing(page);
    expect(now.nodes, 'every entity is still drawn').toHaveLength(10);
    expect(now.nodes.some((node) => node.captionShown), 'a caption is drawn').toBe(false);
    expect(now.nodes.every((node) => node.images.length >= 1), 'every entity keeps its glyph').toBe(true);
    const pinned = now.nodes.find((node) => node.images.length === 3);
    expect(pinned, 'the pinned entity keeps its badge').toBeDefined();
    expect(now.edges, 'every relationship is still drawn').toHaveLength(13);
    expect(now.edges.every((edge) => edge.width > 0), 'every line has a width').toBe(true);
    expect(now.edges.some((edge) => edge.labelShown), 'a label is drawn').toBe(false);
  });

  test('keeps the caption of a selected entity and of the walk\'s element, and draws each of several selected', async ({ page }) => {
    const mod = await modifier(page);
    await focusCanvas(page);
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await drawing(page)).nodes.filter((node) => node.captionShown).length, { message: 'the walk\'s element keeps its caption' }).toBe(1);
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    expect((await drawing(page)).nodes.filter((node) => node.captionShown), 'one selected entity keeps its caption').toHaveLength(1);
    await page.keyboard.press(`${mod}+a`);
    await expect.poll(async () => (await drawing(page)).nodes.filter((node) => node.captionShown).length, { message: 'several selected entities each draw theirs' }).toBe(10);
  });

  test('tells the entity under the pointer in a tip: its title and type line, in 12 and 11 px, inside the canvas', async ({ page }) => {
    const at = await screenOf(page, 'holder');
    await page.mouse.move(at.x, at.y);
    await expect(tip(page)).toHaveCount(1);
    expect(await tipLines(page)).toEqual(['Jordan Lee', 'Holder · Synthetic']);
    expect(await tip(page).locator('p').evaluateAll((lines) => lines.map((line) => getComputedStyle(line).fontSize))).toEqual(['12px', '11px']);
    const box = await tip(page).boundingBox();
    const canvas = await canvasOf(page).boundingBox();
    expect(box?.x ?? -1, 'the tip starts inside the canvas').toBeGreaterThanOrEqual(canvas?.x ?? 0);
    expect((box?.x ?? 0) + (box?.width ?? 0), 'the tip ends inside the canvas').toBeLessThanOrEqual((canvas?.x ?? 0) + (canvas?.width ?? 0));
    expect((box?.y ?? 0) + (box?.height ?? 0), 'the tip ends inside the canvas').toBeLessThanOrEqual((canvas?.y ?? 0) + (canvas?.height ?? 0));
  });

  test('tells a relationship that has a label by it, and tells nothing for one that has none', async ({ page }) => {
    const from = await screenOf(page, 'led-1');
    const to = await screenOf(page, 'gad-1');
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
    await expect(tip(page)).toHaveCount(1);
    expect(await tipLines(page)).toEqual(['USES_GADGET · 42']);
    const a = await screenOf(page, 'holder');
    const b = await screenOf(page, 'lin');
    await page.mouse.move(a.x + 400, a.y + 300);
    await expect(tip(page)).toHaveCount(0);
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2);
    await page.waitForTimeout(200);
    await expect(tip(page), 'a stored relationship has no label to tell').toHaveCount(0);
  });

  test('goes with a pan, a zoom and the pointer leaving the canvas', async ({ page }) => {
    const at = await screenOf(page, 'holder');
    await page.mouse.move(at.x, at.y);
    await expect(tip(page)).toHaveCount(1);
    await page.mouse.wheel(0, 120);
    await expect(tip(page), 'a zoom').toHaveCount(0);
    await page.waitForTimeout(300);
    const now = await screenOf(page, 'holder');
    await page.mouse.move(now.x + 150, now.y + 150);
    await page.mouse.move(now.x, now.y);
    await expect(tip(page), 'it comes back with the next entity the pointer enters').toHaveCount(1);
    await page.mouse.move(now.x + 2, now.y);
    await page.mouse.down();
    await page.mouse.move(now.x + 40, now.y + 40, { steps: 4 });
    await expect(tip(page), 'a pan or a grab').toHaveCount(0);
    await page.mouse.up();
    const later = await screenOf(page, 'holder');
    await page.mouse.move(later.x + 150, later.y + 150);
    await page.mouse.move(later.x, later.y);
    await expect(tip(page)).toHaveCount(1);
    await page.mouse.move(5, 5);
    await expect(tip(page), 'the pointer leaving the canvas').toHaveCount(0);
  });

  test('tells the element the keyboard walk is at', async ({ page }) => {
    await focusCanvas(page);
    await page.keyboard.press('Enter');
    await expect(tip(page)).toHaveCount(1);
    expect(await tipLines(page)).toEqual(['Jordan Lee', 'Holder · Synthetic']);
    await page.keyboard.press('Tab');
    await expect.poll(() => tipLines(page)).not.toEqual(['Jordan Lee', 'Holder · Synthetic']);
  });
});

test.describe('crossing the limit', () => {
  test('switches without a frame longer than 100 ms at 4x CPU, by the wheel and by the zoom controls', async ({ page }) => {
    await openFixture(page);
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => {
      const longest: number[] = [0];
      Reflect.set(window, 'longestFrame', longest);
      let last = performance.now();
      const tick = (now: number): void => {
        longest[0] = Math.max(longest[0] ?? 0, now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const reset = (): Promise<void> => page.evaluate(() => void Reflect.set(window, 'longestFrame', [0]));
    const longest = (): Promise<number> => page.evaluate(() => Number((Reflect.get(window, 'longestFrame') as number[])[0]));
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await zoomPast(page, 'above');
    await reset();
    await zoomPast(page, 'below');
    expect(await longest(), 'the longest frame crossing by the zoom controls').toBeLessThanOrEqual(100);
    const box = await canvasOf(page).boundingBox();
    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
    await reset();
    for (let step = 0; step < 12; step += 1) {
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(40);
    }
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(CAPTION_LIMIT);
    expect(await longest(), 'the longest frame crossing by the wheel').toBeLessThanOrEqual(100);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });
});
