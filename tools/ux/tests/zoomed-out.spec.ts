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
    expect(now.edges.every((edge) => edge.width > 0 && edge.lineShown), 'every line is drawn: a width, and neither hidden nor transparent').toBe(true);
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
    // a drag starts only on the empty canvas (an entity under the pointer is grabbed or, pinned, not draggable), so the pointer has left the entity before the pan starts; that the pan itself takes the tip away with the pointer still on the entity is proved in cytoscape-renderer.test.ts ("goes with a pan, a zoom, a grab")
    await page.mouse.move(5, 5);
    const empty = await canvas.boundingBox();
    const emptyX = (empty?.x ?? 0) + (empty?.width ?? 0) - 60;
    const emptyY = (empty?.y ?? 0) + 120;
    const beforeEmpty = await view();
    await page.mouse.move(emptyX, emptyY);
    await page.mouse.down();
    await page.mouse.move(emptyX - 60, emptyY + 40, { steps: 4 });
    await expect.poll(view, { message: 'a drag of the empty canvas pans the view' }).not.toBe(beforeEmpty);
    await expect(tip(page), 'a pan of the empty canvas').toHaveCount(0);
    await page.mouse.up();
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

/**
 * The longest frame allowed while the drawing crosses the caption limit at 4x CPU. Outside CI it is 100 ms, the product figure on the recorded laptop, where a crossing
 * takes about 50 ms here. In CI it is 300 ms, chosen from five runs of the ux job on the GitHub runner (2 vCPU), 20 measurements of the longest frame, which land on
 * steps of 16.7 ms:
 *   1440 by the zoom controls  150, 133.4, 116.7, 183.3, 133.3
 *   1440 by the wheel          150.1, 183.3, 116.6, 166.7, 150
 *   1280 by the zoom controls  100, 116.6, 83.4, 133.4, 133.3
 *   1280 by the wheel          116.7, 116.8, 100, 166.6, 150.1
 * so the runner is 2 to 4 times slower than the laptop, and its worst frame was 183.3 ms. 300 ms is 18 frames: 1.6 times the worst of the 20, and the next step after
 * 283 ms. It stays clear of the noise seen, and it fails a crossing that takes about twice as long as the slowest crossing seen, or a laptop crossing of about 150 ms
 * (three times the 50 ms here), as `pnpm --filter @neburyx/ux-tests mutate crossing` shows with a 400 ms stall. It does not catch a crossing that gets slower by less than about 100 ms on the
 * runner; the laptop run with the 100 ms limit is the finer check, and the one that holds the product figure.
 */
const PRODUCT_LIMIT_MS = 100;
const RUNNER_LIMIT_MS = 300;
const LIMIT_MS = process.env['CI'] === undefined ? PRODUCT_LIMIT_MS : RUNNER_LIMIT_MS;

interface Phase {
  readonly longest: number;
  readonly count: number;
  /** The five longest frames, each with its length and when it began, in ms from the start of the phase. */
  readonly slowest: ReadonlyArray<{ readonly at: number; readonly ms: number }>;
  /** What the browser reports about the long animation frames of the phase: where the time went (script, style and layout, the rest). */
  readonly long: ReadonlyArray<{ readonly at: number; readonly ms: number; readonly scriptMs: number; readonly styleLayoutMs: number; readonly renderMs: number; readonly blockingMs: number }>;
}

test.describe('crossing the limit', () => {
  test(`switches without a frame longer than ${PRODUCT_LIMIT_MS} ms at 4x CPU on the laptop, and than the runner's limit in CI, by the wheel and by the zoom controls`, async ({ page }, testInfo) => {
    await openFixture(page);
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => {
      const log = { frames: [] as Array<{ at: number; ms: number }>, long: [] as Array<Record<string, number>>, start: performance.now() };
      Reflect.set(window, 'crossingFrames', log);
      let last = performance.now();
      const tick = (now: number): void => {
        log.frames.push({ at: last, ms: now - last });
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const frame = entry as PerformanceEntry & { renderStart?: number; styleAndLayoutStart?: number; blockingDuration?: number; scripts?: Array<{ duration: number }> };
            const end = frame.startTime + frame.duration;
            log.long.push({
              at: frame.startTime,
              ms: frame.duration,
              scriptMs: (frame.scripts ?? []).reduce((total, script) => total + script.duration, 0),
              styleLayoutMs: frame.styleAndLayoutStart === undefined || frame.styleAndLayoutStart === 0 ? 0 : end - frame.styleAndLayoutStart,
              renderMs: frame.renderStart === undefined || frame.renderStart === 0 ? 0 : end - frame.renderStart,
              blockingMs: frame.blockingDuration ?? 0,
            });
          }
        }).observe({ type: 'long-animation-frame', buffered: true });
      } catch {
        // a browser without long animation frames still gives the frame lengths
      }
    });
    const reset = (): Promise<void> =>
      page.evaluate(() => {
        const log = Reflect.get(window, 'crossingFrames') as { frames: unknown[]; long: unknown[]; start: number };
        log.frames.length = 0;
        log.long.length = 0;
        log.start = performance.now();
      });
    const measured = (): Promise<Phase> =>
      page.evaluate(() => {
        const log = Reflect.get(window, 'crossingFrames') as { frames: Array<{ at: number; ms: number }>; long: Array<Record<string, number>>; start: number };
        const rounded = (value: number): number => Math.round(value * 10) / 10;
        const slowest = [...log.frames].sort((first, second) => second.ms - first.ms).slice(0, 5).map((frame) => ({ at: rounded(frame.at - log.start), ms: rounded(frame.ms) }));
        const long = log.long.map((entry) => ({ at: rounded((entry['at'] ?? 0) - log.start), ms: rounded(entry['ms'] ?? 0), scriptMs: rounded(entry['scriptMs'] ?? 0), styleLayoutMs: rounded(entry['styleLayoutMs'] ?? 0), renderMs: rounded(entry['renderMs'] ?? 0), blockingMs: rounded(entry['blockingMs'] ?? 0) }));
        return { longest: slowest[0]?.ms ?? 0, count: log.frames.length, slowest, long };
      });
    await page.getByRole('button', { name: 'Fit to view' }).click();
    await zoomPast(page, 'above');
    await reset();
    await zoomPast(page, 'below');
    const byControls = await measured();
    const box = await canvasOf(page).boundingBox();
    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2);
    await reset();
    for (let step = 0; step < 12; step += 1) {
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(40);
    }
    await expect.poll(() => zoomOf(page)).toBeGreaterThan(CAPTION_LIMIT);
    const byWheel = await measured();
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    // what a run measured, in the log of the job and attached, for choosing the runner's limit
    const figures = { limitMs: LIMIT_MS, project: testInfo.project.name, byControls, byWheel };
    process.stdout.write(`crossing ${JSON.stringify(figures)}\n`);
    await testInfo.attach('crossing.json', { body: JSON.stringify(figures, null, 2), contentType: 'application/json' });
    expect(byControls.count, 'frames were recorded while crossing by the zoom controls').toBeGreaterThan(5);
    expect(byWheel.count, 'frames were recorded while crossing by the wheel').toBeGreaterThan(5);
    expect(byControls.longest, `the longest frame crossing by the zoom controls: ${JSON.stringify(byControls)}`).toBeLessThanOrEqual(LIMIT_MS);
    expect(byWheel.longest, `the longest frame crossing by the wheel: ${JSON.stringify(byWheel)}`).toBeLessThanOrEqual(LIMIT_MS);
  });
});
