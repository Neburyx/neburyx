import { expect, test, type Page } from '@playwright/test';

async function openInvestigation(page: Page, stableId = 'AC-1'): Promise<string> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill(stableId);
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop() ?? '';
}

const menuButton = (page: Page) => page.getByRole('button', { name: 'Investigation menu' });
const header = (page: Page) => page.getByRole('banner', { name: 'Investigation' });
const saveDialog = (page: Page) => page.getByRole('dialog', { name: 'Save investigation' });
const panel = (page: Page) => page.getByRole('dialog', { name: /^Views/ });
const deleteDialog = (page: Page) => page.getByRole('dialog', { name: 'Delete this investigation?' });

async function saveAs(page: Page, name: string): Promise<void> {
  await header(page).getByRole('button', { name: 'Save' }).click();
  await saveDialog(page).getByLabel('Name').fill(name);
  await saveDialog(page).getByRole('button', { name: 'Save investigation' }).click();
  await expect(saveDialog(page)).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.request.post('/__support/forget-investigations');
});

test.describe('deleting and restoring an investigation', () => {
  test('asks first with the focus on Cancel, deletes from the menu with the keyboard, lands on the Investigations page with the date, and lists it under Deleted', async ({ page }) => {
    const id = await openInvestigation(page);
    await menuButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Close', 'Archive', 'Delete']);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(deleteDialog(page)).toBeVisible();
    await expect(deleteDialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(deleteDialog(page)).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();
    await menuButton(page).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await deleteDialog(page).getByRole('button', { name: 'Delete investigation' }).click();
    await expect(page).toHaveURL(/\/investigations$/);
    await expect(page.getByRole('status').filter({ hasText: /Investigation deleted\. Restorable until \d+ \w+ \d{4} \d\d:\d\d UTC\./ })).toBeVisible();
    expect((await page.request.get(`/v1/investigations/${id}`)).status()).toBe(404);
    await page.getByRole('button', { name: 'Deleted' }).click();
    await expect(page).toHaveURL(/deleted=1/);
    await expect(page.getByRole('columnheader', { name: 'Purges on (UTC)' })).toBeVisible();
    await expect(page.getByText('account AC-1')).toBeVisible();
    await expect(page.getByRole('link', { name: 'account AC-1' })).toHaveCount(0);
  });

  test('restores a deleted investigation from the Deleted view, and it opens again', async ({ page }) => {
    const id = await openInvestigation(page);
    await menuButton(page).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await deleteDialog(page).getByRole('button', { name: 'Delete investigation' }).click();
    await expect(page).toHaveURL(/\/investigations$/);
    await page.goto('/investigations?deleted=1');
    await page.getByRole('button', { name: /^Restore/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('No deleted investigations.')).toBeVisible();
    await page.goto(`/explore/${id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('account AC-1');
  });

  test('deletes from a row of the Investigations page, and the row is gone from the list', async ({ page }) => {
    await page.request.post('/__support/seed-investigations', { data: { count: 3, sourceId: 'banking-demo', viewEvery: 0 } });
    await page.goto('/investigations');
    await page.getByRole('button', { name: 'Actions for Case 2', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('dialog', { name: 'Delete this investigation?' }).getByRole('button', { name: 'Delete investigation' }).click();
    await expect(page.getByRole('link', { name: 'Case 2', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Investigations (2)' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Case 3', exact: true })).toBeFocused();
  });
});

test.describe('deleting a named view', () => {
  test('deletes the view the draft is based on from the Views panel with a note, and the header reads Unsaved', async ({ page }) => {
    await openInvestigation(page);
    await saveAs(page, 'First look');
    await expect(header(page).getByText(/^Saved \d\d:\d\d UTC$/)).toBeVisible();
    await header(page).getByRole('button', { name: /^Views/ }).click();
    await panel(page).getByRole('button', { name: 'Delete First look' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete “First look”?' });
    await expect(dialog.getByLabel('Note (optional)')).toBeFocused();
    await expect(dialog).toContainText("The view is deleted and can't be restored. Your draft is not changed.");
    await dialog.getByLabel('Note (optional)').fill('Duplicate of the review view');
    await dialog.getByRole('button', { name: 'Delete view' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel(page).getByRole('heading', { name: 'Views · 0' })).toBeVisible();
    await expect(panel(page).getByText('No named views yet.')).toBeFocused();
    await expect(panel(page).getByText('View deleted.')).toBeVisible();
    await expect(header(page).getByText('Unsaved')).toBeVisible();
  });

  test('deletes a view from the Saved views tab, and the count goes down', async ({ page }) => {
    await page.request.post('/__support/seed-investigations', { data: { count: 3, sourceId: 'banking-demo', viewEvery: 1 } });
    await page.goto('/investigations?tab=views');
    const first = page.getByRole('button', { name: /^Delete “Saved state 1”/ });
    await first.click();
    const dialog = page.getByRole('dialog', { name: /^Delete “Saved state 1” from/ });
    await dialog.getByRole('button', { name: 'Delete view' }).click();
    await expect(page.getByRole('button', { name: /^Delete “Saved state 1”/ })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Saved views (2)' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'View deleted.' })).toBeVisible();
  });
  test('shows why Delete is off on a closed investigation, with the actions side by side at 1280 and 1440', async ({ page }) => {
    await page.request.post('/__support/seed-investigations', { data: { count: 2, sourceId: 'banking-demo', viewEvery: 1 } });
    const listed = (await (await page.request.get('/v1/investigations')).json()) as { items: { id: string }[] };
    const closedId = listed.items[0]?.id ?? '';
    expect((await page.request.post('/__support/set-status', { data: { id: closedId, status: 'closed' } })).status()).toBe(200);
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/investigations?tab=views');
      const rows = page.getByRole('row').filter({ has: page.getByRole('button', { name: /^Delete “/ }) });
      await expect(rows).toHaveCount(2);
      const reason = page.getByText('This investigation is closed. Reopen it to delete its views.');
      await expect(reason).toBeVisible();
      await expect(reason).toHaveCount(1);
      const disabled = page.locator('button:disabled', { hasText: 'Delete' });
      await expect(disabled).toHaveCount(1);
      await expect(disabled).toHaveAttribute('aria-describedby', (await reason.getAttribute('id')) ?? '');
      for (let index = 0; index < 2; index += 1) {
        const row = rows.nth(index);
        const open = await row.getByRole('button', { name: /^Open/ }).boundingBox();
        const remove = await row.getByRole('button', { name: /^Delete “/ }).boundingBox();
        const cell = await row.locator('td.investigations-actions').boundingBox();
        if (open === null || remove === null || cell === null) throw new Error('a button or the cell has no box');
        expect(open.x).toBeGreaterThanOrEqual(cell.x);
        expect(remove.x + remove.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
        expect(Math.abs(open.y - remove.y)).toBeLessThan(2);
        expect(remove.x).toBeGreaterThan(open.x + open.width);
      }
      const contrast = await reason.evaluate((element) => {
        const channels = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const luminance = ([r, g, b]: number[]): number => {
          const lin = (c: number): number => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(b ?? 0);
        };
        const fore = luminance(channels(getComputedStyle(element).color));
        let surface: Element | null = element;
        while (surface !== null && /rgba\(.*, 0\)$|transparent/.test(getComputedStyle(surface).backgroundColor)) surface = surface.parentElement;
        const back = luminance(channels(getComputedStyle(surface ?? document.body).backgroundColor));
        return (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05);
      });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  });
});
