import { expect, test, type Page } from '@playwright/test';
import { apartFromInspector, canvasOf, openSample } from './support/workspace.ts';

const lines = (page: Page) => page.locator('.graph-scope p');
const panel = (page: Page) => page.getByRole('group', { name: 'Entity types' });
const filtersButton = (page: Page) => page.getByRole('group', { name: 'Tools' }).getByRole('button', { name: 'Filters' });

test.describe('type filters', () => {
  let requests: string[] = [];

  test.beforeEach(async ({ page }) => {
    requests = [];
    await openSample(page);
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/v1/')) requests.push(`${request.method()} ${pathname}`);
    });
  });

  test('opens on the first chip, switches a type off from the keyboard, counts it, and resets', async ({ page }) => {
    await filtersButton(page).click();
    await expect(filtersButton(page)).toHaveAttribute('aria-pressed', 'true');
    const chips = panel(page).getByRole('button');
    await expect(chips.first()).toBeFocused();
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('Space');
    await expect(chips.first()).toHaveAttribute('aria-pressed', 'false');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '8');
    await expect(lines(page).first()).toContainText('2 hidden by filters');
    await expect(lines(page).nth(1)).toContainText('8 shown');
    await expect(page.getByRole('status').filter({ hasText: 'match · exact' })).toContainText('8 of 10 match · exact · 2 hidden');

    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '10');
    await expect(lines(page).first()).not.toContainText('hidden by filters');
    await expect(chips.first()).toBeFocused();
    expect(apartFromInspector(requests)).toEqual([]);
  });

  test('reaches a chip by Tab, and counts an entity hidden by hand and filtered once', async ({ page }) => {
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('Delete');
    await expect(lines(page).first()).toContainText('1 hidden from view');
    await filtersButton(page).click();
    const chips = panel(page).getByRole('button');
    await page.keyboard.press('Tab');
    await expect(chips.nth(1)).toBeFocused();
    await chips.first().click();
    await chips.nth(1).click();
    const text = (await lines(page).first().textContent()) ?? '';
    const number = (pattern: RegExp): number => Number(pattern.exec(text)?.[1] ?? 0);
    const byHand = number(/(\d+) hidden from view/);
    const byFilters = number(/(\d+) hidden by filters/);
    const drawn = Number(await canvasOf(page).getAttribute('data-drawn-entities'));
    expect(byHand).toBe(1);
    expect(byHand + byFilters + drawn).toBe(10);
    await expect(lines(page).nth(1)).toContainText(`${drawn} shown`);
    expect(apartFromInspector(requests)).toEqual([]);
  });

  test('closes on Escape and gives the focus back to its button, and keeps what was switched off', async ({ page }) => {
    await filtersButton(page).click();
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(filtersButton(page)).toBeFocused();
    await expect(filtersButton(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '8');
    expect(apartFromInspector(requests)).toEqual([]);
  });

  test('draws one tool active at a time when the Explore flyout opens over the panel', async ({ page }) => {
    await filtersButton(page).click();
    const active = page.getByRole('group', { name: 'Tools' }).locator('[data-active="true"]');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveAttribute('aria-label', 'Filters');
    await page.getByRole('group', { name: 'Tools' }).getByRole('button', { name: 'Explore' }).click();
    await expect(active).toHaveCount(1);
    await expect(active).toHaveAttribute('aria-label', 'Explore');
  });
});
