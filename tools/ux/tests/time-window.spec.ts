import { expect, test, type Page } from '@playwright/test';
import { apartFromInspector, canvasOf } from './support/workspace.ts';

const lines = (page: Page) => page.locator('.graph-scope p');
const filtersButton = (page: Page) => page.getByRole('group', { name: 'Tools' }).getByRole('button', { name: 'Filters' });
const windowSelect = (page: Page, name = 'seenAt · UTC') => page.getByRole('combobox', { name });
const results = (page: Page) => page.getByRole('status').filter({ hasText: 'match · exact' });

test.describe('the time window', () => {
  test('filters out loaded items from the keyboard, makes the lines agree with the canvas, and resets', async ({ page }) => {
    const requests: string[] = [];
    await page.goto('/dev/frame-sample?times=on');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '10');
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/v1/')) requests.push(`${request.method()} ${pathname}`);
    });
    await filtersButton(page).click();
    await expect(page.getByText('Applies to loaded items.')).toBeVisible();

    await windowSelect(page).selectOption('Dates (UTC)');
    await page.getByRole('textbox', { name: 'From (UTC date)' }).fill('2026-10-01');
    await page.getByRole('textbox', { name: 'To (UTC date)' }).fill('2026-10-31');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '9');
    await expect(lines(page).first()).toContainText('10 entities');
    await expect(lines(page).first()).toContainText('1 hidden by filters');
    await expect(lines(page).nth(1)).toContainText('9 shown');
    await expect(results(page)).toContainText('9 of 10 match · exact · 1 hidden');
    await expect(page.getByText('7 of 13 relationships match')).toBeVisible();

    const reset = page.getByRole('button', { name: 'Reset time window' });
    await reset.focus();
    await page.keyboard.press('Enter');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '10');
    await expect(lines(page).first()).not.toContainText('hidden by filters');
    expect(apartFromInspector(requests)).toEqual([]);
  });

  test('is disabled with its reason when the mapping has no relationship type with a time', async ({ page }) => {
    await page.goto('/dev/frame-sample');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '10');
    await filtersButton(page).click();
    await expect(windowSelect(page, 'Time window · UTC')).toBeDisabled();
    await expect(page.getByText('No relationship type in the mapping has a time')).toBeVisible();
  });
});
