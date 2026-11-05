import { expect, test, type Page } from '@playwright/test';
import { announcement, canvasOf, CAPTION_LIMIT, drawing, focusCanvas, modifier, openFixture, openSample, positions, screenOf, zoomOf, zoomPast } from './support/workspace.ts';

const tip = (page: Page) => page.locator('.canvas-tip');
const tipLines = (page: Page): Promise<string[]> => tip(page).locator('p').allTextContents();

test.describe('above the caption limit', () => {
  test('draws every entity caption and every relationship label, and tells nothing in a tip', async ({ page }) => {
    await openSample(page);
    expect(await zoomOf(page), 'the sample opens above the limit').toBeGreaterThan(CAPTION_LIMIT);
    const now = await drawing(page);
    expect(now.nodes.every((node) => node.captionShown && node.glyphShown), 'every caption and glyph is drawn').toBe(true);
    const labelled = now.edges.filter((edge) => edge.label !== '');
    expect(labelled.map((edge) => edge.label).sort(), 'the relationships that carry a label').toEqual(['SHARED_GADGET · derived', 'USES_GADGET · 42']);
    expect(labelled.every((edge) => edge.labelShown), 'every label is drawn').toBe(true);
    const at = await screenOf(page, 'holder');
    await page.mouse.move(at.x, at.y);
    await expect(tip(page)).toHaveCount(0);
  });
});

test.describe('below the caption limit', () => {
  /** The relationships that carry a label while the captions are read, by id: below the limit their drawn label is empty, so they are named before the zoom. */
  let labelledIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await openSample(page);
    labelledIds = (await drawing(page)).edges.filter((edge) => edge.label !== '').map((edge) => edge.id);
    expect(labelledIds, 'two relationships carry a label').toHaveLength(2);
    await zoomPast(page, 'below');
  });

  test('leaves out every entity caption and the two relationship labels, and keeps every glyph, every line and the pin badge', async ({ page }) => {
    expect(await zoomOf(page)).toBeLessThan(CAPTION_LIMIT);
    const now = await drawing(page);
    expect(now.nodes, 'every entity is still drawn').toHaveLength(10);
    expect(now.nodes.some((node) => node.captionShown), 'a caption is drawn').toBe(false);
    expect(now.nodes.every((node) => node.glyphShown), 'every glyph is drawn').toBe(true);
    expect(now.nodes.filter((node) => node.badgeShown), 'the pinned entity, and only it, keeps its badge').toHaveLength(1);
    expect(now.edges, 'every relationship is still drawn').toHaveLength(13);
    expect(now.edges.every((edge) => edge.width > 0), 'every line has a width').toBe(true);
    const labelled = now.edges.filter((edge) => labelledIds.includes(edge.id));
    expect(labelled, 'the same two relationships are still drawn').toHaveLength(2);
    expect(labelled.some((edge) => edge.labelShown), 'a label is drawn').toBe(false);
    expect(now.edges.some((edge) => edge.labelShown), 'a label of any relationship is drawn').toBe(false);
  });

  test('keeps the label of a walked relationship and of a selected one, and no other', async ({ page }) => {
    await focusCanvas(page);
    await page.keyboard.press('Enter');
    for (let step = 0; step < 40; step += 1) {
      await page.keyboard.press('Tab');
      if (((await announcement(page).textContent()) ?? '').startsWith('USES_GADGET · 42')) break;
    }
    const shownLabels = async (): Promise<string[]> => (await drawing(page)).edges.filter((edge) => edge.labelShown).map((edge) => edge.label);
    await expect.poll(shownLabels, { message: 'the walked relationship keeps its label' }).toEqual(['USES_GADGET · 42']);
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect.poll(shownLabels, { message: 'the selected relationship keeps its label' }).toEqual(['USES_GADGET · 42']);
    await page.keyboard.press('Escape');
    await expect.poll(shownLabels, { message: 'cleared, no label is drawn' }).toEqual([]);
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

  test('goes with a zoom, with a pan of the empty canvas, with the grab of an entity and with the pointer leaving, and comes back with the next entity entered', async ({ page }) => {
    const canvas = canvasOf(page);
    const view = (): Promise<string> => canvas.evaluate((element) => `${element.dataset['zoom']} ${element.dataset['panX']} ${element.dataset['panY']}`);
    const hover = async (id: string): Promise<void> => {
      const at = await screenOf(page, id);
      await page.mouse.move(at.x + 120, at.y + 120);
      await page.mouse.move(at.x, at.y);
    };
    await hover('holder');
    await expect(tip(page)).toHaveCount(1);
    const beforeZoom = await view();
    await page.mouse.wheel(0, 120);
    await expect(tip(page), 'a zoom').toHaveCount(0);
    await expect.poll(view).not.toBe(beforeZoom);
    await page.waitForTimeout(300);
    await hover('holder');
    await expect(tip(page), 'it comes back with the next entity the pointer enters').toHaveCount(1);
    const beforePan = await view();
    const empty = await canvas.boundingBox();
    const x = (empty?.x ?? 0) + (empty?.width ?? 0) - 60;
    const y = (empty?.y ?? 0) + 120;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 60, y + 40, { steps: 4 });
    await page.mouse.up();
    await expect(tip(page), 'a pan of the empty canvas').toHaveCount(0);
    await expect.poll(view, { message: 'the drag panned the view' }).not.toBe(beforePan);
    await page.waitForTimeout(300);
    await hover('holder');
    await expect(tip(page)).toHaveCount(1);
    const before = (await positions(page));
    const at = await screenOf(page, 'holder');
    await page.mouse.down();
    await page.mouse.move(at.x + 20, at.y + 20, { steps: 4 });
    await expect(tip(page), 'the grab of an entity').toHaveCount(0);
    await page.mouse.up();
    const after = await positions(page);
    expect(JSON.stringify(after), 'the entity was dragged').not.toBe(JSON.stringify(before));
    await hover('holder');
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
      const frames = { longest: 0, count: 0 };
      Reflect.set(window, 'frames', frames);
      let last = performance.now();
      const tick = (now: number): void => {
        frames.longest = Math.max(frames.longest, now - last);
        frames.count += 1;
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const reset = (): Promise<void> =>
      page.evaluate(() => {
        const frames: unknown = Reflect.get(window, 'frames');
        if (typeof frames !== 'object' || frames === null) throw new Error('NO_FRAME_LOG');
        Reflect.set(frames, 'longest', 0);
        Reflect.set(frames, 'count', 0);
      });
    const measured = (): Promise<{ longest: number; count: number }> =>
      page.evaluate(() => {
        const frames: unknown = Reflect.get(window, 'frames');
        if (typeof frames !== 'object' || frames === null) throw new Error('NO_FRAME_LOG');
        return { longest: Number(Reflect.get(frames, 'longest')), count: Number(Reflect.get(frames, 'count')) };
      });
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await zoomPast(page, 'above');
    await reset();
    await zoomPast(page, 'below');
    const byControls = await measured();
    expect(byControls.count, 'frames were recorded while crossing by the zoom controls').toBeGreaterThan(5);
    expect(byControls.longest, 'the longest frame crossing by the zoom controls').toBeLessThanOrEqual(100);
    const box = await canvasOf(page).boundingBox();
    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
    await reset();
    for (let step = 0; step < 12; step += 1) {
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(40);
    }
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(CAPTION_LIMIT);
    const byWheel = await measured();
    expect(byWheel.count, 'frames were recorded while crossing by the wheel').toBeGreaterThan(5);
    expect(byWheel.longest, 'the longest frame crossing by the wheel').toBeLessThanOrEqual(100);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });
});
