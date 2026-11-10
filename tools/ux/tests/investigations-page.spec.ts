import { expect, test, type Page } from '@playwright/test';

async function seed(page: Page, count = 60, viewEvery = 10): Promise<void> {
  await page.request.post('/__support/forget-investigations');
  const made = await page.request.post('/__support/seed-investigations', { data: { count, sourceId: 'banking-demo', viewEvery } });
  expect(made.ok()).toBe(true);
}

const rows = (page: Page) => page.locator('.investigations-table tbody tr');
const status = (page: Page) => page.locator('.investigations-status');

test.afterEach(async ({ page }) => {
  await page.request.post('/__support/forget-investigations');
});

test.describe('the Investigations page', () => {
  test('reaches all 60 investigations page by page, from the keyboard, with the focus on the first new row', async ({ page }) => {
    await seed(page);
    await page.goto('/investigations');
    await expect(rows(page)).toHaveCount(25);
    await expect(status(page)).toHaveText('Showing 25 of 60');
    await expect(page.getByRole('tab', { name: 'Investigations (60)' })).toBeVisible();
    const more = page.getByRole('button', { name: 'Show more' });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(rows(page)).toHaveCount(50);
    await expect(page.getByRole('link', { name: 'Case 26', exact: true })).toBeFocused();
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(rows(page)).toHaveCount(60);
    await expect(status(page)).toHaveText('Showing 60 of 60');
    await expect(more).toHaveCount(0);
  });

  test('finds a case reference fragment and clears the filters from the keyboard', async ({ page }) => {
    await seed(page);
    await page.goto('/investigations');
    await expect(rows(page)).toHaveCount(25);
    const box = page.getByRole('searchbox', { name: 'Title or referral' });
    await box.fill('REF-2026-0042');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Case 42');
    await expect(page).toHaveURL(/q=REF-2026-0042/);
    await page.keyboard.press('Escape');
    await expect(rows(page)).toHaveCount(25);
    await box.fill('c');
    await expect(page.getByText('Type at least 2 characters.')).toBeVisible();
    await box.fill('zzzzz');
    await expect(page.getByText('No investigations match these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(rows(page)).toHaveCount(25);
  });

  test('closes an investigation from the row menu with the keyboard, says so, and puts the focus on the next row', async ({ page }) => {
    await seed(page);
    await page.goto('/investigations');
    await expect(rows(page)).toHaveCount(25);
    const button = page.getByRole('button', { name: 'Actions for Case 1', exact: true });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Open' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(status(page)).toHaveText('“Case 1” is closed. It is no longer in this list.');
    await expect(page.getByRole('link', { name: 'Case 2', exact: true })).toBeFocused();
    await page.getByRole('combobox', { name: 'Status' }).selectOption('closed');
    await expect(rows(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Actions for Case 1', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('menuitem', { name: 'Reopen', exact: true }).click();
    await expect(page.getByText(/No investigations/)).toBeVisible();
  });

  test('renames from the row menu and shows the new title', async ({ page }) => {
    await seed(page, 3, 0);
    await page.goto('/investigations');
    await page.getByRole('button', { name: 'Actions for Case 2', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename investigation' });
    await expect(dialog.getByText("Don't type customer names; others may see this text.")).toBeVisible();
    await dialog.getByRole('textbox').fill('Merchant dispute check');
    await dialog.getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByRole('link', { name: 'Merchant dispute check' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Actions for Merchant dispute check' })).toBeFocused();
  });

  test('reads the starting-entity labels after the rows are drawn without moving a row', async ({ page }) => {
    await seed(page, 5, 0);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route((url) => url.pathname === '/v1/graph/read-refs', async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto('/investigations');
    await expect(rows(page)).toHaveCount(5);
    const link = page.getByRole('link', { name: 'Case 2', exact: true });
    await link.focus();
    const before = await rows(page).evaluateAll((all) => all.map((row) => row.getBoundingClientRect().height));
    release();
    await expect(rows(page).first()).toContainText(/account/i);
    await expect(rows(page).first().locator('.investigations-entity-label')).not.toHaveText('');
    const after = await rows(page).evaluateAll((all) => all.map((row) => row.getBoundingClientRect().height));
    expect(after).toEqual(before);
    await expect(link).toBeFocused();
  });

  test('shows the Saved views tab from the keyboard and opens a view with the confirm', async ({ page }) => {
    await seed(page, 30, 10);
    await page.goto('/investigations');
    await expect(rows(page)).toHaveCount(25);
    const tabs = page.getByRole('tablist');
    await tabs.getByRole('tab', { name: /^Investigations/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Saved views (3)' })).toHaveAttribute('aria-selected', 'true');
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByText('A named view is a saved copy of exploration state.')).toBeVisible();
    await page.getByRole('button', { name: /Open “Saved state 10”/ }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Replace your draft?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  });

  test('shows the Evidence packs tab locked, with its reason, and sends no request for it', async ({ page }) => {
    await seed(page, 3, 0);
    await page.goto('/investigations');
    await page.waitForLoadState('networkidle');
    const seen: string[] = [];
    page.on('request', (request) => seen.push(new URL(request.url()).pathname));
    const tab = page.getByRole('tab', { name: /Evidence packs/ });
    await expect(tab).toHaveAttribute('aria-disabled', 'true');
    await tab.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Evidence packs are an Enterprise capability. They are not available in this edition.')).toBeVisible();
    expect(seen.filter((path) => path.startsWith('/v1/'))).toEqual([]);
  });

  test('shows a failed read with a retry and keeps the rows it has', async ({ page }) => {
    await seed(page, 60, 0);
    await page.goto('/investigations');
    await expect(rows(page)).toHaveCount(25);
    let blocking = true;
    await page.route((url) => url.pathname === '/v1/investigations' && url.search.includes('cursor='), (route) => (blocking ? route.abort() : route.continue()));
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(page.getByText('The next investigations could not be read.')).toBeVisible();
    await expect(rows(page)).toHaveCount(25);
    blocking = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(rows(page)).toHaveCount(50);
  });

  test('is reached from Home with its links and keeps the Home list to five', async ({ page }) => {
    await seed(page, 8, 2);
    await page.goto('/');
    await expect(page.locator('.recent-row')).toHaveCount(5);
    await page.getByRole('link', { name: 'View all' }).click();
    await expect(page).toHaveURL(/\/investigations$/);
    await expect(rows(page)).toHaveCount(8);
    await page.goto('/');
    await page.getByRole('link', { name: 'Saved views' }).click();
    await expect(page).toHaveURL(/\/investigations\?tab=views$/);
    await expect(rows(page)).toHaveCount(4);
  });
});
