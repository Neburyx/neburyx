import { expect, test } from '@playwright/test';
import { describeFinding, findDefaultLooks } from './support/default-look.ts';
import { PRODUCT_PAGES, REACH } from './support/product-pages.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

test.afterEach(async ({ page }) => {
  await page.request.post('/__support/reset');
});

test.describe('the check of the browser\'s default look', () => {
  test('has a way to reach every page and state of its list, and no other', () => {
    expect(PRODUCT_PAGES.length).toBeGreaterThan(0);
    expect(Object.keys(REACH).sort()).toEqual(PRODUCT_PAGES.map((item) => item.name).sort());
  });

  for (const { name } of PRODUCT_PAGES) {
    test(`no product page or state has a control with the browser's default look: ${name}`, async ({ page }) => {
      const reach = REACH[name];
      if (reach === undefined) throw new Error(`NO_WAY_TO_REACH: ${name}`);
      await reach(page);
      await page.mouse.move(0, 0);
      expect((await findDefaultLooks(page)).map((finding) => `${name}: ${describeFinding(finding)}`)).toEqual([]);
    });
  }

  test('finds a control that falls back to the browser look, whether its styles are reverted or its class has no rule, and names it', async ({ page }) => {
    await page.goto('/sources');
    await expect(page.getByRole('button', { name: 'Test source' })).toBeVisible();
    expect(await findDefaultLooks(page)).toEqual([]);
    await page.evaluate(() => {
      const holder = document.createElement('div');
      holder.innerHTML = '<button type="button" style="all: revert">Reverted</button><button type="button" class="only-for-layout">Layout class</button><select aria-label="Bare" style="all: revert"><option>x</option></select><input aria-label="Bare field" style="all: revert" />';
      document.querySelector('main')?.prepend(holder);
    });
    const found = await findDefaultLooks(page);
    expect(found.map((finding) => finding.control).sort()).toEqual(['button "Layout class"', 'button "Reverted"', 'input:text "Bare field"', 'select "Bare"']);
    expect(found.map(describeFinding).find((line) => line.includes('Layout class'))).toContain('with the class "only-for-layout"');
    expect(found.map(describeFinding).every((line) => line.includes('belongs on a wrapper'))).toBe(true);
  });

  test('treats an empty class as no class, and does not flag a checkbox or a hidden control', async ({ page }) => {
    await page.goto('/sources');
    await expect(page.getByRole('button', { name: 'Test source' })).toBeVisible();
    await page.evaluate(() => {
      const holder = document.createElement('div');
      holder.innerHTML = '<button type="button" class="">Empty class</button><input type="checkbox" aria-label="Box" /><button type="button" style="all: revert; display: none">Hidden</button>';
      document.querySelector('main')?.prepend(holder);
    });
    expect(await findDefaultLooks(page)).toEqual([]);
  });
});
