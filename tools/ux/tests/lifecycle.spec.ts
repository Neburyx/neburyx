import { expect, test, type Page } from '@playwright/test';

async function openInvestigation(page: Page): Promise<string> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop() ?? '';
}

const menuButton = (page: Page) => page.getByRole('button', { name: 'Investigation menu' });
const banner = (page: Page) => page.getByRole('region', { name: 'Request status' });
const header = (page: Page) => page.getByRole('banner', { name: 'Investigation' });

test.describe('closing, archiving, reopening and renaming an investigation', () => {
  test('lists Rename, Close and Archive for an open investigation, and closes it from the menu with the keyboard', async ({ page }) => {
    await openInvestigation(page);
    await expect(banner(page)).toHaveCount(0);
    await menuButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Close', 'Archive']);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(header(page).getByText('Closed · read-only')).toBeVisible();
    await expect(banner(page)).toContainText('This investigation is closed and read-only.');
    await expect(banner(page)).toContainText('Reopen it to make changes. Its named views and notes are kept.');
    await expect(menuButton(page)).toBeFocused();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('account AC-1');
  });

  test('reopens a closed investigation from the banner with the keyboard, and the Closed pill and banner go', async ({ page }) => {
    await openInvestigation(page);
    await menuButton(page).click();
    await page.getByRole('menuitem', { name: 'Close' }).click();
    await expect(banner(page)).toBeVisible();
    await page.getByRole('button', { name: 'Reopen' }).focus();
    await page.keyboard.press('Enter');
    await expect(banner(page)).toHaveCount(0);
    await expect(header(page).getByText('Unsaved')).toBeVisible();
    await menuButton(page).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Close', 'Archive']);
  });

  test('shows an archived investigation with its banner and no action, and a disabled Rename in its menu', async ({ page }) => {
    await openInvestigation(page);
    await menuButton(page).click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    await expect(header(page).getByText('Archived · read-only')).toBeVisible();
    await expect(banner(page)).toContainText('This investigation is archived and read-only.');
    await expect(banner(page)).toContainText('Archived investigations are hidden from the list by default.');
    await expect(banner(page).getByRole('button')).toHaveCount(0);
    await menuButton(page).click();
    await expect(page.getByRole('menuitem', { name: /Rename/ })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('menu')).toContainText('Reopen to rename.');
    await expect(page.getByRole('menuitem', { name: 'Reopen', exact: true })).toBeVisible();
  });

  test('shows a closed investigation as closed again after a reload', async ({ page }) => {
    const id = await openInvestigation(page);
    await menuButton(page).click();
    await page.getByRole('menuitem', { name: 'Close' }).click();
    await expect(banner(page)).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(new RegExp(id));
    await expect(header(page).getByText('Closed · read-only')).toBeVisible();
    await expect(banner(page)).toContainText('This investigation is closed and read-only.');
  });

  test('shows an investigation closed in another tab as closed after a reload', async ({ page }) => {
    const id = await openInvestigation(page);
    expect((await page.request.post('/__support/set-status', { data: { id, status: 'closed' } })).status()).toBe(200);
    await page.reload();
    await expect(header(page).getByText('Closed · read-only')).toBeVisible();
  });

  test('renames in a dialog: the name is described by the hint, Esc sends nothing, and the new title shows in the header', async ({ page }) => {
    await openInvestigation(page);
    await menuButton(page).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename investigation' });
    const name = dialog.getByRole('textbox', { name: 'Name' });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('account AC-1');
    await expect(dialog).toContainText("Don't type customer names; others may see this text.");
    await expect(dialog.getByRole('button', { name: 'Rename' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(menuButton(page)).toBeFocused();

    await menuButton(page).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await name.fill('');
    await expect(dialog.getByRole('button', { name: 'Rename' })).toBeDisabled();
    await expect(dialog).toContainText('Enter a name.');
    await name.fill('Mule ring');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mule ring');
    await expect(menuButton(page)).toBeFocused();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mule ring');
  });
});
