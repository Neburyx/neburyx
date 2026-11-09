import { expect, test, type Page } from '@playwright/test';
import { canvasOf, modifier, openSample } from './support/workspace.ts';

const bar = (page: Page) => page.getByRole('toolbar', { name: 'Selection actions' });
const dock = (page: Page) => page.getByRole('complementary', { name: 'Compare' });
const compareButton = (page: Page) => bar(page).getByRole('button', { name: /^Compare/ });

/** Selects the first `count` entities by the walk: Space on the first, Shift+Space on each next. */
async function selectFirst(page: Page, count: number): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  for (let more = 1; more < count; more += 1) {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Space');
  }
}

async function chooseByKeyboard(page: Page): Promise<void> {
  await compareButton(page).focus();
  await page.keyboard.press('Enter');
}

const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe('the comparison', () => {
  test.beforeEach(async ({ page }) => {
    await openSample(page, '?compare=on');
  });

  test('opens from the selection bar by keyboard with the focus on its title, marks what differs, and Esc gives the focus back to the button', async ({ page }) => {
    await selectFirst(page, 2);
    await chooseByKeyboard(page);
    await expect(dock(page)).toBeVisible();
    await expect(dock(page).getByRole('heading', { name: 'Compare' })).toBeFocused();
    await expect(dock(page).getByRole('columnheader')).toHaveCount(3);
    await expect(dock(page).getByRole('row').nth(1)).toHaveAttribute('data-status', /differs|cannot|same/);
    await page.keyboard.press('Escape');
    await expect(dock(page)).toHaveCount(0);
    await expect(compareButton(page)).toBeFocused();
  });

  test('walks the focus through the switch, the copy buttons, the table region and Close', async ({ page }) => {
    await selectFirst(page, 2);
    await chooseByKeyboard(page);
    await expect(dock(page).getByRole('heading', { name: 'Compare' })).toBeFocused();
    const seen: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('Tab');
      seen.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName ?? ''));
    }
    expect(seen.slice(0, 3)).toEqual(['Close comparison', 'switch', 'Copy table']);
    expect(seen).toContain('Comparison table');
  });

  test('draws five columns that fit the window, with the property column and the headers fixed, and no sideways scroll of the page', async ({ page }) => {
    await selectFirst(page, 5);
    await expect(compareButton(page)).toHaveText('Compare');
    await compareButton(page).click();
    await expect(dock(page).getByRole('columnheader')).toHaveCount(6);
    const page2 = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(page2, 'the page does not scroll sideways').toBe(true);
    const region = dock(page).getByRole('region', { name: 'Comparison table' });
    const box = await region.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(300);
    const sticky = await dock(page).getByRole('columnheader', { name: /Property/ }).evaluate((element) => getComputedStyle(element).position);
    expect(sticky).toBe('sticky');
    const narrowest = await dock(page).getByRole('columnheader').nth(1).evaluate((element) => getComputedStyle(element).minWidth);
    expect(narrowest, 'a column is at least the named minimum wide').toBe('96px');
  });

  test('says "Compare 5 of 10" for all ten entities and names the five not compared', async ({ page }) => {
    const mod = await modifier(page);
    await canvasOf(page).focus();
    await page.keyboard.press(`${mod}+a`);
    await expect(compareButton(page)).toHaveText('Compare 5 of 10');
    await compareButton(page).click();
    await expect(dock(page).getByText('Comparing 5 of the 10 selected when opened')).toBeVisible();
    await expect(dock(page).getByRole('region', { name: 'Not compared' }).getByRole('listitem')).toHaveCount(5);
  });

  test('never overlaps the selection bar, the legend or the canvas controls once the bar has moved clear, and takes the width of its own default', async ({ page }) => {
    await selectFirst(page, 2);
    await chooseByKeyboard(page);
    await expect(dock(page)).toBeVisible();
    const boxOf = async (locator: ReturnType<Page['locator']>) => ((await locator.count()) === 0 ? null : await locator.first().boundingBox());
    // the selection bar moves clear of the narrowed canvas region after the panel opens, so the layout is read once it has settled
    await expect
      .poll(async () => {
        const aside = await dock(page).boundingBox();
        const others = [await boxOf(bar(page)), await boxOf(page.getByRole('region', { name: 'Legend' })), await boxOf(page.getByRole('group', { name: 'Zoom' }))];
        return others.some((other) => aside !== null && other !== null && overlap(aside, other));
      }, { message: 'the panel and another control overlap' })
      .toBe(false);
    const aside = await dock(page).boundingBox();
    expect(aside?.width ?? 0).toBeGreaterThan(400);
    expect(aside?.width ?? 0).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) / 2);
  });

  test('takes the column of an entity hidden from the view out and says so', async ({ page }) => {
    await selectFirst(page, 3);
    await chooseByKeyboard(page);
    await expect(dock(page).getByRole('columnheader')).toHaveCount(4);
    await page.locator('.graph-scope').first().focus();
    await canvasOf(page).focus();
    await page.keyboard.press('Delete');
    await expect(dock(page).getByText(/was removed from the view and is no longer compared/).first()).toBeVisible();
  });

  test('copies the table to the clipboard as tab-separated text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await selectFirst(page, 2);
    await chooseByKeyboard(page);
    await dock(page).getByRole('button', { name: 'Copy table' }).click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.split('\n')[0]).toMatch(/^Property\t/);
  });
});
