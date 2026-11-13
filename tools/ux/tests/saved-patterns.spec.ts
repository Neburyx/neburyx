import { expect, test, type Locator, type Page } from '@playwright/test';
import { openOneEntity } from './support/workspace.ts';

const SOURCE = 'banking-demo';

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Patterns' });
const builderOf = (page: Page) => panelOf(page).getByRole('region', { name: 'New pattern' });
const stepOf = (page: Page, n: number) => builderOf(page).getByRole('group', { name: `Step ${n}` });
const tabOf = (page: Page, name: RegExp) => panelOf(page).getByRole('tab', { name });

/** Keyboard-only moves: a control is focused, then the keys do the rest. */
async function pick(page: Page, select: Locator, label: string): Promise<void> {
  await select.focus();
  await page.keyboard.type(label);
  await expect(select.locator('option:checked')).toHaveText(label);
}
const press = async (page: Page, control: Locator): Promise<void> => {
  await control.focus();
  await page.keyboard.press('Enter');
};

async function openMenu(page: Page, name: string): Promise<void> {
  await press(page, panelOf(page).getByRole('button', { name: `More: ${name}` }));
  await expect(page.getByRole('menu')).toBeVisible();
}

test.describe('saved patterns in the Patterns panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/__support/reset');
    await openOneEntity(page, SOURCE, 'AC-1');
    await page.getByRole('button', { name: 'Patterns', exact: true }).click();
  });

  test('lists the seeded patterns by who made them, with Run and Copy only on another person’s shared one', async ({ page }) => {
    await expect(panelOf(page).getByRole('tab')).toHaveText(['My patterns · 2', 'Shared on this source · 1', 'Built-in · 3']);
    await tabOf(page, /Built-in/).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabOf(page, /My patterns/)).toHaveAttribute('aria-selected', 'true');
    await expect(panelOf(page).getByText('Retired pattern')).toBeVisible();
    await expect(panelOf(page).getByText('Unavailable')).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Run Retired pattern' })).toBeDisabled();
    await page.keyboard.press('Tab');
    await tabOf(page, /My patterns/).focus();
    await page.keyboard.press('ArrowRight');
    await expect(panelOf(page).getByText('Shared by Pat')).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Run Shared by Pat' })).toBeEnabled();
    await openMenu(page, 'Shared by Pat');
    await expect(page.getByRole('menuitem')).toHaveText(['Copy']);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(panelOf(page)).toBeVisible();
  });

  test('saves a built pattern, finds it in My patterns, runs it and shares it, by keyboard alone', async ({ page }) => {
    await press(page, panelOf(page).getByRole('button', { name: 'New pattern' }));
    await pick(page, builderOf(page).getByLabel('Starts at'), 'Account');
    await press(page, builderOf(page).getByRole('button', { name: 'Add step' }));
    await pick(page, stepOf(page, 1).getByLabel('Direction'), 'Outgoing');
    await pick(page, stepOf(page, 1).getByLabel('Arrives at'), 'Device');
    await stepOf(page, 1).getByRole('checkbox', { name: 'USES_DEVICE' }).focus();
    await page.keyboard.press('Space');
    await expect(builderOf(page).getByText('Valid: the mapping can follow this pattern.')).toBeVisible();
    await press(page, builderOf(page).getByRole('button', { name: 'Save pattern' }));
    await page.keyboard.type('Keyboard saved');
    await expect(page.getByRole('dialog').getByLabel('Name')).toHaveValue(/Keyboard saved/);
    await page.getByRole('dialog').getByLabel('Name').fill('Keyboard saved');
    await press(page, page.getByRole('dialog').getByRole('button', { name: 'Save pattern' }));
    await expect(panelOf(page).getByText('Pattern saved.')).toBeVisible();
    await press(page, builderOf(page).getByRole('button', { name: 'Back to patterns' }));
    await tabOf(page, /Built-in/).focus();
    await page.keyboard.press('ArrowRight');
    await expect(panelOf(page).getByText('Keyboard saved')).toBeVisible();
    await press(page, panelOf(page).getByRole('button', { name: 'Run Keyboard saved' }));
    await press(page, panelOf(page).getByRole('region', { name: 'Run: Keyboard saved' }).getByRole('button', { name: 'Run pattern' }));
    await expect(panelOf(page).getByRole('region', { name: 'Result' })).toBeVisible();
    await openMenu(page, 'Keyboard saved');
    await page.getByRole('menuitem', { name: 'Share' }).focus();
    await page.keyboard.press('Enter');
    await press(page, page.getByRole('dialog').getByRole('button', { name: 'Share' }));
    await expect(panelOf(page).getByText('Pattern shared with everyone on this source.')).toBeVisible();
    await expect(panelOf(page).getByRole('listitem').filter({ hasText: 'Keyboard saved' })).toContainText('Everyone on this source');
  });

  test('copies another person’s shared pattern into My patterns, and deletes it after a confirmation', async ({ page }) => {
    await tabOf(page, /Built-in/).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await openMenu(page, 'Shared by Pat');
    await page.getByRole('menuitem', { name: 'Copy' }).focus();
    await page.keyboard.press('Enter');
    await expect(panelOf(page).getByText('Pattern copied.')).toBeVisible();
    await tabOf(page, /Shared on this source/).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(panelOf(page).getByText('Shared by Pat (copy)')).toBeVisible();
    await openMenu(page, 'Shared by Pat (copy)');
    await page.getByRole('menuitem', { name: 'Delete' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toContainText('The pattern is deleted and cannot be run again.');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(panelOf(page).getByText('Pattern deleted.')).toBeVisible();
  });
});
