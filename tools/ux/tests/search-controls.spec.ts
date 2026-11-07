import { expect, test, type Page } from '@playwright/test';
import { lookOf, tokenColour, tokenLength } from './support/controls.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

const OUTLINE = ['outline-style', 'outline-width', 'outline-color'] as const;

async function searchFor(page: Page, text: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Search text' }).fill(text);
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page).toHaveURL(/\/search\?source=/);
  await page.waitForLoadState('networkidle');
  await page.mouse.move(0, 0);
}

test.describe('the controls of the Search results page', () => {
  test('draws the source selector, the search box and the Search button at the height of the search row, with Search primary', async ({ page }) => {
    await searchFor(page, 'AC-1');
    const row = page.getByRole('search');
    await expect(row.getByRole('combobox', { name: 'Source' })).toBeVisible();
    const expected = await tokenLength(page, '--search-height');
    for (const control of [row.getByRole('combobox', { name: 'Source' }), row.getByRole('searchbox', { name: 'Search text' }), row.getByRole('button', { name: 'Search' })]) expect((await lookOf(control, ['height']))['height']).toBe(expected);
    expect((await lookOf(row.getByRole('button', { name: 'Search' })))['background-color']).toBe(await tokenColour(page, '--color-accent'));
  });

  test('draws Open in graph as accent text with no border and no fill, and gives it the focus outline when a keyboard reaches it', async ({ page }) => {
    await searchFor(page, 'AC-1');
    const open = page.getByRole('button', { name: /^Open in graph/ }).first();
    await expect(open).toBeVisible();
    expect(await lookOf(open)).toMatchObject({ 'border-top-width': '0px', 'background-color': 'rgba(0, 0, 0, 0)', color: await tokenColour(page, '--color-accent') });
    await page.getByRole('searchbox', { name: 'Search text' }).focus();
    for (let press = 0; press < 2; press += 1) await page.keyboard.press('Tab');
    await expect(open).toBeFocused();
    expect(await lookOf(open, OUTLINE)).toEqual({ 'outline-style': 'solid', 'outline-width': '3px', 'outline-color': await tokenColour(page, '--color-focus') });
  });

  test('draws the Retry of a failed group and the Open in graph of a related row as accent text, like the other search buttons', async ({ page }) => {
    await searchFor(page, 'relfail-1');
    const accent = await tokenColour(page, '--color-accent');
    expect(await lookOf(page.getByRole('button', { name: 'Retry' }))).toMatchObject({ 'border-top-width': '0px', 'background-color': 'rgba(0, 0, 0, 0)', color: accent });
    await searchFor(page, 'rel-2');
    const rows = page.getByRole('button', { name: /^Open in graph/ });
    await expect(rows).toHaveCount(3);
    for (let index = 0; index < 3; index += 1) expect(await lookOf(rows.nth(index))).toMatchObject({ 'border-top-width': '0px', color: accent });
  });

  test('draws the Retry of a failed evidence group as accent text, like the other search buttons', async ({ page }) => {
    await searchFor(page, 'evfail-1');
    expect(await lookOf(page.getByRole('button', { name: 'Retry' }))).toMatchObject({ 'border-top-width': '0px', 'background-color': 'rgba(0, 0, 0, 0)', color: await tokenColour(page, '--color-accent') });
  });

  test('draws the Retry of a failed search as link-style text and keeps the form on screen', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/search/entities', (route) => route.abort());
    await searchFor(page, 'AC-1');
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    expect(await lookOf(retry)).toMatchObject({ 'border-top-width': '0px', color: await tokenColour(page, '--color-accent') });
    await expect(page.getByRole('searchbox', { name: 'Search text' })).toHaveValue('AC-1');
  });

  test('draws the Try again of a failed profile read as a secondary button', async ({ page }) => {
    await page.route((url) => /^\/v1\/sources\/[^/]+\/profile$/.test(url.pathname), (route) => route.abort());
    await searchFor(page, 'AC-1');
    const retry = page.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeVisible();
    expect(await lookOf(retry)).toMatchObject({ 'background-color': await tokenColour(page, '--color-surface'), 'border-top-color': await tokenColour(page, '--color-control-border') });
  });
});
