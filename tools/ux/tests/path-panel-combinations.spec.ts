import { expect, test, type Page } from '@playwright/test';
import { canvasOf, openWithDraft, screenOf } from './support/workspace.ts';

const STATUS = { ask: { available: true }, summary: { available: true }, assistant: { available: true, messageWords: 1000, model: 'claude-sonnet-5-5' } };
const pathPanel = (page: Page) => page.getByRole('complementary', { name: 'Bounded path search' });
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Selection actions' });
const header = (page: Page) => page.getByRole('banner', { name: 'Investigation' });

/** What path search must stand clear of, by a name for the report. */
const OTHERS: ReadonlyArray<readonly [string, string]> = [
  ['tool strip', '.region-tool-strip'],
  ['scope lines', '.graph-scope'],
  ['legend and layer toggles', '.region-toggles'],
  ['zoom controls', '.region-zoom-controls'],
  ['selection bar', '.selection-bar'],
  ['starting hint', '.starting-hint'],
  ['canvas notice', '.canvas-notice'],
  ['expansion status', '.expansion-status'],
  ['dock panels', '.panel-dock'],
  ['other floating panels', '.floating-panel:not(:has(.paths-panel))'],
];

async function selectFirst(page: Page, count: number): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  for (let more = 1; more < count; more += 1) {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Space');
  }
}

async function prepare(page: Page): Promise<void> {
  await page.context().route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: STATUS }));
  await page.context().route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: { turns: [], earlierTurns: 0, previousThreadClearedAt: null } }));
  await openWithDraft(page, ['AC-1', 'AC-2', 'AC-3'], (index) => ({ x: -index * 220, y: index * 110 }));
  await page.reload();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '3');
}

const OPEN: Readonly<Record<string, (page: Page) => Promise<void>>> = {
  inspector: async (page) => {
    const at = await screenOf(page, 'AC-2');
    await page.mouse.click(at.x, at.y);
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  },
  assistant: async (page) => {
    await header(page).getByRole('button', { name: 'Assistant' }).click();
    await expect(page.locator('.assistant-panel')).toBeVisible();
  },
  'assistant wide': async (page) => {
    await header(page).getByRole('button', { name: 'Assistant' }).click();
    await expect(page.locator('.assistant-panel')).toBeVisible();
    await page.locator('.assistant-panel').getByRole('button', { name: /^(Wide|Normal width)$/ }).click();
  },
  'assistant popped out': async (page) => {
    await header(page).getByRole('button', { name: 'Assistant' }).click();
    await expect(page.locator('.assistant-panel')).toBeVisible();
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.assistant-panel').getByRole('button', { name: 'Pop out' }).click()]);
    await popup.waitForLoadState();
    await expect(page.locator('.assistant-panel').getByText('The chat is open in another window')).toBeVisible();
  },
  'assistant wide attempted': async (page) => {
    await header(page).getByRole('button', { name: 'Assistant' }).click();
    await expect(page.locator('.assistant-panel')).toBeVisible();
    // Wide is off while the inspector is open, so that no panel is covered
    await expect(page.locator('.assistant-panel').getByRole('button', { name: /^Wide: close the inspector first/ })).toHaveAttribute('aria-disabled', 'true');
  },
  'assistant dragged wide': async (page) => {
    await header(page).getByRole('button', { name: 'Assistant' }).click();
    await expect(page.locator('.assistant-panel')).toBeVisible();
    // the person's own resize to the widest the panel may be made, with the inspector open: it stops short of covering the left panel
    await page.getByRole('separator', { name: 'Resize Assistant' }).focus();
    await page.keyboard.press('End');
  },
  'inspector over a wide assistant': async (page) => {
    await header(page).getByRole('button', { name: 'Assistant' }).click();
    await expect(page.locator('.assistant-panel')).toBeVisible();
    await page.locator('.assistant-panel').getByRole('button', { name: 'Wide', exact: true }).click();
    await expect(page.locator('.assistant-panel').getByRole('button', { name: 'Normal width' })).toBeVisible();
    const at = await screenOf(page, 'AC-2');
    await page.mouse.click(at.x, at.y);
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    // the Assistant went back to its normal width, and said so politely
    await expect(page.locator('.assistant-panel').getByRole('button', { name: 'Wide', exact: true })).toBeVisible();
    await expect(page.locator('.assistant-panel [data-narrowed-note]').filter({ hasText: 'back to its normal width because the inspector is open' })).toHaveCount(1);
  },
  ask: async (page) => {
    await header(page).getByRole('button', { name: 'Ask' }).click();
    await expect(page.locator('.ask-panel').first()).toBeVisible();
  },
  summary: async (page) => {
    await header(page).getByRole('button', { name: 'Summarize' }).click();
    await expect(page.getByRole('complementary', { name: /AI case summary/ })).toBeVisible();
  },
  legend: async (page) => {
    await page.getByRole('button', { name: 'Legend' }).click();
    await expect(page.getByRole('complementary', { name: 'Legend' })).toBeVisible();
  },
  'selection bar': async (page) => {
    await selectFirst(page, 2);
    await expect(bar(page)).toBeVisible();
  },
  compare: async (page) => {
    await selectFirst(page, 2);
    await bar(page).getByRole('button', { name: /^Compare/ }).click();
    await expect(page.getByRole('complementary', { name: 'Compare' })).toBeVisible();
  },
};

const COMBINATIONS: ReadonlyArray<readonly string[]> = [
  [],
  ['inspector'],
  ['assistant'],
  ['assistant wide'],
  ['ask'],
  ['summary'],
  ['legend'],
  ['selection bar'],
  ['compare'],
  ['assistant popped out'],
  ['inspector', 'assistant popped out'],
  ['inspector', 'assistant'],
  ['inspector', 'assistant wide attempted'],
  ['inspector over a wide assistant'],
  ['inspector', 'assistant dragged wide'],
  ['inspector', 'legend'],
  ['assistant', 'selection bar'],
];

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
const apart = (a: Box, b: Box): boolean => a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height;

test.describe('path search with every other panel that can be open at once', () => {
  for (const combination of COMBINATIONS) {
    test(`stands clear of ${combination.length === 0 ? 'the tool strip, the scope lines, the hint and the controls' : combination.join(' and ')}, inside the canvas`, async ({ page }) => {
      await prepare(page);
      for (const name of combination) await OPEN[name]?.(page);
      await page.getByRole('button', { name: 'Paths', exact: true }).click();
      await expect(pathPanel(page)).toBeVisible();
      await page.waitForTimeout(400);
      const shots = process.env['NEBURYX_UX_SHOTS'];
      if (shots !== undefined) await page.screenshot({ path: `${shots}/path-search-with-${combination.join('-and-').replaceAll(' ', '-') || 'nothing-else'}-${page.viewportSize()?.width}x${page.viewportSize()?.height}.png` });
      const panel = await pathPanel(page).boundingBox();
      const region = await page.locator('.canvas-region').boundingBox();
      if (panel === null || region === null) throw new Error('not drawn');
      expect(panel.x, 'inside the canvas, left').toBeGreaterThanOrEqual(region.x - 0.5);
      expect(panel.x + panel.width, 'inside the canvas, right').toBeLessThanOrEqual(region.x + region.width + 0.5);
      expect(panel.y + panel.height, 'inside the canvas, bottom').toBeLessThanOrEqual(region.y + region.height + 0.5);
      for (const [name, selector] of OTHERS) {
        const found = page.locator(selector);
        for (let index = 0; index < (await found.count()); index += 1) {
          const box = await found.nth(index).boundingBox();
          if (box === null || box.width === 0 || box.height === 0 || !(await found.nth(index).isVisible())) continue;
          expect(apart(panel, box), `path search covers ${name} (${selector}) with ${combination.join(', ') || 'nothing else open'}`).toBe(true);
        }
      }
    });
  }
});

test.describe('path search grown to its tallest', () => {
  test('stays above the layer toggles and the zoom controls and inside the canvas when its list of relationships is opened', async ({ page }) => {
    await prepare(page);
    await page.getByRole('button', { name: 'Paths', exact: true }).click();
    await expect(pathPanel(page)).toBeVisible();
    await pathPanel(page).getByRole('button', { name: /Allowed relationships|relationships/i }).first().click();
    await page.waitForTimeout(400);
    const panel = await pathPanel(page).boundingBox();
    const region = await page.locator('.canvas-region').boundingBox();
    if (panel === null || region === null) throw new Error('not drawn');
    expect(panel.y + panel.height).toBeLessThanOrEqual(region.y + region.height + 0.5);
    for (const [name, selector] of OTHERS) {
      const found = page.locator(selector);
      for (let index = 0; index < (await found.count()); index += 1) {
        const box = await found.nth(index).boundingBox();
        if (box === null || box.width === 0 || box.height === 0 || !(await found.nth(index).isVisible())) continue;
        expect(apart(panel, box), `path search covers ${name} when it is tall`).toBe(true);
      }
    }
  });
});
