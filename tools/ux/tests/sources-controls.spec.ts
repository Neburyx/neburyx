import { expect, test, type Page } from '@playwright/test';
import { lookOf, tokenColour, focusWidth } from './support/controls.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

const OUTLINE = ['outline-style', 'outline-width', 'outline-color'] as const;

async function expectSecondary(page: Page, name: string): Promise<void> {
  const retry = page.getByRole('button', { name });
  await expect(retry).toBeVisible();
  expect(await lookOf(retry)).toMatchObject({ 'background-color': await tokenColour(page, '--color-surface'), 'border-top-color': await tokenColour(page, '--color-control-border'), color: await tokenColour(page, '--color-text'), height: '34px' });
}

test.describe('the controls of Sources and of the failure pages', () => {
  test('keeps the source list items square, full width and drawn as before, the chosen one with the accent stripe', async ({ page }) => {
    await page.goto('/sources');
    const items = page.locator('.source-list button');
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThan(1);
    const [first, second] = [await lookOf(items.nth(0)), await lookOf(items.nth(1))];
    for (const look of [first, second]) expect(look).toMatchObject({ 'border-top-left-radius': '0px', 'border-top-width': '0px', 'border-bottom-width': '1px', cursor: 'pointer', display: 'flex' });
    expect(first).toMatchObject({ 'background-color': await tokenColour(page, '--color-accent-surface'), 'border-left-width': '2px', color: await tokenColour(page, '--color-accent') });
    expect(second).toMatchObject({ 'background-color': await tokenColour(page, '--color-surface'), 'border-left-width': '0px' });
  });

  test('draws Test source primary and the Diagnostics bundle secondary and disabled, and gives each control of the page the focus outline', async ({ page }) => {
    await page.goto('/sources');
    const test = page.getByRole('button', { name: 'Test source' });
    await expect(test).toBeVisible();
    expect((await lookOf(test))['background-color']).toBe(await tokenColour(page, '--color-accent'));
    const bundle = page.getByRole('button', { name: 'Diagnostics bundle' });
    expect(await lookOf(bundle)).toMatchObject({ 'background-color': await tokenColour(page, '--color-surface-muted'), cursor: 'default' });
    const focus = await tokenColour(page, '--color-focus');
    const items = page.locator('.source-list button');
    await items.first().focus();
    for (const control of [items.nth(1), items.nth(2), test]) {
      await page.keyboard.press('Tab');
      await expect(control).toBeFocused();
      expect(await lookOf(control, OUTLINE)).toEqual({ 'outline-style': 'solid', 'outline-width': await focusWidth(page), 'outline-color': focus });
    }
  });

  test('draws the Try again of a failed sources read and of a failed mapping example as secondary buttons', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/sources', (route) => route.abort());
    await page.goto('/sources');
    await expectSecondary(page, 'Try again');
    await page.unroute((url) => url.pathname === '/v1/sources');
    const isProfile = (url: URL): boolean => /^\/v1\/sources\/[^/]+\/profile$/.test(url.pathname);
    await page.route(isProfile, (route) => route.abort());
    await page.goto('/sources');
    await expectSecondary(page, 'Try again');
    expect((await page.getByRole('button', { name: 'Try again' }).boundingBox())?.width ?? Infinity, 'the retry is as wide as its label, not the section').toBeLessThan(200);
    await page.unroute(isProfile);
  });

  test('draws the Try again of the deep-link failure as a secondary button', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/investigations' && url.search === '', (route) => route.abort());
    await page.goto('/banking-demo/entity/account/CTL-1');
    await expectSecondary(page, 'Try again');
  });

  test('draws the Try again of the Explore failure as a secondary button', async ({ page }) => {
    await page.goto(`/banking-demo/entity/account/CTL-${String(Date.now()).slice(-6)}`);
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    const path = new URL(page.url()).pathname;
    await page.route((url) => url.pathname === path.replace('/explore/', '/v1/investigations/'), (route) => route.abort());
    await page.reload();
    await expectSecondary(page, 'Try again');
  });
});
