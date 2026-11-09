import { expect, test, type Page } from '@playwright/test';
import { boxOf } from './support/regions.ts';
import { canvasOf, openSample } from './support/workspace.ts';

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

  test('switches between Overview and Properties with the arrow keys and copies all properties', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSample(page);
    await selectFirst(page);
    await inspector(page).getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(inspector(page).getByRole('tab', { name: 'Properties' })).toHaveAttribute('aria-selected', 'true');
    await inspector(page).getByRole('button', { name: 'Copy all' }).click();
    await expect(inspector(page).getByText('Copied')).toBeVisible();
    await inspector(page).getByRole('tab', { name: 'Properties' }).focus();
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
