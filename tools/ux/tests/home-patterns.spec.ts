import { expect, test, type Page } from '@playwright/test';
import { openOneEntity } from './support/workspace.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

const chooserOf = (page: Page) => page.getByRole('combobox', { name: 'Patterns for' });
const cardOf = (page: Page) => page.getByRole('region', { name: 'Start from a pattern' });
const libraryOf = (page: Page) => page.getByRole('group', { name: 'Library' }).locator('.library-card', { has: page.getByRole('heading', { name: 'Patterns' }) });
const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Patterns' });
const homeLink = (page: Page) => page.getByRole('link', { name: 'Home' }).first();

/** An investigation exists, so that Home is the start page; a full load then holds none. */
async function homeWithNothingHeld(page: Page): Promise<void> {
  await openOneEntity(page, 'banking-demo', 'AC-1');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
}

test.describe('Home: Start from a pattern', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/__support/patterns-mode', { data: { noPresets: false } });
  });

  test.afterEach(async ({ page }) => {
    await page.request.post('/__support/patterns-mode', { data: { noPresets: false } });
  });

  test('asks for a source, then lists exactly the presets of each pack and the number on the Patterns card', async ({ page }) => {
    await homeWithNothingHeld(page);
    await expect(cardOf(page).getByRole('button', { name: /^Run / })).toHaveCount(0);
    await expect(libraryOf(page).locator('.library-figure')).toHaveCount(0);
    await chooserOf(page).selectOption('banking-demo');
    await expect(cardOf(page).getByRole('listitem')).toHaveText(['Shared devicesRun →', 'Shared addressesRun →', 'Connected accountsRun →']);
    await expect(libraryOf(page).locator('.library-figure')).toHaveText('3');
    await expect(libraryOf(page).getByText('Approved, no query language')).toBeVisible();
    await chooserOf(page).selectOption('claims-demo');
    await expect(cardOf(page).getByRole('listitem')).toHaveText(['Shared addressesRun →', 'Claims by claimantRun →']);
    await expect(libraryOf(page).locator('.library-figure')).toHaveText('2');
    await expect(page.getByText('are not available yet')).toHaveCount(0);
  });

  test('says the source has no patterns, with 0 on the Patterns card, and offers no Run', async ({ page }) => {
    await page.request.post('/__support/patterns-mode', { data: { noPresets: true } });
    await homeWithNothingHeld(page);
    await chooserOf(page).selectOption('banking-demo');
    await expect(cardOf(page).getByText('This source has no patterns.')).toBeVisible();
    await expect(cardOf(page).getByRole('button', { name: /^Run / })).toHaveCount(0);
    await expect(libraryOf(page).locator('.library-figure')).toHaveText('0');
  });

  test('is reached and operated from the keyboard, and opens the panel on the pattern with the focus on it', async ({ page }) => {
    await homeWithNothingHeld(page);
    await chooserOf(page).selectOption('banking-demo');
    await chooserOf(page).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Run Shared devices' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Run Shared addresses' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(chooserOf(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.recent :focus')).toHaveCount(1);
    await page.getByRole('button', { name: 'Run Shared addresses' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Run Connected accounts' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('region', { name: 'Source health' }).locator(':focus')).toHaveCount(1);
    await page.getByRole('button', { name: 'Run Shared addresses' }).focus();
    await page.keyboard.press('Enter');
    await expect(panelOf(page)).toBeVisible();
    await expect(page).toHaveURL(/\/explore$/);
    await expect(panelOf(page).getByRole('radio', { name: 'Shared addresses' })).toBeFocused();
  });

  test('opens bare Explore with no starting entity, which is chosen through the panel search, and runs the pattern once', async ({ page }) => {
    await homeWithNothingHeld(page);
    const rowsBefore = await page.locator('.recent-row').count();
    await chooserOf(page).selectOption('banking-demo');
    await page.getByRole('button', { name: 'Run Shared devices' }).click();
    await expect(panelOf(page)).toBeVisible();
    await expect(page).toHaveURL(/\/explore$/);
    await expect(panelOf(page).getByRole('radio', { name: 'Shared devices' })).toHaveAttribute('aria-checked', 'true');
    await expect(panelOf(page).getByText(/to run this pattern\./)).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Run pattern' })).toBeDisabled();
    const runs: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'POST' && /^\/v1\/templates\/[^/]+\/run$/.test(pathname)) runs.push(pathname);
    });
    await panelOf(page).getByRole('searchbox', { name: 'Search the source' }).fill('AC-1');
    await panelOf(page).getByLabel('Starting account').selectOption({ label: 'account AC-1' });
    await panelOf(page).getByRole('button', { name: 'Run pattern' }).click();
    await expect(panelOf(page).getByRole('table').getByRole('row')).toHaveCount(6);
    expect(runs).toHaveLength(1);
    await homeLink(page).click();
    await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
    expect(await page.locator('.recent-row').count()).toBe(rowsBefore);
  });

  test('leaves nothing behind when bare Explore is left: Home asks for a source again', async ({ page }) => {
    await homeWithNothingHeld(page);
    await chooserOf(page).selectOption('banking-demo');
    await page.getByRole('button', { name: 'Run Connected accounts' }).click();
    await expect(panelOf(page)).toBeVisible();
    await homeLink(page).click();
    await expect(chooserOf(page)).toBeVisible();
    await expect(chooserOf(page)).toHaveValue('');
    await expect(cardOf(page).getByRole('button', { name: /^Run / })).toHaveCount(0);
  });

  test('opens on the held investigation, kept, with the panel on the pattern and the opened entity as the starting entity', async ({ page }) => {
    await openOneEntity(page, 'banking-demo', 'AC-1');
    const address = page.url();
    await homeLink(page).click();
    await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
    await expect(chooserOf(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Run Shared addresses' }).click();
    await expect(page).toHaveURL(address);
    await expect(panelOf(page).getByRole('radio', { name: 'Shared addresses' })).toHaveAttribute('aria-checked', 'true');
    await expect(panelOf(page).getByLabel('Starting account')).toHaveValue(/AC-1/);
  });
});
