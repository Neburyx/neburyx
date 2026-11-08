import { expect, test, type Page } from '@playwright/test';

const SOURCE = 'banking-demo';

const box = (page: Page) => page.getByRole('searchbox', { name: 'Search text' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Filters' });
const entry = (page: Page, name: RegExp) => panel(page).getByRole('checkbox', { name });

async function searchFor(page: Page, text: string, selection = ''): Promise<void> {
  await page.goto(`/search?source=${SOURCE}${selection}`);
  await box(page).fill(text);
  await box(page).press('Enter');
  await expect(panel(page)).toBeVisible();
  expect(new URL(page.url()).search, 'the address holds names and never the text').not.toContain(text);
}

test.describe('the Filters of the Search results page', () => {
  test('shows the entity types and the match modes of the match set with their counts, and the total', async ({ page }) => {
    await searchFor(page, 'mix-3-2');
    await expect(entry(page, /Account/).locator('xpath=ancestor::label')).toContainText('3');
    await expect(entry(page, /Customer/).locator('xpath=ancestor::label')).toContainText('2');
    await expect(entry(page, /Exact ID/).locator('xpath=ancestor::label')).toContainText('5');
    await expect(entry(page, /Referenced ID/).locator('xpath=ancestor::label')).toContainText('0');
    await expect(entry(page, /Evidence record/).locator('xpath=ancestor::label')).toContainText('0');
    await expect(panel(page).getByText('5 entities')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Reset' })).toHaveCount(0);
  });

  test('reads 24, 25 and 26 matches as 24, 25 and "≥ 25 · lower bound", in the entries and in the total', async ({ page }) => {
    for (const [text, count, total] of [['many-24', '24', '24 entities'], ['many-25', '25', '25 entities'], ['many-26', '≥ 25 · lower bound', '≥ 25 entities · lower bound']] as const) {
      await searchFor(page, text);
      await expect(entry(page, /Account/).locator('xpath=ancestor::label')).toContainText(count);
      await expect(entry(page, /Exact ID/).locator('xpath=ancestor::label')).toContainText(count);
      await expect(panel(page).getByText(total, { exact: true })).toBeVisible();
    }
  });

  test('is a column left of the results at a laptop width, and above them at a narrow width, with no overlap and no horizontal scroll', async ({ page }) => {
    await searchFor(page, 'mix-3-2');
    const results = page.locator('.search-results');
    const side = (await panel(page).boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    const rows = (await results.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    expect(side.x + side.width).toBeLessThanOrEqual(rows.x);
    await page.setViewportSize({ width: 640, height: 900 });
    const narrowSide = (await panel(page).boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    const narrowRows = (await results.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    expect(narrowSide.y + narrowSide.height).toBeLessThanOrEqual(narrowRows.y + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('is reached by the keyboard after the search form, in order, and a box is toggled with Space', async ({ page }) => {
    await searchFor(page, 'mix-3-2');
    await expect(page.locator('.search-hit')).toHaveCount(5);
    await page.getByRole('button', { name: 'Search', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(entry(page, /Account/)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(entry(page, /Customer/)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(entry(page, /Exact ID/)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(entry(page, /Account/)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(entry(page, /Account/)).toBeChecked();
    await expect(page.locator('.search-hit')).toHaveCount(3);
    expect(new URL(page.url()).search).toBe(`?source=${SOURCE}&type=account`);
  });

  test('narrows the rows by the entity type and by the match mode, keeps every count, and Reset brings every row back', async ({ page }) => {
    await searchFor(page, 'mix-3-2');
    await entry(page, /Customer/).click();
    await expect(page.locator('.search-hit')).toHaveCount(2);
    await expect(entry(page, /Account/).locator('xpath=ancestor::label')).toContainText('3');
    await expect(panel(page).getByText('5 entities')).toBeVisible();
    await entry(page, /Referenced ID/).click();
    await expect(page.getByText('Exact matches are hidden by the selection.')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Reset' }).click();
    await expect(page.locator('.search-hit')).toHaveCount(5);
    expect(new URL(page.url()).search).toBe(`?source=${SOURCE}`);
  });

  test('puts the selection in the address as names, never the text, and Back returns to the earlier selection with its text', async ({ page }) => {
    await searchFor(page, 'mix-3-2');
    await entry(page, /Customer/).click();
    await entry(page, /Exact ID/).click();
    expect(new URL(page.url()).search).toBe(`?source=${SOURCE}&type=customer&mode=exact`);
    await page.goBack();
    expect(new URL(page.url()).search).toBe(`?source=${SOURCE}&type=customer`);
    await expect(entry(page, /Exact ID/)).not.toBeChecked();
    await expect(entry(page, /Customer/)).toBeChecked();
    await page.goBack();
    await expect(box(page)).toHaveValue('mix-3-2');
    await expect(page.locator('.search-hit')).toHaveCount(5);
  });

  test('restores the selection of an address that holds no text and searches it with the next text', async ({ page }) => {
    await page.goto(`/search?source=${SOURCE}&type=customer`);
    await expect(panel(page)).toHaveCount(0);
    await box(page).fill('mix-3-2');
    await box(page).press('Enter');
    await expect(entry(page, /Customer/)).toBeChecked();
    await expect(page.locator('.search-hit')).toHaveCount(2);
  });

  test('says the filters are unavailable when their counts were not read, offers Retry, and keeps the rows', async ({ page }) => {
    await searchFor(page, 'facfail-1');
    await expect(panel(page).getByText('Filters unavailable: counts not read')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(panel(page).getByRole('checkbox')).toHaveCount(0);
    await expect(page.locator('.search-hit')).toHaveCount(1);
  });

  test('says that matches exist and none could be shown, and with a selection that there is no result for it, with Reset', async ({ page }) => {
    await searchFor(page, 'ghost-3');
    await expect(page.getByRole('heading', { level: 2, name: 'Matches were found in the source but none could be shown.' })).toBeVisible();
    await entry(page, /Customer/).click();
    await expect(page.getByRole('heading', { level: 2, name: 'No result for this selection' })).toBeVisible();
    await page.locator('.search-empty').getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Matches were found in the source but none could be shown.' })).toBeVisible();
  });
});
