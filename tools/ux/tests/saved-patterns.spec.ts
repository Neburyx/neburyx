import { expect, test, type Page } from '@playwright/test';
import { openOneEntity } from './support/workspace.ts';
import { buildStepThroughUi, chooseMenuItem, openPatternList, openRowMenu, patternBuilder, patternsPanel as panelOf, pick, press } from './support/pattern-editor.ts';

const SOURCE = 'banking-demo';

const rowOf = (page: Page, name: string) => panelOf(page).getByRole('listitem').filter({ has: page.getByRole('heading', { name, level: 4, exact: true }) });
const dialogOf = (page: Page) => page.getByRole('dialog');

/** Builds Account → Device by keyboard and shows it on the preview screen. */
async function previewByKeyboard(page: Page): Promise<void> {
  const builder = patternBuilder(page);
  await press(page, panelOf(page).getByRole('button', { name: 'New pattern' }));
  await pick(page, builder.getByLabel('Starting entity type'), 'Account');
  await buildStepThroughUi(page, builder, 1, 'out', 'Device', ['USES_DEVICE']);
  await expect(builder.getByText('The mapping can follow this pattern')).toBeVisible();
  await press(page, builder.getByRole('button', { name: 'Preview' }));
  await expect(panelOf(page).getByRole('heading', { name: 'Preview pattern' })).toBeVisible();
}

test.describe('saved patterns in the Patterns panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/__support/reset');
    await openOneEntity(page, SOURCE, 'AC-1');
    await openPatternList(page);
  });

  test('lists the seeded patterns in their sections, with Run and Copy and the owner-only lines on another person’s shared one', async ({ page }) => {
    await expect(panelOf(page).getByRole('heading', { level: 3 })).toHaveText(['Built-in · 3', 'My patterns · 2', 'Shared on this source · 1']);
    await expect(panelOf(page).getByText('Shared patterns can be run or copied. Only their owner can change or delete them.')).toBeVisible();
    const retired = rowOf(page, 'Retired pattern');
    await expect(retired.getByText('Pattern out of date')).toBeVisible();
    await expect(retired.getByText('This pattern uses a type the mapping no longer has. (step 1)')).toBeVisible();
    await expect(retired.getByRole('button', { name: 'Run Retired pattern' })).toBeDisabled();
    await expect(retired.getByRole('button', { name: 'Change pattern' })).toBeVisible();
    const shared = rowOf(page, 'Shared by Pat');
    await expect(shared).toContainText('shared by Pat');
    await expect(shared.getByRole('button', { name: 'Run Shared by Pat' })).toBeEnabled();
    await openRowMenu(page, 'Shared by Pat');
    await expect(page.getByRole('menuitem')).toHaveText(['Run', 'Copy', 'Changeowner only', 'Renameowner only', 'Deleteowner only']);
    await expect(page.getByRole('menu').getByText('Owned by Pat. Only the owner can:')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(panelOf(page)).toBeVisible();
  });

  test('saves a built pattern from the preview, finds it in My patterns, runs it and shares it', async ({ page }) => {
    await previewByKeyboard(page);
    await press(page, panelOf(page).getByRole('button', { name: 'Save pattern…' }));
    const dialog = dialogOf(page);
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await dialog.getByLabel('Name').fill('Saved by the spec');
    await press(page, dialog.getByRole('button', { name: 'Save' }));
    await expect(panelOf(page).getByText('Pattern saved.')).toBeVisible();
    await press(page, panelOf(page).getByRole('button', { name: 'Edit' }));
    await press(page, patternBuilder(page).getByRole('button', { name: 'Cancel' }));
    await press(page, dialogOf(page).getByRole('button', { name: 'Discard draft' }));
    const row = rowOf(page, 'Saved by the spec');
    await expect(row).toContainText('Private');
    await press(page, row.getByRole('button', { name: 'Run Saved by the spec' }));
    await expect(panelOf(page).getByRole('heading', { name: 'Preview pattern' })).toBeVisible();
    await expect(panelOf(page).locator('.patterns-subhead')).toHaveText('Saved by the spec');
    await expect(panelOf(page).getByRole('button', { name: 'Run pattern' })).toBeEnabled();
    await press(page, panelOf(page).getByRole('button', { name: 'Run pattern' }));
    await expect(panelOf(page).getByRole('heading', { name: 'Pattern result' })).toBeVisible();
    await press(page, panelOf(page).getByRole('button', { name: 'Back to patterns' }));
    await openRowMenu(page, 'Saved by the spec');
    await chooseMenuItem(page, 'Share');
    await expect(dialogOf(page).getByRole('heading', { name: 'Share this pattern?' })).toBeVisible();
    await press(page, dialogOf(page).getByRole('button', { name: 'Share' }));
    await expect(panelOf(page).getByText('Pattern shared with everyone on this source.')).toBeVisible();
    await expect(rowOf(page, 'Saved by the spec')).toContainText('Shared');
  });

  test('runs a pattern that holds its starting entity at once, with the saved name under the heading', async ({ page }) => {
    await press(page, rowOf(page, 'Device ring').getByRole('button', { name: 'Run Device ring' }));
    await expect(panelOf(page).getByRole('heading', { name: 'Pattern result' })).toBeVisible();
    await expect(panelOf(page).locator('.patterns-subhead')).toHaveText(/^Device ring · from /);
    await expect(panelOf(page).getByRole('status').filter({ hasText: 'Exact' }).first()).toHaveText('2 matches · Exact');
  });

  test('refuses a name the person already uses, keeps the dialog open with the name and says so in words', async ({ page }) => {
    await previewByKeyboard(page);
    await press(page, panelOf(page).getByRole('button', { name: 'Save pattern…' }));
    await dialogOf(page).getByLabel('Name').fill('Device ring');
    await press(page, dialogOf(page).getByRole('button', { name: 'Save' }));
    await expect(dialogOf(page).getByText('This name is already used on this source. Choose another.')).toBeVisible();
    await expect(dialogOf(page).getByLabel('Name')).toHaveValue('Device ring');
    await expect(dialogOf(page).getByRole('button', { name: 'Save' })).toBeDisabled();
    await dialogOf(page).getByLabel('Name').fill('Device ring two');
    await press(page, dialogOf(page).getByRole('button', { name: 'Save' }));
    await expect(panelOf(page).getByText('Pattern saved.')).toBeVisible();
  });

  test('renames a pattern, and refuses a name another of the person’s patterns has', async ({ page }) => {
    await openRowMenu(page, 'Device ring');
    await chooseMenuItem(page, 'Rename');
    await expect(dialogOf(page).getByLabel('Name')).toBeFocused();
    await dialogOf(page).getByLabel('Name').fill('Retired pattern');
    await press(page, dialogOf(page).getByRole('button', { name: 'Rename' }));
    await expect(dialogOf(page).getByText('This name is already used on this source. Choose another.')).toBeVisible();
    await dialogOf(page).getByLabel('Name').fill('Renamed ring');
    await press(page, dialogOf(page).getByRole('button', { name: 'Rename' }));
    await expect(panelOf(page).getByText('Pattern renamed.')).toBeVisible();
    await expect(rowOf(page, 'Renamed ring')).toBeVisible();
  });

  test('copies another person’s shared pattern into My patterns, and deletes it after a confirmation', async ({ page }) => {
    await openRowMenu(page, 'Shared by Pat');
    await chooseMenuItem(page, 'Copy');
    await expect(panelOf(page).getByText('Pattern copied.')).toBeVisible();
    await expect(panelOf(page).getByRole('heading', { level: 3 }).filter({ hasText: /^My patterns/ })).toHaveText('My patterns · 3');
    await openRowMenu(page, 'Shared by Pat (copy)');
    await chooseMenuItem(page, 'Delete');
    await expect(dialogOf(page)).toContainText('This pattern is private to you. It is removed from My patterns and cannot be recovered.');
    await expect(dialogOf(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await press(page, dialogOf(page).getByRole('button', { name: 'Delete pattern' }));
    await expect(panelOf(page).getByText('Pattern deleted.')).toBeVisible();
    await expect(rowOf(page, 'Shared by Pat (copy)')).toHaveCount(0);
  });
});
