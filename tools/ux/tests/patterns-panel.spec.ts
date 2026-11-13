import { expect, test, type Page } from '@playwright/test';
import { openOneEntity } from './support/workspace.ts';

const SOURCE = 'banking-demo';
const LIMITS = { none: '1', slow: '3', busy: '4' } as const;
const HEAVY_MIN_SHARED = '2';

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Patterns' });
const toolOf = (page: Page) => page.getByRole('button', { name: 'Patterns', exact: true });
const runOf = (page: Page) => panelOf(page).getByRole('button', { name: 'Run pattern' });
const startOf = (page: Page) => panelOf(page).getByLabel('Starting account');

async function open(page: Page): Promise<void> {
  await toolOf(page).click();
  await expect(panelOf(page)).toBeVisible();
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

  test('opens from the tool strip with the key, puts the focus on the selected pattern and gives it back on Escape', async ({ page }) => {
    await toolOf(page).focus();
    await page.keyboard.press('Enter');
    await expect(panelOf(page)).toBeVisible();
    await expect(panelOf(page).getByRole('radio', { name: 'Shared devices' })).toBeFocused();
    await expect(toolOf(page)).toHaveAttribute('data-active', 'true');
    await page.keyboard.press('Escape');
    await expect(panelOf(page)).toHaveCount(0);
    await expect(toolOf(page)).toBeFocused();
  });

  test('lists the three patterns of the banking pack and no suspicious chains', async ({ page }) => {
    await open(page);
    const cards = panelOf(page).getByRole('radio');
    await expect(cards).toHaveText(['Shared devices', 'Shared addresses', 'Connected accounts']);
    await expect(panelOf(page).getByText(/Suspicious/)).toHaveCount(0);
    await expect(panelOf(page).getByText(/Save pattern/)).toHaveCount(0);
  });

  test('says the source has no patterns when it offers none', async ({ page }) => {
    await page.request.post('/__support/patterns-mode', { data: { noPresets: true } });
    await open(page);
    await expect(panelOf(page).getByText('This source has no patterns.')).toBeVisible();
    await expect(runOf(page)).toHaveCount(0);
  });

  test('runs Shared devices from the preset account and shows the other five accounts of the ring with an exact count', async ({ page }) => {
    await open(page);
    await chooseStart(page);
    await runOf(page).click();
    const table = panelOf(page).getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(6);
    await expect(panelOf(page).getByRole('status').filter({ hasText: 'exact' })).toHaveText('5 · exact');
    await expect(table.getByRole('cell', { name: 'AC-2', exact: true })).toBeVisible();
  });

  test('says so plainly for an empty result', async ({ page }) => {
    await open(page);
    await chooseStart(page);
    await panelOf(page).getByLabel('Max matching accounts').fill(LIMITS.none);
    await runOf(page).click();
    await expect(panelOf(page).getByText('No matches found.')).toBeVisible();
    await expect(panelOf(page).getByRole('table')).toHaveCount(0);
  });

  test('stops a heavy run with Refine filters and Continue with 25, and Continue shows the page', async ({ page }) => {
    await open(page);
    await chooseStart(page);
    await panelOf(page).getByLabel('Min shared').fill(HEAVY_MIN_SHARED);
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
    await open(page);
    await chooseStart(page);
    await panelOf(page).getByLabel('Max matching accounts').fill(LIMITS.slow);
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
    await open(page);
    await chooseStart(page);
    await panelOf(page).getByLabel('Max matching accounts').fill(LIMITS.busy);
    await runOf(page).click();
    await expect(panelOf(page).getByText(/is busy\. No read slot freed within the wait\./)).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(panelOf(page).getByLabel('Max matching accounts')).toHaveValue(LIMITS.busy);
  });

  test('walks the form in reading order with Tab and back with Shift+Tab', async ({ page }) => {
    await open(page);
    await expect(panelOf(page).getByRole('radio', { name: 'Shared devices' })).toBeFocused();
    const limit = panelOf(page).getByLabel('Max matching accounts');
    const order = [startOf(page), panelOf(page).getByRole('searchbox', { name: 'Search the source' }), panelOf(page).getByLabel('Window: from'), panelOf(page).getByLabel('Window: to'), panelOf(page).getByLabel('Min shared'), limit];
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

  test('keeps every control and the result inside the window, the panel scrolling inside itself', async ({ page }) => {
    await open(page);
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
