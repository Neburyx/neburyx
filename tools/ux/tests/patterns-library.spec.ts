import { expect, test, type Page } from '@playwright/test';
import { patternsPanel as panelOf } from './support/pattern-editor.ts';

const rowOf = (page: Page, name: string) => page.getByRole('row').filter({ has: page.getByRole('rowheader').getByText(name, { exact: true }) });

test.describe('the patterns library page', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('/__support/reset');
    await page.goto('/patterns');
    await expect(page.getByRole('heading', { name: 'Patterns', level: 1 })).toBeVisible();
  });

  test('lists the three tabs with their counts, the table of the saved patterns and the footnote, and no Alerts tab', async ({ page }) => {
    await expect(page.getByRole('tab')).toHaveText(['My patterns · 2', 'Shared with me · 1', 'Built-in · 3']);
    await expect(page.getByText('Approved ways to explore. Save a run with its parameters to reuse or share it.')).toBeVisible();
    await expect(page.getByRole('columnheader')).toHaveText(['Name', 'Pattern', 'Parameters', 'Last run', 'Visibility', 'Actions']);
    await expect(rowOf(page, 'Device ring')).toContainText('Built in the app');
    await expect(rowOf(page, 'Device ring')).toContainText('Only me');
    await expect(rowOf(page, 'Retired pattern')).toContainText('Unavailable');
    await expect(rowOf(page, 'Retired pattern').getByRole('button', { name: 'Run Retired pattern' })).toBeDisabled();
    await expect(page.getByText('A saved pattern stores the pattern and its parameters, never query text. Running it applies your own access and limits.')).toBeVisible();
    await expect(page.getByText(/Alerts/)).toHaveCount(0);
  });

  test('moves between the tabs with the arrow keys and lists the shared and the built-in rows', async ({ page }) => {
    await page.getByRole('tab', { name: /^My patterns/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /^Shared with me/ })).toBeFocused();
    await expect(rowOf(page, 'Shared by Pat')).toContainText('Shared by Pat');
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: /^Built-in/ })).toBeFocused();
    await expect(page.getByRole('row')).toHaveCount(4);
    await expect(rowOf(page, 'Shared devices').getByRole('button', { name: /^More:/ })).toHaveCount(0);
  });

  test('runs a pattern that holds its starting entity from its row: Explore opens on the source with the panel on the result', async ({ page }) => {
    await page.getByRole('button', { name: 'Run Device ring' }).click();
    await expect(page).toHaveURL(/\/explore$/);
    await expect(panelOf(page).getByRole('heading', { name: 'Pattern result' })).toBeVisible();
  });

  test('opens the form of a built-in pattern in the panel', async ({ page }) => {
    await page.getByRole('tab', { name: /^Built-in/ }).click();
    await page.getByRole('button', { name: 'Run Shared devices' }).click();
    await expect(page).toHaveURL(/\/explore$/);
    await expect(panelOf(page).getByRole('button', { name: 'Shared devices', exact: true, pressed: true })).toBeVisible();
  });

  test('renames a pattern from the menu of its row and reads the list again', async ({ page }) => {
    await page.getByRole('button', { name: 'More: Device ring' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Renamed on the page');
    await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByText('Pattern renamed.')).toBeVisible();
    await expect(rowOf(page, 'Renamed on the page')).toBeVisible();
  });

  test('keeps the menu of a bottom row inside a short window', async ({ page }) => {
    await page.setViewportSize({ width: page.viewportSize()?.width ?? 1440, height: 520 });
    await page.getByRole('button', { name: 'More: Retired pattern' }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'More: Retired pattern' }).click();
    const box = await page.getByRole('menu', { name: 'Retired pattern' }).boundingBox();
    expect(box).not.toBeNull();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(520);
  });

  test('keeps the menu of the last column inside the window sideways as well', async ({ page }) => {
    await page.getByRole('button', { name: 'More: Device ring' }).click();
    const box = await page.getByRole('menu', { name: 'Device ring' }).boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  });

  test('puts the Synthetic data pill beside the title, not at the far edge', async ({ page }) => {
    const title = await page.getByRole('heading', { name: 'Patterns', level: 1 }).boundingBox();
    const pill = await page.getByText('Synthetic data', { exact: true }).boundingBox();
    expect(title).not.toBeNull();
    expect(pill).not.toBeNull();
    expect((pill?.x ?? 999) - ((title?.x ?? 0) + (title?.width ?? 0))).toBeLessThan(40);
  });

  test('keeps Run and the menu of a row side by side at the width of the project', async ({ page }) => {
    for (const row of await page.getByRole('row').filter({ has: page.locator('.library-pill') }).all()) {
      const run = await row.getByRole('button', { name: /^Run / }).boundingBox();
      const menu = await row.getByRole('button', { name: /^More: / }).boundingBox();
      expect(run).not.toBeNull();
      expect(menu).not.toBeNull();
      expect(Math.abs((run?.y ?? 0) - (menu?.y ?? 99))).toBeLessThan(4);
    }
  });

  test('never lets the visibility of a row run under its buttons, whichever of the three labels it carries, at a width narrower than the supported ones', async ({ page }) => {
    await page.getByRole('button', { name: 'More: Device ring' }).click();
    await page.getByRole('menuitem', { name: 'Share' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Share' }).click();
    await expect(page.getByText('Pattern shared with everyone on this source.')).toBeVisible();
    await page.setViewportSize({ width: 800, height: 700 });
    for (const tab of [/^My patterns/, /^Shared with me/]) {
      await page.getByRole('tab', { name: tab }).click();
      const rows = page.getByRole('row').filter({ has: page.locator('.library-pill') });
      expect(await rows.count()).toBeGreaterThan(0);
      for (const row of await rows.all()) {
        const pill = await row.locator('.library-pill').boundingBox();
        expect(pill).not.toBeNull();
        for (const button of await row.getByRole('button').all()) {
          const box = await button.boundingBox();
          if (pill === null || box === null) continue;
          expect(pill.x + pill.width <= box.x || box.x + box.width <= pill.x || pill.y + pill.height <= box.y || box.y + box.height <= pill.y).toBe(true);
        }
      }
    }
  });

  test('opens from the link of the panel on the same source', async ({ page }) => {
    await page.getByRole('tab', { name: /^Built-in/ }).click();
    await page.getByRole('button', { name: 'Run Shared devices' }).click();
    await panelOf(page).getByRole('link', { name: 'Open the patterns library' }).click();
    await expect(page).toHaveURL(/\/patterns\?source=banking-demo$/);
    await expect(page.getByRole('tab')).toHaveText(['My patterns · 2', 'Shared with me · 1', 'Built-in · 3']);
  });

  test('has a Patterns item in the sidebar between Investigations and Sources, current on the page', async ({ page }) => {
    await expect(page.getByRole('navigation').getByRole('link')).toHaveText(['Home', 'Investigations', 'Patterns', 'Sources']);
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Patterns' })).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('the patterns library page on the claims pack', () => {
  test.use({ baseURL: 'http://127.0.0.1:4175' });

  test('lists the two built-in patterns of the pack the source declares, and asks for the source when none is named', async ({ page }) => {
    await page.goto('/patterns');
    await expect(page.getByRole('combobox', { name: 'Source' })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await page.goto('/patterns?source=claims-demo');
    await page.getByRole('tab', { name: /^Built-in/ }).click();
    await expect(page.getByRole('tab', { name: /^Built-in/ })).toHaveText('Built-in · 2');
    await expect(page.getByRole('button', { name: /^Run (Shared addresses|Claims by claimant)$/ })).toHaveCount(2);
  });

  test('lists a saved built-in run of the claims pack across its tabs and runs it from its row into the panel', async ({ page }) => {
    await page.request.post('/__support/reset');
    await page.goto('/dev/open-entity');
    await page.getByRole('button', { name: 'claims-demo', exact: true }).click();
    const form = page.getByRole('form', { name: 'Open an entity' });
    await form.getByLabel('Entity type').selectOption('claimant');
    await form.getByLabel('Stable ID').fill('CL-1');
    await form.getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: 'Patterns', exact: true }).click();
    await panelOf(page).getByRole('button', { name: 'Shared addresses', exact: true }).click();
    await panelOf(page).getByRole('button', { name: 'Save pattern', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Claims saved');
    await page.getByRole('dialog').getByRole('button', { name: 'Save pattern' }).click();
    await expect(panelOf(page).getByText('Pattern saved.')).toBeVisible();
    await page.goto('/patterns?source=claims-demo');
    await expect(page.getByRole('tab')).toHaveText(['My patterns · 1', 'Shared with me · 0', 'Built-in · 2']);
    await expect(rowOf(page, 'Claims saved')).toContainText('Shared addresses');
    await page.getByRole('tab', { name: /^Built-in/ }).click();
    await expect(page.getByRole('row')).toHaveCount(3);
    await page.getByRole('tab', { name: /^My patterns/ }).click();
    await page.getByRole('button', { name: 'Run Claims saved' }).click();
    await expect(page).toHaveURL(/\/explore$/);
    await expect(panelOf(page).getByRole('button', { name: 'Run pattern' })).toBeVisible();
  });
});
