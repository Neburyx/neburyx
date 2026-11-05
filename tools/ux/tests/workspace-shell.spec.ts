import { expect, test, type Page } from '@playwright/test';
import { boxOf, expectBox, expectContained, expectEachContained, expectInsideViewport, expectNoScroll, styleOf } from './support/regions.ts';

const RAIL = 56;
const HEADER = 48;
const DOCK = 352;
const EDGE = 16;

function size(page: Page): { readonly width: number; readonly height: number } {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('NO_VIEWPORT');
  return viewport;
}

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`/dev/frame-sample${query}`);
  await expect(page.getByRole('application', { name: 'Graph canvas' })).toHaveAttribute('data-drawn-entities', '10');
}

test.describe('the workspace shell without a dock panel', () => {
  test.beforeEach(async ({ page }) => open(page, '?dock=none'));

  test('has the rail, header and canvas region of the frame, the full width of the viewport', async ({ page }) => {
    const { width, height } = size(page);
    await expectBox('rail', page.locator('.rail'), { x: 0, y: 0, width: RAIL, height });
    await expectBox('header', page.locator('.header-bar'), { x: RAIL, y: 0, width: width - RAIL, height: HEADER });
    await expectBox('canvas region', page.locator('.canvas-region'), { x: RAIL, y: HEADER, width: width - RAIL, height: height - HEADER });
    await expectNoScroll('the rail', page.locator('.rail'));
    await expectInsideViewport(page, { rail: page.locator('.rail'), header: page.locator('.header-bar'), 'canvas region': page.locator('.canvas-region') }, { bottom: true });
    await expectEachContained('a rail destination', page.locator('.rail a, .rail button'), page.locator('.rail'));
    await expectEachContained('a header control', page.locator('.header-bar button, .header-bar a'), page.locator('.header-bar'));
    for (const name of ['Ask, locked', 'Summarize, locked', 'Views ▾', 'Export', 'Save']) await expectContained(name, page.getByRole('button', { name }), page.locator('.header-bar'));
  });

  test('places the scope lines, the tool strip and the toggles by the frame, from the canvas region', async ({ page }) => {
    const { height } = size(page);
    await expectBox('first scope line', page.locator('.graph-scope > *').nth(0), { x: RAIL + 24, y: HEADER + 16 });
    await expectBox('second scope line', page.locator('.graph-scope > *').nth(1), { x: RAIL + 24, y: HEADER + 36 });
    await expectEachContained('a scope line', page.locator('.graph-scope > *'), page.locator('.canvas-region'));
    await expectEachContained('a tool of the strip', page.locator('.region-tool-strip button'), page.locator('.region-tool-strip'));
    await expectContained('the tool strip', page.locator('.region-tool-strip'), page.locator('.canvas-region'));
    await expectContained('the toggles', page.locator('.region-toggles'), page.locator('.canvas-region'));
    await expectBox('tool strip', page.locator('.region-tool-strip'), { x: RAIL + EDGE, y: HEADER + 64, width: 40, height: 268 });
    const toggles = page.locator('.region-toggles > *');
    await expectBox('table toggle', toggles.first(), { x: RAIL + EDGE, y: height - EDGE - 36, width: 86, height: 36 });
    await expectBox('legend bar', toggles.nth(1), { x: RAIL + 118, y: height - EDGE - 36, width: 186, height: 36 });
  });

  test('keeps the zoom controls and the Save control 16 px inside the right edge', async ({ page }) => {
    const { width, height } = size(page);
    const zoom = await boxOf(page.locator('.zoom-controls'));
    expect(zoom.x + zoom.width, 'zoom controls: right edge').toBeCloseTo(width - EDGE, 0);
    expect(zoom.y + zoom.height, 'zoom controls: bottom edge').toBeCloseTo(height - EDGE, 0);
    await expectBox('Save', page.locator('.header-bar').getByRole('button', { name: 'Save' }), { y: 8, height: 32 });
    const save = await boxOf(page.locator('.header-bar').getByRole('button', { name: 'Save' }));
    expect(save.x + save.width, 'Save: right edge').toBeCloseTo(width - EDGE, 0);
  });

  test('cuts a long investigation title with an ellipsis and keeps every header control inside the viewport', async ({ page }) => {
    await open(page, `?dock=none&title=${encodeURIComponent('A very long investigation title that cannot fit in the header bar '.repeat(4))}`);
    const title = page.locator('.header-title');
    expect(await styleOf(title, ['text-overflow', 'white-space', 'overflow-x']), 'the title is cut by an ellipsis on one line').toEqual({ 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'overflow-x': 'hidden' });
    expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth), 'the title is wider than its room').toBe(true);
    await expectContained('the title', title, page.locator('.header-bar'));
    const { width } = size(page);
    const header = await boxOf(page.locator('.header-bar'));
    for (const name of ['Save', 'Export']) {
      const box = await boxOf(page.locator('.header-bar').getByRole('button', { name }));
      expect(box.x + box.width, `${name} inside the header`).toBeLessThanOrEqual(header.x + header.width);
      expect(box.x + box.width, `${name} inside the viewport`).toBeLessThanOrEqual(width);
    }
    await expectInsideViewport(page, { header: page.locator('.header-bar') }, { bottom: true });
  });
});

test.describe('the workspace shell with the dock panel open', () => {
  test.beforeEach(async ({ page }) => open(page, ''));

  test('narrows the canvas by the dock and keeps the zoom controls left of it', async ({ page }) => {
    const { width, height } = size(page);
    await expectBox('dock', page.locator('.panel-dock'), { x: width - DOCK, y: HEADER, width: DOCK, height: height - HEADER });
    await expectBox('canvas region', page.locator('.canvas-region'), { x: RAIL, y: HEADER, width: width - RAIL - DOCK, height: height - HEADER });
    const zoom = await boxOf(page.locator('.zoom-controls'));
    expect(zoom.x + zoom.width, 'zoom controls: right edge, left of the dock').toBeCloseTo(width - DOCK - EDGE, 0);
    await expectInsideViewport(page, { dock: page.locator('.panel-dock'), 'zoom controls': page.locator('.zoom-controls') }, { bottom: true });
    await expectContained('the zoom controls', page.locator('.zoom-controls'), page.locator('.canvas-region'));
  });
});
