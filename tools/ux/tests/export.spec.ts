import { expect, test, type Page } from '@playwright/test';

async function openInvestigation(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
}

const exportButton = (page: Page) => page.getByRole('button', { name: 'Export', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Export current view' });
const banner = (page: Page) => page.getByRole('region', { name: 'Request status' });
const mode = (page: Page, value: 'ok' | 'refused' | 'failed' | 'large') => page.request.post('/__support/export-mode', { data: { mode: value } });

test.afterEach(async ({ page }) => {
  await mode(page, 'ok');
});

test.describe('exporting the current view', () => {
  test('opens from the header, states what every export starts with, and closes with Escape, handing the focus back', async ({ page }) => {
    await openInvestigation(page);
    await exportButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByText('Every export starts with')).toBeVisible();
    await expect(dialog(page).getByText('source: banking-demo')).toBeVisible();
    await expect(dialog(page).getByText('scope: current view (partial)')).toBeVisible();
    await expect(dialog(page).getByText(/^coverage: 1 shown · /)).toBeVisible();
    await expect(dialog(page).getByText('masking: off')).toBeVisible();
    await expect(dialog(page).getByText('Exports are partial views, not signed evidence.')).toBeVisible();
    await expect(dialog(page)).not.toContainText(/mask critical|PNG|configured store/i);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(exportButton(page)).toBeFocused();
  });

  test('keeps the focus inside the dialog while Tab goes round', async ({ page }) => {
    await openInvestigation(page);
    await exportButton(page).click();
    for (let step = 0; step < 9; step += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    }
  });

  test('downloads the JSON file under the name the server gave, and the dialog closes', async ({ page }) => {
    await openInvestigation(page);
    await exportButton(page).click();
    const download = page.waitForEvent('download');
    await dialog(page).getByRole('button', { name: 'Download JSON' }).click();
    expect((await download).suggestedFilename()).toBe('neburyx-export-20261110T101500Z.json');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Export downloaded.' })).toHaveCount(1);
  });

  test('downloads a CSV export as a zip when CSV is chosen', async ({ page }) => {
    await openInvestigation(page);
    await exportButton(page).click();
    await dialog(page).getByRole('radio', { name: 'CSV' }).check();
    const download = page.waitForEvent('download');
    await dialog(page).getByRole('button', { name: 'Download CSV' }).click();
    expect((await download).suggestedFilename()).toMatch(/^neburyx-export-\d{8}T\d{6}Z\.zip$/);
  });

  test('stays open with the server\'s message and Try again when the export fails, and the canvas is as it was', async ({ page }) => {
    await openInvestigation(page);
    await mode(page, 'failed');
    await exportButton(page).click();
    await dialog(page).getByRole('button', { name: 'Download JSON' }).click();
    await expect(dialog(page).getByRole('status').filter({ hasText: /\S/ })).toHaveText('The export could not be created.');
    await expect(dialog(page).getByRole('button', { name: 'Try again' })).toBeVisible();
    await mode(page, 'ok');
    const download = page.waitForEvent('download');
    await dialog(page).getByRole('button', { name: 'Try again' }).click();
    await download;
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('account AC-1');
  });

  test('names the limit when the view is too large', async ({ page }) => {
    await openInvestigation(page);
    await mode(page, 'large');
    await exportButton(page).click();
    await dialog(page).getByRole('button', { name: 'Download JSON' }).click();
    await expect(dialog(page).getByRole('status').filter({ hasText: /\S/ })).toContainText('An export holds at most 300 entities, 300 stored relationships and 100 aggregated relationships.');
  });

  test('shows the banner of a refused download, and Export again opens the dialog and takes the banner away', async ({ page }) => {
    await openInvestigation(page);
    await mode(page, 'refused');
    await exportButton(page).click();
    await dialog(page).getByRole('button', { name: 'Download JSON' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(banner(page)).toContainText('Your access changed since this export was made.');
    await expect(banner(page)).toContainText('Export again to get a file that matches your current access.');
    await expect(banner(page).getByText('Export', { exact: true })).toBeVisible();
    await banner(page).getByRole('button', { name: 'Export again' }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test('is available for a closed investigation', async ({ page }) => {
    await openInvestigation(page);
    await page.getByRole('button', { name: 'Investigation menu' }).click();
    await page.getByRole('menuitem', { name: 'Close' }).click();
    await expect(page.getByText('Closed · read-only')).toBeVisible();
    await expect(exportButton(page)).toBeEnabled();
  });
});
