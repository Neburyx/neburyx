import { expect, test, type Page } from '@playwright/test';
import { apartFromInspector, canvasOf, openSample } from './support/workspace.ts';

const filtersButton = (page: Page) => page.getByRole('group', { name: 'Tools' }).getByRole('button', { name: 'Filters' });
const ledgerButton = (page: Page) => page.getByRole('button', { name: /Ledger status · property filter/ });
const ledgerList = (page: Page) => page.getByRole('group', { name: /Ledger status · property filter/ });
const lines = (page: Page) => page.locator('.graph-scope p');

test.describe('property filters', () => {
  let requests: string[] = [];

  test.beforeEach(async ({ page }) => {
    requests = [];
    await openSample(page);
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/v1/')) requests.push(`${request.method()} ${pathname}`);
    });
    await filtersButton(page).click();
  });

  test('lists the loaded values of a property, narrows the entities of its type, counts them the same on the canvas and the scope line, and resets', async ({ page }) => {
    await expect(ledgerButton(page)).toHaveText('Any');
    await ledgerButton(page).click();
    await expect(ledgerList(page).getByRole('checkbox')).toHaveText(['Live', 'Review required']);
    await ledgerList(page).getByRole('checkbox', { name: 'Live' }).click();
    await expect(ledgerButton(page)).toHaveText('Live');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '9');
    await expect(lines(page).first()).toContainText('1 hidden by filters');
    await expect(page.getByRole('status').filter({ hasText: 'match · exact' })).toContainText('9 of 10 match · exact · 1 hidden');
    await expect(page.getByText('Property filters apply to loaded items only.')).toBeVisible();
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '10');
    expect(apartFromInspector(requests)).toEqual([]);
  });

  test('is reached by keyboard: Enter opens the list, Space chooses, and Escape closes the list before the panel', async ({ page }) => {
    await ledgerButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(ledgerButton(page)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('searchbox', { name: 'Find a value' })).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '9');
    await page.keyboard.press('Escape');
    await expect(ledgerButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(ledgerButton(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(filtersButton(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('is disabled while the chip of its type is off', async ({ page }) => {
    await page.getByRole('group', { name: 'Entity types' }).getByRole('button', { name: 'Ledger' }).click();
    await expect(ledgerButton(page)).toBeDisabled();
  });
});
