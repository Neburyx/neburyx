import { expect, test, type Locator, type Page } from '@playwright/test';
import { tabTo } from './support/workspace.js';

async function openInvestigation(page: Page): Promise<string> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop() ?? '';
}

const header = (page: Page) => page.getByRole('banner', { name: 'Investigation' });
const saveButton = (page: Page) => header(page).getByRole('button', { name: 'Save' });
const viewsButton = (page: Page) => header(page).getByRole('button', { name: /^Views/ });
const saveDialog = (page: Page) => page.getByRole('dialog', { name: 'Save investigation' });
const panel = (page: Page) => page.getByRole('dialog', { name: /^Views/ });

async function boxOf(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('the element is not on the page');
  return box;
}

async function saveAs(page: Page, name: string, note = ''): Promise<void> {
  await saveButton(page).focus();
  await page.keyboard.press('Enter');
  await saveDialog(page).getByLabel('Name').fill(name);
  if (note !== '') await saveDialog(page).getByLabel('Note (optional)').fill(note);
  await saveDialog(page).getByRole('button', { name: 'Save investigation' }).click();
  await expect(saveDialog(page)).toHaveCount(0);
}

test.describe('saving, listing, restoring and renaming named views', () => {
  test('opens the Save dialog from the keyboard with the focus in Name, gives the focus back on Escape, and shows when it saved', async ({ page }) => {
    await openInvestigation(page);
    await saveButton(page).focus();
    await page.keyboard.press('Enter');
    const dialog = saveDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(saveButton(page)).toBeFocused();
    await saveAs(page, 'First look');
    await expect(saveButton(page)).toBeFocused();
    await expect(header(page).getByText(/^Saved \d\d:\d\d UTC$/)).toBeVisible();
  });

  test('ties a name that is too long to its field and keeps the dialog open', async ({ page }) => {
    await openInvestigation(page);
    await saveButton(page).click();
    const name = saveDialog(page).getByLabel('Name');
    await name.fill('x'.repeat(121));
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    const describedBy = (await name.getAttribute('aria-describedby')) ?? '';
    const described = await page.evaluate((ids) => ids.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' '), describedBy);
    expect(described).toContain('A view name is at most 120 characters.');
    await expect(saveDialog(page).getByRole('button', { name: 'Save investigation' })).toBeDisabled();
  });

  test('lists the views from Views, reaches Restore and Rename with Tab, and gives the focus back on Escape', async ({ page }) => {
    await openInvestigation(page);
    await saveAs(page, 'First look');
    await viewsButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText('First look');
    await expect(panel(page)).toContainText('Saved by');
    await tabTo(page, panel(page).getByRole('button', { name: 'Restore First look into draft' }));
    await tabTo(page, panel(page).getByRole('button', { name: 'Rename First look' }));
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(viewsButton(page)).toBeFocused();
  });

  test('says there are no views yet before the first save', async ({ page }) => {
    await openInvestigation(page);
    await viewsButton(page).click();
    await expect(panel(page)).toContainText('No named views yet.');
  });

  test('restores a view: the dialog keeps the focus inside, Cancel changes nothing, and confirming replaces the draft and the pill', async ({ page }) => {
    const id = await openInvestigation(page);
    await saveAs(page, 'First look', 'alpha');
    await viewsButton(page).click();
    await panel(page).getByRole('button', { name: 'Restore First look into draft' }).click();
    const confirm = page.getByRole('dialog', { name: 'Replace your draft?' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Restoring “First look” replaces everything in your draft');
    for (let press = 0; press < 6; press += 1) {
      await page.keyboard.press('Tab');
      const inside = await confirm.evaluate((element) => element.contains(document.activeElement));
      expect(inside).toBe(true);
    }
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(header(page).getByText(/^Saved \d\d:\d\d UTC$/)).toBeVisible();
    await saveAs(page, 'Second look', 'beta');
    const read = async () => (await (await page.request.get(`/v1/investigations/${id}`)).json()) as { draft: { notes: string | null; basedOnViewId: string | null }; save: { state: string; savedAt: string | null } };
    expect((await read()).draft.notes).toBe('beta');
    await viewsButton(page).click();
    await expect(panel(page)).toContainText('Second look');
    await panel(page).getByRole('button', { name: 'Restore First look into draft' }).click();
    await page.getByRole('dialog', { name: 'Replace your draft?' }).getByRole('button', { name: 'Restore into draft' }).click();
    await expect(page.getByRole('dialog', { name: 'Replace your draft?' })).toHaveCount(0);
    await expect(header(page).getByText(/^Saved \d\d:\d\d UTC$/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Second look');
    const restored = await read();
    expect(restored.draft.notes).toBe('alpha');
    expect(restored.save.state).toBe('saved');
    const listed = (await (await page.request.get(`/v1/investigations/${id}/views`)).json()) as { items: { id: string; name: string }[] };
    expect(listed.items.find((view) => view.name === 'First look')?.id).toBe(restored.draft.basedOnViewId);
  });

  test('renames a view in place: Enter saves and Escape cancels', async ({ page }) => {
    await openInvestigation(page);
    await saveAs(page, 'First look');
    await viewsButton(page).click();
    await panel(page).getByRole('button', { name: 'Rename First look' }).click();
    const input = panel(page).getByRole('textbox');
    await expect(input).toBeFocused();
    await input.fill('Renamed once');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toContainText('First look');
    await expect(panel(page)).not.toContainText('Renamed once');
    await panel(page).getByRole('button', { name: 'Rename First look' }).click();
    await panel(page).getByRole('textbox').fill('Renamed once');
    await page.keyboard.press('Enter');
    await expect(panel(page)).toContainText('Renamed once');
    await expect(panel(page).getByRole('button', { name: 'Rename Renamed once' })).toBeVisible();
  });

  test('shows why the actions of a closed investigation are dimmed, keeps Tab off them, and starts the panel below the banner', async ({ page }) => {
    await openInvestigation(page);
    await saveAs(page, 'First look');
    await page.getByRole('button', { name: 'Investigation menu' }).click();
    await page.getByRole('menuitem', { name: 'Close' }).click();
    const banner = page.getByRole('region', { name: 'Request status' });
    await expect(banner).toBeVisible();
    await expect(saveButton(page)).toBeDisabled();
    await viewsButton(page).click();
    const views = panel(page);
    await expect(views).toContainText('Reopen to restore or rename views.');
    const restore = views.getByRole('button', { name: 'Restore First look into draft' });
    const rename = views.getByRole('button', { name: 'Rename First look' });
    await expect(restore).toBeDisabled();
    await expect(rename).toBeDisabled();
    const reason = (await restore.getAttribute('aria-describedby')) ?? '';
    expect(await page.evaluate((id) => document.getElementById(id)?.textContent ?? '', reason)).toBe('Reopen to restore or rename views.');
    for (let press = 0; press < 8; press += 1) {
      await page.keyboard.press('Tab');
      await expect(restore).not.toBeFocused();
      await expect(rename).not.toBeFocused();
    }
    const bannerBox = await boxOf(banner);
    expect((await boxOf(views)).y).toBeGreaterThanOrEqual(bannerBox.y + bannerBox.height);
  });

  test('moves below a banner that appears while the panel is open, so its Reopen button stays reachable', async ({ page }) => {
    const id = await openInvestigation(page);
    await saveAs(page, 'First look');
    await viewsButton(page).click();
    await panel(page).getByRole('button', { name: 'Rename First look' }).click();
    await page.request.post('/__support/set-status', { data: { id, status: 'closed' } });
    await panel(page).getByRole('textbox').fill('Renamed once');
    await page.keyboard.press('Enter');
    const banner = page.getByRole('region', { name: 'Request status' });
    await expect(banner).toBeVisible();
    const reopen = banner.getByRole('button', { name: 'Reopen' });
    await expect(reopen).toBeVisible();
    await expect.poll(async () => {
      const bottom = await boxOf(banner);
      return (await boxOf(panel(page))).y >= bottom.y + bottom.height;
    }).toBe(true);
    const box = await boxOf(reopen);
    const covered = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="dialog"]') !== null, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(covered).toBe(false);
  });

  test('keeps Save and Views at 32 px', async ({ page }) => {
    await openInvestigation(page);
    const heights = await Promise.all([saveButton(page), viewsButton(page)].map(async (control) => (await control.boundingBox())?.height ?? 0));
    expect(heights.every((height) => height === 32)).toBe(true);
  });
});
