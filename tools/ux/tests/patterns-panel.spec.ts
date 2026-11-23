import { expect, test, type Locator, type Page } from '@playwright/test';
import { openOneEntity } from './support/workspace.ts';
import { setNumber } from './support/pattern-editor.ts';

const SOURCE = 'banking-demo';
const LIMITS = { none: '1', slow: '3', busy: '4' } as const;
const HEAVY_MIN_SHARED = '2';

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Patterns' });
const toolOf = (page: Page) => page.getByRole('button', { name: 'Patterns', exact: true });
const runOf = (page: Page) => panelOf(page).getByRole('button', { name: 'Run pattern' });
const startOf = (page: Page) => panelOf(page).getByLabel('Starting account');
const rowsOf = (page: Page) => panelOf(page).getByRole('heading', { level: 4 });
const cardOf = (page: Page) => panelOf(page).getByRole('button', { name: 'Shared devices', exact: true });

async function open(page: Page): Promise<void> {
  await toolOf(page).click();
  await expect(panelOf(page).getByRole('heading', { name: 'Patterns', level: 2 })).toBeVisible();
}

/** Opens the list and then the form of Shared devices with its Run. */
async function openForm(page: Page): Promise<void> {
  await open(page);
  await panelOf(page).getByRole('button', { name: 'Shared devices', exact: true }).click();
  await expect(startOf(page)).toBeVisible();
}

/** Chooses the loaded account as the starting entity, as a person does from the list. */
async function chooseStart(page: Page): Promise<void> {
  await startOf(page).selectOption({ index: 1 });
}

test.describe('the Patterns panel on the canvas', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/__support/patterns-mode', { data: { noPresets: false } });
    await openOneEntity(page, SOURCE, 'AC-1');
  });

  test('opens from the tool strip with the key, and Escape from the list closes it and gives the focus back to the tool', async ({ page }) => {
    await toolOf(page).focus();
    await page.keyboard.press('Enter');
    await expect(panelOf(page)).toBeVisible();
    await cardOf(page).focus();
    await expect(toolOf(page)).toHaveAttribute('data-active', 'true');
    await page.keyboard.press('Escape');
    await expect(panelOf(page)).toHaveCount(0);
    await expect(toolOf(page)).toBeFocused();
  });

  test('lists the three patterns of the banking pack under Built-in, each with Run only, and no suspicious chains', async ({ page }) => {
    await open(page);
    await expect(panelOf(page).getByRole('heading', { name: 'Built-in · 3' })).toBeVisible();
    await expect(rowsOf(page).filter({ hasText: /^(Shared devices|Shared addresses|Connected accounts)$/ })).toHaveText(['Shared devices', 'Shared addresses', 'Connected accounts']);
    await expect(panelOf(page).getByRole('button', { name: /^(Shared devices|Shared addresses|Connected accounts)$/ })).toHaveCount(3);
    await expect(panelOf(page).getByRole('button', { name: /^More: (Shared devices|Shared addresses|Connected accounts)$/ })).toHaveCount(0);
    await expect(panelOf(page).getByText(/Suspicious/)).toHaveCount(0);
  });

  test('says the source has no patterns when it offers none', async ({ page }) => {
    await page.request.post('/__support/patterns-mode', { data: { noPresets: true } });
    await open(page);
    await expect(panelOf(page).getByText('This source has no built-in patterns.')).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: /^(Shared (devices|addresses)|Connected accounts)$/ })).toHaveCount(0);
  });

  test('runs Shared devices from the preset account and shows the other five accounts of the ring with an exact count', async ({ page }) => {
    await openForm(page);
    await chooseStart(page);
    await runOf(page).click();
    const table = panelOf(page).getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(6);
    await expect(panelOf(page).getByRole('status').filter({ hasText: 'exact' })).toHaveText(/^5 other .+ found · exact · \d+\.\d\d\ss$/);
    await expect(table.getByRole('cell', { name: 'AC-2', exact: true })).toBeVisible();
  });

  test('folds the two dates of a custom window into the select once both are set and the focus leaves them, and Change dates opens them again', async ({ page }) => {
    await openForm(page);
    const window = panelOf(page).getByLabel('Observed lastSeen · UTC', { exact: true });
    await window.selectOption('custom');
    await panelOf(page).getByLabel('Observed lastSeen · UTC: from').fill('2026-10-21');
    await panelOf(page).getByLabel('Observed lastSeen · UTC: to').fill('2026-10-28');
    await panelOf(page).getByLabel('Starting account').focus();
    await expect(panelOf(page).getByLabel('Observed lastSeen · UTC: from')).toHaveCount(0);
    await expect(window.locator('option:checked')).toHaveText('21–28 Oct 2026');
    await panelOf(page).getByRole('button', { name: 'Change dates' }).click();
    await expect(panelOf(page).getByLabel('Observed lastSeen · UTC: from')).toBeFocused();
  });

  test('opens the form of a built-in pattern under its card in the list, and choosing the card again closes the form with the result kept for it', async ({ page }) => {
    await openForm(page);
    await expect(cardOf(page)).toHaveAttribute('aria-pressed', 'true');
    await chooseStart(page);
    await runOf(page).click();
    await expect(panelOf(page).getByRole('table')).toBeVisible();
    await cardOf(page).click();
    await expect(panelOf(page).getByRole('heading', { name: 'Patterns', level: 2 })).toBeVisible();
    await expect(panelOf(page).getByRole('heading', { name: 'Patterns', level: 2 })).toBeVisible();
    await expect(panelOf(page).getByRole('table')).toHaveCount(0);
    await panelOf(page).getByRole('button', { name: 'Shared devices', exact: true }).click();
    await expect(panelOf(page).getByRole('table')).toBeVisible();
  });

  test('says so plainly for an empty result', async ({ page }) => {
    await openForm(page);
    await chooseStart(page);
    await setNumber(panelOf(page), 'Max matching accounts', LIMITS.none);
    await runOf(page).click();
    await expect(panelOf(page).getByText(/^No matches found · exact/)).toBeVisible();
    await expect(panelOf(page).getByRole('table')).toHaveCount(0);
  });

  test('stops a heavy run with Refine filters and Continue with 25, and Continue shows the page', async ({ page }) => {
    await openForm(page);
    await chooseStart(page);
    await setNumber(panelOf(page), 'Min shared', HEAVY_MIN_SHARED);
    await runOf(page).click();
    await expect(panelOf(page).getByText('Estimated ≥ 500 matches · warning threshold 500')).toBeVisible();
    await expect(panelOf(page).getByRole('table')).toHaveCount(0);
    await panelOf(page).getByRole('button', { name: 'Refine filters' }).click();
    await expect(startOf(page)).toBeFocused();
    await expect(panelOf(page).getByLabel('Min shared')).toHaveValue(HEAVY_MIN_SHARED);
    await runOf(page).click();
    await panelOf(page).getByRole('button', { name: 'Continue with 25' }).click();
    await expect(panelOf(page).getByRole('table')).toBeVisible();
    await expect(panelOf(page).getByText(/Estimated/)).toHaveCount(0);
  });

  test('shows Running with Cancel, and Escape cancels the run and leaves the panel open', async ({ page }) => {
    await openForm(page);
    await chooseStart(page);
    await setNumber(panelOf(page), 'Max matching accounts', LIMITS.slow);
    await runOf(page).click();
    await expect(panelOf(page).getByText(/^Running/)).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Cancel' })).toBeVisible();
    await panelOf(page).getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Escape');
    await expect(panelOf(page).getByText('Cancelled. No new matches shown.')).toBeVisible();
    await expect(panelOf(page)).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Run again' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panelOf(page)).toHaveCount(0);
  });

  test('says the source is busy, keeps the form and offers Retry', async ({ page }) => {
    await openForm(page);
    await chooseStart(page);
    await setNumber(panelOf(page), 'Max matching accounts', LIMITS.busy);
    await runOf(page).click();
    await expect(panelOf(page).getByText(/is busy\. No read slot freed within the wait\./)).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(panelOf(page).getByLabel('Max matching accounts (number)')).toHaveValue(LIMITS.busy);
  });

  test('walks the form in reading order with Tab and back with Shift+Tab', async ({ page }) => {
    await openForm(page);
    await expect(startOf(page)).toBeFocused();
    const limit = panelOf(page).getByLabel('Max matching accounts');
    const order = [startOf(page), panelOf(page).getByRole('button', { name: 'Search the source' }), panelOf(page).getByLabel('Observed lastSeen · UTC', { exact: true }), panelOf(page).getByLabel('Min shared'), limit];
    for (const field of order) {
      // a date field has a stop for each of its parts, so Tab is pressed until the field is reached
      for (let presses = 0; presses < 4 && !(await field.evaluate((element) => element === document.activeElement)); presses += 1) await page.keyboard.press('Tab');
      await expect(field).toBeFocused();
    }
    await chooseStart(page);
    await page.keyboard.press('Tab');
    await expect(runOf(page)).toBeFocused();
    for (let presses = 0; presses < 4 && !(await limit.evaluate((element) => element === document.activeElement)); presses += 1) await page.keyboard.press('Shift+Tab');
    await expect(limit).toBeFocused();
  });

  test('draws each built-in card slim, with its glyph and name on one line, and no search box or line about the source', async ({ page }) => {
    await open(page);
    const card = panelOf(page).getByRole('button', { name: 'Shared devices', exact: true });
    const box = await card.boundingBox();
    expect(box?.height ?? 99).toBeLessThan(40);
    expect((await card.locator('xpath=ancestor::li').boundingBox())?.height ?? 99, 'the card around the button adds no padding of its own').toBeLessThan(40);
    const around = await card.locator('xpath=ancestor::li').boundingBox();
    expect(Math.abs((box?.width ?? 0) - ((around?.width ?? 99) - 2)), 'the button spans the card').toBeLessThan(3);
    await expect(card.locator('xpath=ancestor::h4')).toHaveCSS('font-weight', '400');
    const glyph = await card.locator('img').boundingBox();
    const name = await card.locator('.pattern-card-name').boundingBox();
    expect(Math.abs(((glyph?.y ?? 0) + (glyph?.height ?? 0) / 2) - ((name?.y ?? 99) + (name?.height ?? 0) / 2))).toBeLessThan(4);
    await expect(panelOf(page).getByRole('searchbox')).toHaveCount(0);
    await expect(panelOf(page).getByText(/read-only$/)).toHaveCount(0);
  });

  test('draws the form selects as the product draws a select: no native arrow, a thin chevron and the height of a button', async ({ page }) => {
    await openForm(page);
    const selects = panelOf(page).getByRole('combobox');
    expect(await selects.count()).toBeGreaterThan(1);
    const button = await runOf(page).boundingBox();
    const first = selects.first();
    const resting = await first.evaluate((element) => getComputedStyle(element).backgroundColor);
    await first.hover();
    expect(await first.evaluate((element) => getComputedStyle(element).backgroundColor), 'the hover fill of a plain select').not.toBe(resting);
    await panelOf(page).getByLabel('Observed lastSeen · UTC', { exact: true }).selectOption('custom');
    const text = panelOf(page).getByLabel('Observed lastSeen · UTC: from');
    const looks = (field: Locator) => field.evaluate((element) => ({ radius: getComputedStyle(element).borderRadius, size: getComputedStyle(element).fontSize, colour: getComputedStyle(element).color }));
    expect(await looks(first), 'a select looks like the inputs beside it').toEqual(await looks(text));
    const live = await first.evaluate((element) => getComputedStyle(element).color);
    await first.evaluate((element) => ((element as HTMLSelectElement).disabled = true));
    expect(await first.evaluate((element) => getComputedStyle(element).color), 'a disabled select reads muted').not.toBe(live);
    await first.evaluate((element) => ((element as HTMLSelectElement).disabled = false));
    for (const select of await selects.all()) {
      await expect(select).toHaveCSS('appearance', 'none');
      expect(await select.evaluate((element) => getComputedStyle(element).backgroundImage)).toMatch(/^url\(/);
      expect(await select.evaluate((element) => parseFloat(getComputedStyle(element).paddingRight)), 'room for the chevron').toBeGreaterThan(20);
      expect(Math.abs(((await select.boundingBox())?.height ?? 0) - (button?.height ?? 99))).toBeLessThan(4);
    }
  });

  test('keeps every control and the result inside the window, the panel scrolling inside itself', async ({ page }) => {
    await openForm(page);
    await chooseStart(page);
    await runOf(page).click();
    await expect(panelOf(page).getByRole('table')).toBeVisible();
    const window = page.viewportSize();
    const box = await panelOf(page).boundingBox();
    expect(box, 'the panel is drawn').not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(window?.height ?? 0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(window?.width ?? 0);
    await runOf(page).scrollIntoViewIfNeeded();
    await expect(runOf(page)).toBeVisible();
  });
});
