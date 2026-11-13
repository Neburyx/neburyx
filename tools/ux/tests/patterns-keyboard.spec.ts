import { expect, test, type Locator, type Page } from '@playwright/test';
import { openOneEntity } from './support/workspace.ts';
import { buildStepThroughUi, chooseMenuItem, openPatternList, openRowMenu, patternBuilder, patternsPanel as panelOf, patternsTool as toolOf, pick, press, previewTwoSteps } from './support/pattern-editor.ts';

const SOURCE = 'banking-demo';

const rowOf = (page: Page, name: string) => panelOf(page).getByRole('listitem').filter({ has: page.getByRole('heading', { name, level: 4, exact: true }) });
const dialogOf = (page: Page) => page.getByRole('dialog');
const headingOf = (page: Page, name: string) => panelOf(page).getByRole('heading', { name, level: 2 });

/** The accessible name of what has the focus: its label, else its text. */
const focusedName = (page: Page): Promise<string> => page.evaluate(() => (document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '').trim());

/** Whether the focused control draws a ring: an outline or a shadow, never none. */
const ringOf = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (element === null) return false;
    const style = getComputedStyle(element);
    return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1) || (style.boxShadow !== 'none' && style.boxShadow !== '');
  });

/** Presses Tab until `target` has the focus (a few stops at most), so that a stop between two named ones does not fail the walk. */
async function tabTo(page: Page, target: Locator, limit = 6): Promise<void> {
  for (let presses = 0; presses < limit && !(await target.evaluate((element) => element === document.activeElement)); presses += 1) await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}

async function saveByKeyboard(page: Page, name: string): Promise<void> {
  await press(page, panelOf(page).getByRole('button', { name: 'Save pattern…' }));
  await dialogOf(page).getByLabel('Name').fill(name);
  await press(page, dialogOf(page).getByRole('button', { name: 'Save' }));
  await expect(panelOf(page).getByText('Pattern saved.')).toBeVisible();
}

/** From the run view of a draft back to the list: Edit, Cancel and the choice to discard the draft. */
async function backToList(page: Page): Promise<void> {
  await press(page, panelOf(page).getByRole('button', { name: 'Edit' }));
  await press(page, patternBuilder(page).getByRole('button', { name: 'Cancel' }));
  await press(page, dialogOf(page).getByRole('button', { name: 'Discard draft' }));
  await expect(panelOf(page).getByRole('searchbox', { name: 'Search patterns' })).toBeVisible();
}

test.describe('the Patterns panel by keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/__support/reset');
    await page.request.post('/__support/patterns-mode', { data: { noPresets: false } });
    await openOneEntity(page, SOURCE, 'AC-1');
    await toolOf(page).focus();
    await page.keyboard.press('Enter');
    await expect(panelOf(page).getByRole('searchbox', { name: 'Search patterns' })).toBeVisible();
  });

  test('runs a built-in pattern: Run on its row, the start field, Run pattern, and Back to patterns', async ({ page }) => {
    await press(page, panelOf(page).getByRole('button', { name: 'Run Shared devices' }));
    await expect(headingOf(page, 'Shared devices')).toBeVisible();
    const start = panelOf(page).getByLabel('Starting account');
    await expect(start).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(start.locator('option:checked')).not.toHaveText('');
    await expect(panelOf(page).getByRole('button', { name: 'Run pattern' })).toBeEnabled();
    await press(page, panelOf(page).getByRole('button', { name: 'Run pattern' }));
    await expect(panelOf(page).getByRole('table').getByRole('row')).toHaveCount(6);
    await expect(panelOf(page).getByRole('status').filter({ hasText: 'exact' })).toHaveText('5 · exact');
    await press(page, panelOf(page).getByRole('button', { name: 'Back to patterns' }));
    await expect(panelOf(page).getByRole('searchbox', { name: 'Search patterns' })).toBeVisible();
  });

  test('saves a built pattern, runs it from My patterns and shares it', async ({ page }) => {
    await panelOf(page).getByRole('button', { name: 'New pattern' }).focus();
    await page.keyboard.press('Enter');
    await pick(page, patternBuilder(page).getByLabel('Starting entity type'), 'Account');
    await buildStepThroughUi(page, patternBuilder(page), 1, 'out', 'Device', ['USES_DEVICE']);
    await expect(patternBuilder(page).getByRole('button', { name: 'Preview' })).toBeEnabled();
    await press(page, patternBuilder(page).getByRole('button', { name: 'Preview' }));
    await expect(headingOf(page, 'Preview pattern')).toBeVisible();
    await saveByKeyboard(page, 'Keyboard saved');
    await backToList(page);
    await expect(panelOf(page).getByRole('heading', { level: 3 }).filter({ hasText: /^My patterns/ })).toHaveText('My patterns · 3');
    await press(page, panelOf(page).getByRole('button', { name: 'Run Keyboard saved' }));
    await expect(headingOf(page, 'Preview pattern')).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Run pattern' })).toBeEnabled();
    await press(page, panelOf(page).getByRole('button', { name: 'Run pattern' }));
    await expect(headingOf(page, 'Pattern result')).toBeVisible();
    await press(page, panelOf(page).getByRole('button', { name: 'Back to patterns' }));
    await openRowMenu(page, 'Keyboard saved');
    await chooseMenuItem(page, 'Share');
    await press(page, dialogOf(page).getByRole('button', { name: 'Share' }));
    await expect(panelOf(page).getByText('Pattern shared with everyone on this source.')).toBeVisible();
    await expect(rowOf(page, 'Keyboard saved')).toContainText('Shared');
    await expect(page.getByRole('button', { name: 'More: Keyboard saved' })).toBeFocused();
  });

  test('changes a shared pattern and saves the change as a copy, leaving the shared one as it was', async ({ page }) => {
    await openRowMenu(page, 'Device ring');
    await chooseMenuItem(page, 'Share');
    await press(page, dialogOf(page).getByRole('button', { name: 'Share' }));
    await expect(rowOf(page, 'Device ring')).toContainText('Shared');
    await openRowMenu(page, 'Device ring');
    await chooseMenuItem(page, 'Change');
    await expect(headingOf(page, 'Change pattern: Device ring')).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Preview' })).toBeEnabled();
    await press(page, panelOf(page).getByRole('button', { name: 'Preview' }));
    await expect(headingOf(page, 'Preview pattern')).toBeVisible();
    await press(page, panelOf(page).getByRole('button', { name: 'Save changes…' }));
    const dialog = dialogOf(page);
    await expect(dialog.getByRole('heading', { name: 'Save changes to “Device ring”?' })).toBeVisible();
    await expect(dialog).toContainText('Others on this source run this pattern. Save for everyone?');
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await tabTo(page, dialog.getByRole('button', { name: 'Save as a copy' }));
    await page.keyboard.press('Enter');
    await expect(panelOf(page).getByText('Saved as a copy.')).toBeVisible();
    await expect(rowOf(page, 'Device ring (copy)')).toContainText('Private');
    await expect(rowOf(page, 'Device ring')).toContainText('Shared');
  });

  test('shows another person’s shared pattern with Run and Copy, and the owner-only lines do nothing', async ({ page }) => {
    const row = rowOf(page, 'Shared by Pat');
    await expect(row.getByRole('button')).toHaveText(['Run', '⋯']);
    await openRowMenu(page, 'Shared by Pat');
    const menu = page.getByRole('menu', { name: 'Shared by Pat' });
    await expect(menu.getByRole('menuitem', { name: 'Run', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Copy', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Change, owner only' })).toBeFocused();
    await expect(menu.getByText('Owned by Pat. Only the owner can:')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Rename, owner only' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Delete, owner only' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialogOf(page)).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Run', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(headingOf(page, 'Preview pattern')).toBeVisible();
  });

  test('Esc closes a menu and gives the focus back to its button, and the next Esc closes the panel', async ({ page }) => {
    await openRowMenu(page, 'Device ring');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More: Device ring' })).toBeFocused();
    await expect(panelOf(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panelOf(page)).toHaveCount(0);
    await expect(toolOf(page)).toBeFocused();
  });

  for (const opener of [
    { name: 'Rename', menu: 'Rename', dialog: 'Rename pattern', first: 'Name', last: 'Rename' },
    { name: 'Delete', menu: 'Delete', dialog: 'Delete “Device ring”?', first: 'Cancel', last: 'Delete pattern' },
    { name: 'Share', menu: 'Share', dialog: 'Share this pattern?', first: 'Close', last: 'Share' },
  ]) {
    test(`the ${opener.name} dialog traps the focus, closes on Esc and gives the focus back to the menu button`, async ({ page }) => {
      await openRowMenu(page, 'Device ring');
      await chooseMenuItem(page, opener.menu);
      const dialog = dialogOf(page);
      await expect(dialog.getByRole('heading', { name: opener.dialog })).toBeVisible();
      for (let presses = 0; presses < 8; presses += 1) {
        await page.keyboard.press('Tab');
        expect(await dialog.locator(':focus').count(), `the focus stays in the dialog after Tab ${presses + 1}`).toBe(1);
      }
      for (let presses = 0; presses < 8; presses += 1) {
        await page.keyboard.press('Shift+Tab');
        expect(await dialog.locator(':focus').count(), `the focus stays in the dialog after Shift+Tab ${presses + 1}`).toBe(1);
      }
      await page.keyboard.press('Escape');
      await expect(dialogOf(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'More: Device ring' })).toBeFocused();
      await expect(panelOf(page)).toBeVisible();
    });
  }

  test('the Save pattern dialog traps the focus and gives it back to Save pattern… on Cancel', async ({ page }) => {
    await panelOf(page).getByRole('button', { name: 'New pattern' }).click();
    await patternBuilder(page).getByLabel('Starting entity type').selectOption({ label: 'Account' });
    await buildStepThroughUi(page, patternBuilder(page), 1, 'out', 'Device', ['USES_DEVICE']);
    await expect(patternBuilder(page).getByRole('button', { name: 'Preview' })).toBeEnabled();
    await press(page, patternBuilder(page).getByRole('button', { name: 'Preview' }));
    const opener = panelOf(page).getByRole('button', { name: 'Save pattern…' });
    await press(page, opener);
    const dialog = dialogOf(page);
    await expect(dialog.getByLabel('Name')).toBeFocused();
    for (let presses = 0; presses < 10; presses += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.locator(':focus').count(), `the focus stays in the dialog after Tab ${presses + 1}`).toBe(1);
    }
    await dialog.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialogOf(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('Tab follows the reading order of the list with a visible focus ring on each stop', async ({ page }) => {
    await expect(panelOf(page).getByRole('button', { name: 'More: Shared by Pat' })).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Run Connected accounts' })).toBeVisible();
    await page.keyboard.press('Shift');
    await panelOf(page).getByRole('button', { name: 'Close Patterns' }).focus();
    // the Run of the pattern that is out of date is disabled, so it is no stop
    const names: string[] = [];
    for (let count = 0; count < 20; count += 1) {
      names.push(await focusedName(page));
      expect(await ringOf(page), `a focus ring on ${names[names.length - 1]}`).toBe(true);
      if (names[names.length - 1] === 'More: Shared by Pat') break;
      await page.keyboard.press('Tab');
    }
    expect(names).toEqual([
      'Close Patterns',
      '+ New pattern',
      'Search patterns',
      'Run Shared devices',
      'Run Shared addresses',
      'Run Connected accounts',
      'Run Device ring',
      'More: Device ring',
      'Change pattern',
      'More: Retired pattern',
      'Run Shared by Pat',
      'More: Shared by Pat',
    ]);
  });

  test('Tab follows the reading order of the preview, with a visible focus ring', async ({ page }) => {
    await previewTwoSteps(page);
    const start = panelOf(page).getByRole('combobox', { name: 'Start from: Account' });
    await page.keyboard.press('Shift');
    await start.focus();
    expect(await ringOf(page), 'a focus ring on the start field').toBe(true);
    const names: string[] = [];
    for (let count = 0; count < 3; count += 1) {
      await page.keyboard.press('Tab');
      names.push(await focusedName(page));
      expect(await ringOf(page), `a focus ring on ${names[names.length - 1]}`).toBe(true);
    }
    expect(names).toEqual(['Save pattern…', '‹ Edit', 'Run pattern']);
  });

  test('announces Running politely, shows the elapsed time as an ordinary line, keeps the focus on Cancel run and gives it to Run again', async ({ page }) => {
    await openOneEntity(page, SOURCE, 'SLOW-1');
    await previewTwoSteps(page);
    await expect(panelOf(page).getByRole('button', { name: 'Run pattern' })).toBeEnabled();
    await press(page, panelOf(page).getByRole('button', { name: 'Run pattern' }));
    const cancel = panelOf(page).getByRole('button', { name: 'Cancel run' });
    await expect(cancel).toBeFocused();
    expect(await ringOf(page), 'a focus ring on Cancel run').toBe(true);
    const running = panelOf(page).getByRole('status').filter({ hasText: /^Running$/ });
    await expect(running).toHaveCount(1);
    await expect(running).toHaveAttribute('role', 'status');
    await expect(panelOf(page).getByText(/s elapsed\. Large sources can take longer\./)).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(panelOf(page).getByRole('button', { name: 'Run again' })).toBeFocused();
  });

  test('announces the exact count of a result, the page of the first match next in the order of Tab', async ({ page }) => {
    await previewTwoSteps(page);
    await expect(panelOf(page).getByRole('button', { name: 'Run pattern' })).toBeEnabled();
    await press(page, panelOf(page).getByRole('button', { name: 'Run pattern' }));
    await expect(panelOf(page).getByRole('status').filter({ hasText: 'Exact' }).first()).toHaveText('2 matches · Exact');
    await expect(panelOf(page).getByRole('button', { name: 'Add all 2 to graph' })).toBeVisible();
  });
});
