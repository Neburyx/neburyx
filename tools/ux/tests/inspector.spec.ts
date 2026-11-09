import { expect, test, type Page } from '@playwright/test';
import { boxOf } from './support/regions.ts';
import { announcement, canvasOf, drawing, openSample } from './support/workspace.ts';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });

async function selectFirst(page: Page): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
}

/** What has the focus, named as a person would hear it. */
const nameOfFocus = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return 'none';
    return `${element.getAttribute('role') ?? element.tagName.toLowerCase()}: ${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? ''}`;
  });

/** Presses the key until the focus is inside the inspector and lists every stop on the way, the one inside the inspector last. */
async function stopsUntilInspector(page: Page, key: 'Tab' | 'Shift+Tab', limit = 40): Promise<string[]> {
  const stops: string[] = [];
  for (let press = 0; press < limit; press += 1) {
    await page.keyboard.press(key);
    stops.push(await nameOfFocus(page));
    if ((await inspector(page).locator(':focus').count()) > 0) return stops;
  }
  throw new Error('NEVER_REACHED_BY_KEY');
}

/** The tool strip, the zoom controls and the layout choice sit between the canvas and the inspector; the inspector's first control is its close button. */
const STOPS_BETWEEN = ['button: Explore', 'button: Filters', 'button: Paths', 'button: Patterns', 'button: Search', 'button: Group', 'button: Table', 'button: Legend', 'button: Zoom out', 'button: Zoom in', 'button: Fit to view', 'button: Layout: Force', 'button: Close inspector'];

async function stopsBackToCanvas(page: Page, limit = 40): Promise<string[]> {
  const stops: string[] = [];
  for (let press = 0; press < limit; press += 1) {
    await page.keyboard.press('Shift+Tab');
    stops.push(await nameOfFocus(page));
    if (await canvasOf(page).evaluate((element) => element === document.activeElement)) return stops;
  }
  throw new Error('NEVER_BACK_AT_CANVAS');
}

async function openEntity(page: Page, stableId: string): Promise<void> {
  await page.goto(`/banking-demo/entity/account/${stableId}`);
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  await expect(canvasOf(page)).toBeVisible();
}

test.describe('the inspector', () => {
  test('opens for the selected entity, is reached by Tab once the walk is left, and closes on Esc with the focus on the canvas and the selection kept', async ({ page }) => {
    await openSample(page);
    await selectFirst(page);
    await expect(inspector(page)).toBeVisible();
    await expect(inspector(page).getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await expect(inspector(page).getByRole('tab')).toHaveText(['Overview', 'Relationships', 'Properties']);
    await page.keyboard.press('Escape');
    await expect(canvasOf(page)).toBeFocused();
    await expect(inspector(page)).toBeVisible();
    const stops = await stopsUntilInspector(page, 'Tab');
    expect(stops, 'the stops between the canvas and the inspector, in DOM order: a new stop in between fails this').toEqual(STOPS_BETWEEN);
    const back = await stopsBackToCanvas(page);
    expect(back, 'Shift+Tab returns the same way').toEqual([...STOPS_BETWEEN.slice(0, -1).reverse(), 'application: Graph canvas']);
    await stopsUntilInspector(page, 'Tab');
    await page.keyboard.press('Escape');
    await expect(inspector(page)).toHaveCount(0);
    await expect(canvasOf(page)).toBeFocused();
    await expect(page.getByRole('toolbar')).toHaveCount(0);
  });

  test('switches between Overview, Relationships and Properties with the arrow keys and copies all properties', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSample(page);
    await selectFirst(page);
    await inspector(page).getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(inspector(page).getByRole('tab', { name: 'Relationships' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(inspector(page).getByRole('tab', { name: 'Properties' })).toHaveAttribute('aria-selected', 'true');
    await inspector(page).getByRole('button', { name: 'Copy all' }).click();
    await expect(inspector(page).getByText('Copied')).toBeVisible();
    await inspector(page).getByRole('tab', { name: 'Properties' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(inspector(page).getByRole('tab', { name: 'Relationships' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(inspector(page).getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  test('shows the entity that is selected next and closes when the selection is cleared', async ({ page }) => {
    await openSample(page);
    await selectFirst(page);
    const first = await inspector(page).getByRole('heading', { level: 2 }).textContent();
    await canvasOf(page).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(inspector(page).getByRole('heading', { level: 2 })).not.toHaveText(first ?? '');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(inspector(page)).toHaveCount(0);
  });

  test('keeps a long value inside the panel without a horizontal scroll', async ({ page }) => {
    await openSample(page);
    await selectFirst(page);
    const body = inspector(page).locator('.inspector');
    const overflow = await body.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('says an ID the source holds twice has more than one entity', async ({ page }) => {
    await openEntity(page, 'dup-1');
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect(inspector(page).getByText('More than one entity has this ID')).toBeVisible();
  });

  test('does not overlap the Legend', async ({ page }) => {
    await openSample(page);
    await selectFirst(page);
    await page.keyboard.press('l');
    const legend = page.getByRole('complementary', { name: 'Legend' });
    await expect(legend).toBeVisible();
    const a = await boxOf(legend);
    const b = await boxOf(inspector(page));
    const apart = a.x + a.width <= b.x || b.x + b.width <= a.x;
    expect(apart, 'the Legend and the inspector are side by side').toBe(true);
  });
});

const STOPS_INSIDE = [
  'button: Close inspector',
  'button: Expand',
  'button: Pin',
  'button: Hide',
  'button: More actions',
  'tab: Relationships',
  'button: HOLDS, Jordan Lee · Holder, to this entity',
  'button: SENDS, TRN-99381 · Transfer, from this entity',
  'button: USES_GADGET, GAD-884 · Gadget · 42 · exact, from this entity',
  'button: Show more',
  'button: SHARED_GADGET, LED-71825 · rule-derived, from this entity',
  'separator: Resize Inspector',
  'button: Collapse Inspector',
];
const exactCount = (value: number) => ({ value, quality: 'exact', scope: 'relationships' });
const noCount = { quality: 'unknown', scope: 'relationships' };

async function routePreview(page: Page, counts: { readonly total: object; readonly byType: ReadonlyArray<readonly [string, object]>; readonly pageSize?: number }): Promise<void> {
  await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
    const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
    await route.fulfill({
      json: {
        ref: { sourceId: body.sourceId, ...body.ref },
        total: counts.total,
        byType: counts.byType.map(([relationshipType, count]) => ({ relationshipType, direction: 'out', count, neighborTypes: ['ledger'] })),
        byNeighborType: [],
        warnings: [],
        pageSize: counts.pageSize ?? 25,
        heavyOpThreshold: 500,
      },
    });
  });
}

/** Selects the entity with this title by walking the canvas: the first element, then the next ones. */
async function selectByTitle(page: Page, title: string): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  for (let step = 0; step < 14; step += 1) {
    await page.keyboard.press('Space');
    if ((await inspector(page).getByRole('heading', { level: 2 }).textContent()) === title) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('ENTITY_NOT_FOUND_BY_WALK');
}

const rowsOf = (page: Page) => inspector(page).locator('.relationship-row');

test.describe('the inspector Relationships tab', () => {
  test('lists the drawn relationships of the entity by type with loaded-of-total counts and the scope line, and keeps the inspector open when a row selects one', async ({ page }) => {
    await routePreview(page, { total: exactCount(22), byType: [['HOLDS', exactCount(1)], ['SENDS', exactCount(1)], ['USES_GADGET', exactCount(15)]] });
    await openSample(page);
    await selectByTitle(page, 'LED-48291');
    await inspector(page).getByRole('tab', { name: 'Relationships' }).click();
    await expect(inspector(page).getByRole('region', { name: 'HOLDS' })).toContainText('1 loaded of 1 · exact');
    await expect(inspector(page).getByRole('region', { name: 'USES_GADGET' })).toContainText('loaded of 15 · exact');
    await expect(inspector(page).getByRole('region', { name: 'Rule-derived' })).toBeVisible();
    await expect(inspector(page).locator('.inspector-relationships > .inspector-scope').last()).toContainText('sourced neighbors on canvas');
    const row = rowsOf(page).first();
    const widthsBefore = (await drawing(page)).edges.map((edge) => edge.width);
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    expect((await drawing(page)).edges.map((edge) => edge.width), 'the canvas draws the relationship selected').not.toEqual(widthsBefore);
    await expect(inspector(page)).toBeVisible();
    await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText('LED-48291');
    await expect(row).toBeFocused();
  });

  test('is reached row by row with Tab and selects with Enter', async ({ page }) => {
    await routePreview(page, { total: exactCount(22), byType: [] });
    await openSample(page);
    await selectByTitle(page, 'LED-48291');
    const tab = inspector(page).getByRole('tab', { name: 'Relationships' });
    await tab.click();
    await tab.focus();
    const count = await rowsOf(page).count();
    expect(count).toBeGreaterThan(1);
    for (let index = 0; index < count; index += 1) {
      await page.keyboard.press('Tab');
      await expect(rowsOf(page).nth(index)).toBeFocused();
    }
    await page.keyboard.press('Enter');
    await expect(rowsOf(page).nth(count - 1)).toHaveAttribute('aria-current', 'true');
  });

  test('shows no number for a total the source cannot give', async ({ page }) => {
    await routePreview(page, { total: noCount, byType: [['HOLDS', noCount]] });
    await openSample(page);
    await selectByTitle(page, 'LED-48291');
    await inspector(page).getByRole('tab', { name: 'Relationships' }).click();
    await expect(inspector(page).getByRole('region', { name: 'HOLDS' }).locator('.inspector-section-count')).toHaveText(/^1 loaded$/);
    await expect(inspector(page).locator('.inspector-relationships > .inspector-scope').last()).toHaveText('not loaded: no count');
  });

  test('keeps the inspector on its entity when one of its relationships is selected on the canvas', async ({ page }) => {
    await routePreview(page, { total: exactCount(22), byType: [['HOLDS', exactCount(1)]] });
    await openSample(page);
    await selectByTitle(page, 'LED-48291');
    await inspector(page).getByRole('tab', { name: 'Relationships' }).click();
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    for (let step = 0; step < 30; step += 1) {
      if ((await announcement(page).textContent())?.startsWith('HOLDS, from Jordan Lee to LED-48291') === true) break;
      await page.keyboard.press('Tab');
    }
    await expect(announcement(page)).toHaveText(/^HOLDS, from Jordan Lee to LED-48291/);
    await page.keyboard.press('Space');
    await expect(inspector(page).getByRole('heading', { level: 2 })).toHaveText('LED-48291');
    await expect(inspector(page).locator('.relationship-row[aria-current="true"]')).toHaveCount(1);
    await expect(inspector(page).locator('.relationship-row[aria-current="true"]')).toHaveAccessibleName(/^HOLDS, Jordan Lee/);
  });

  test('has the stops header buttons, the selected tab, the rows and Show more, in that order, and Show more draws the next page', async ({ page }) => {
    await routePreview(page, { total: exactCount(22), byType: [], pageSize: 1 });
    await openSample(page);
    await selectByTitle(page, 'LED-48291');
    await inspector(page).getByRole('tab', { name: 'Relationships' }).click();
    await inspector(page).getByRole('button', { name: 'Close inspector' }).focus();
    const stops: string[] = [await nameOfFocus(page)];
    for (let step = 0; step < 20; step += 1) {
      await page.keyboard.press('Tab');
      if ((await inspector(page).locator(':focus').count()) === 0) break;
      stops.push(await nameOfFocus(page));
    }
    expect(stops).toEqual(STOPS_INSIDE);
    await inspector(page).getByRole('button', { name: 'Show more' }).first().click();
    await expect(inspector(page).locator('.relationship-row')).toHaveCount(5);
  });
});
