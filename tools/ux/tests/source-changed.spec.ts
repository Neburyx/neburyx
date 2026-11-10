import { expect, test, type Page } from '@playwright/test';

/** The routes that read the source: the page must not ask any of them while an investigation of a changed source is open. */
const SOURCE_READ = /\/v1\/(graph|entities|search|edges|source-links)\//;

const banner = (page: Page) => page.getByRole('region', { name: 'Request status' });
const header = (page: Page) => page.getByRole('banner', { name: 'Investigation' });

/** Opens an entity with a case reference the support server reads back as a changed source, and loads the page again so that the investigation is read as it is now. */
async function openChanged(page: Page, kind: 'repointed' | 'removed'): Promise<{ readonly id: string; readonly reads: string[] }> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByLabel('Case reference (optional)').fill(`${kind}-${Date.now()}`);
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  const id = page.url().split('/').pop() ?? '';
  // only what the page asks for after it is loaded again counts: the first open of the new investigation reads its entity
  const reads: string[] = [];
  page.on('request', (request) => {
    if (SOURCE_READ.test(new URL(request.url()).pathname)) reads.push(request.url());
  });
  await page.reload();
  return { id, reads };
}

test.describe('an investigation whose source was re-pointed', () => {
  test('opens read-only on its saved layout with the banner and the pill, and asks the source for nothing', async ({ page }) => {
    const { reads } = await openChanged(page, 'repointed');
    await expect(banner(page)).toContainText('This source now points to a different database.');
    await expect(banner(page)).toContainText('An operator must confirm the rebind. This investigation is read-only and runs no source reads.');
    await expect(header(page).getByText('Read-only', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('account AC-1');
    await expect(page.locator('[data-drawn-entities]')).toHaveAttribute('data-drawn-entities', '1');
    await expect(banner(page).getByRole('button')).toHaveCount(0);
    expect(reads).toEqual([]);
  });

  test('dims every tool, keeps them out of reach with the keyboard, and sends no read for any key', async ({ page }) => {
    const { reads } = await openChanged(page, 'repointed');
    const tools = page.getByRole('group', { name: 'Tools' }).getByRole('button');
    await expect(tools.first()).toBeVisible();
    for (const tool of await tools.all()) await expect(tool).toBeDisabled();
    await page.locator('[data-key-scope="canvas"]').first().focus();
    for (const key of ['Enter', 'Control+a', 'e', 'x', 'p', 'h', 'Escape', 'Control+f', 'Control+k', 'Meta+k']) await page.keyboard.press(key);
    await page.waitForTimeout(300);
    await expect(page.getByRole('tab', { name: 'Add' })).toHaveCount(0);
    await page.keyboard.type('a long enough search text');
    await page.waitForTimeout(600);
    expect(reads).toEqual([]);
  });

  test('keeps Close, Archive and Delete in the menu and dims Rename with its reason', async ({ page }) => {
    await openChanged(page, 'repointed');
    await page.getByRole('button', { name: 'Investigation menu' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['RenameNot available while the source has changed.', 'Close', 'Archive', 'Delete']);
    await expect(page.getByRole('menuitem', { name: /Rename/ })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('menu')).toContainText('Not available while the source has changed.');
  });

  test('is announced once in a polite region and moves no focus', async ({ page }) => {
    await openChanged(page, 'repointed');
    await expect(page.locator('.banner-region [aria-live="polite"]')).toContainText('Source re-pointed. This source now points to a different database.');
    await expect(page.locator('.banner-region [aria-live="assertive"]')).toHaveText('');
    await expect(banner(page)).not.toBeFocused();
  });

  test('shows the pill "Source re-pointed" in the Investigations list and on Home, and the row still opens', async ({ page }) => {
    const { id } = await openChanged(page, 'repointed');
    await page.goto('/investigations');
    const row = page.getByRole('row', { name: /account AC-1/ }).first();
    await expect(row).toContainText('Source re-pointed');
    await row.getByRole('link', { name: 'account AC-1' }).click();
    await expect(page).toHaveURL(new RegExp(id));
    await expect(banner(page)).toContainText('This source now points to a different database.');
    await page.goto('/');
    await expect(page.locator('.recent-row', { hasText: 'account AC-1' }).first()).toContainText('Source re-pointed');
  });
});

test.describe('an investigation whose source was removed', () => {
  test('opens read-only on its saved layout with the banner, the pill and Delete', async ({ page }) => {
    const { reads } = await openChanged(page, 'removed');
    await expect(banner(page)).toContainText('The source this investigation used is no longer configured.');
    await expect(banner(page)).toContainText('You can still see the saved layout. No source reads run. You can delete the investigation.');
    await expect(header(page).getByText('Read-only', { exact: true })).toBeVisible();
    await expect(banner(page).getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(page.locator('[data-drawn-entities]')).toHaveAttribute('data-drawn-entities', '1');
    expect(reads).toEqual([]);
  });

  test('deletes from the banner with the keyboard: the confirm opens on Cancel and Escape returns to Delete', async ({ page }) => {
    await openChanged(page, 'removed');
    await banner(page).getByRole('button', { name: 'Delete' }).focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(banner(page).getByRole('button', { name: 'Delete' })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Delete investigation' }).click();
    await expect(page).toHaveURL(/\/investigations$/);
    await expect(page.getByText(/Investigation deleted\. Restorable until/)).toBeVisible();
  });

  test('shows the pill "Source removed" in the Investigations list', async ({ page }) => {
    await openChanged(page, 'removed');
    await page.goto('/investigations');
    await expect(page.getByRole('row', { name: /account AC-1/ }).first()).toContainText('Source removed');
  });
});
