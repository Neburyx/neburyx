import { expect, test, type Locator } from '@playwright/test';
import { lookOf, tokenColour, tokenLength } from './support/controls.ts';
import { boxOf } from './support/regions.ts';
import { tabTo } from './support/workspace.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

const OUTLINE = ['outline-style', 'outline-width', 'outline-color'] as const;

async function overlaps(first: Locator, second: Locator): Promise<boolean> {
  const [a, b] = [await boxOf(first), await boxOf(second)];
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test.beforeEach(async ({ page }) => {
  // a real, connected source keeps `/` on Home whatever investigations other specs left or removed
  await page.request.post('/__support/sources', { data: { 'banking-demo': { synthetic: false } } });
});

test.afterEach(async ({ page }) => {
  await page.request.post('/__support/reset');
});

test.describe('the controls of Home', () => {
  test('draws the source selector, the search box and the Search button at one height, the token of the search row', async ({ page }) => {
    await page.goto('/');
    const row = page.getByRole('search');
    await expect(row.getByRole('combobox', { name: 'Source' })).toBeVisible();
    const expected = await tokenLength(page, '--search-height');
    const heights = [row.getByRole('combobox', { name: 'Source' }), row.getByRole('searchbox', { name: 'Search text' }), row.getByRole('button', { name: 'Search' })];
    for (const control of heights) expect((await lookOf(control, ['height']))['height']).toBe(expected);
    const accent = await tokenColour(page, '--color-accent');
    expect((await lookOf(row.getByRole('button', { name: 'Search' })))['background-color']).toBe(accent);
  });

  test('lays the deep-link prompt out with each label above its field, no control over another, the shared look on every field and the Open buttons primary', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open a deep link' }).click();
    const forms = [page.getByRole('form', { name: 'Open a link' }), page.getByRole('form', { name: 'Open by parts' })];
    const accent = await tokenColour(page, '--color-accent');
    const border = await tokenColour(page, '--color-control-border');
    const controls: Locator[] = [];
    for (const form of forms) {
      await expect(form).toBeVisible();
      const inputs = form.locator('input');
      const total = await inputs.count();
      for (let index = 0; index < total; index += 1) {
        const field = inputs.nth(index);
        controls.push(field);
        const look = await lookOf(field);
        expect(look['border-top-color']).toBe(border);
        expect(look['height']).toBe('34px');
        const [label, input] = [await boxOf(field.locator('xpath=..')), await boxOf(field)];
        expect(label.height, 'the label text sits above its field').toBeGreaterThan(input.height + 4);
      }
      const open = form.getByRole('button', { name: 'Open' });
      controls.push(open);
      expect((await lookOf(open))['background-color']).toBe(accent);
    }
    for (const [first, one] of controls.entries()) for (const [second, other] of controls.entries()) if (second > first) expect(await overlaps(one, other), `control ${first} over control ${second}`).toBe(false);
  });

  test('draws the focus outline on each control of the search row, the entry actions and the prompt, in the order of the markup', async ({ page }) => {
    await page.goto(`/banking-demo/entity/account/HC-${String(Date.now()).slice(-8)}`);
    await page.request.post('/__support/sources', { data: { 'banking-demo': { demoCase: { entityType: 'account', stableId: 'DEMO-1', caseRef: 'REF-DEMO-1' } } } });
    await page.goto('/');
    const focus = await tokenColour(page, '--color-focus');
    await page.getByRole('button', { name: 'Open a deep link' }).click();
    const order = [page.getByRole('combobox', { name: 'Source' }), page.getByRole('searchbox', { name: 'Search text' }), page.getByRole('button', { name: 'Search' }), page.getByRole('button', { name: 'Open a deep link' }), page.getByRole('button', { name: 'Open the demo case' }), page.getByRole('form', { name: 'Open a link' }).getByLabel('Link', { exact: true }), page.getByRole('form', { name: 'Open a link' }).getByRole('button', { name: 'Open' }), page.getByRole('form', { name: 'Open by parts' }).getByLabel('Source', { exact: true })];
    await order[0]?.focus();
    for (const [index, control] of order.entries()) {
      if (index > 0) await page.keyboard.press('Tab');
      await expect(control, `stop ${index}`).toBeFocused();
      expect(await lookOf(control, OUTLINE), `stop ${index}`).toEqual({ 'outline-style': 'solid', 'outline-width': '3px', 'outline-color': focus });
    }
  });

  test('draws the retry of a failed list as a secondary button and keeps the rest of Home on screen', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/investigations', (route) => route.abort());
    await page.goto('/');
    const retry = page.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeVisible();
    const look = await lookOf(retry);
    expect(look['background-color']).toBe(await tokenColour(page, '--color-surface'));
    expect(look['border-top-color']).toBe(await tokenColour(page, '--color-control-border'));
    await expect(page.getByRole('search')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open a deep link' })).toBeVisible();
  });
  test('draws the Try again of the source health card, and of the search row, as secondary buttons when the sources could not be read', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/sources', (route) => route.abort());
    await page.goto('/');
    const retries = page.getByRole('button', { name: 'Try again' });
    await expect(retries.first()).toBeVisible();
    const count = await retries.count();
    expect(count).toBeGreaterThanOrEqual(2);
    const [surface, border] = [await tokenColour(page, '--color-surface'), await tokenColour(page, '--color-control-border')];
    for (let index = 0; index < count; index += 1) expect(await lookOf(retries.nth(index))).toMatchObject({ 'background-color': surface, 'border-top-color': border, height: '34px' });
    await expect(page.getByRole('region', { name: /health/i }).getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

