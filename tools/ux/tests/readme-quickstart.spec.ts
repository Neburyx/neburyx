import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { evidenceOf, sampleEnvironment } from './support/trust-cases.ts';
import { canvasOf, menuOf } from './support/workspace.ts';

test.use({ baseURL: 'http://127.0.0.1:4175' });

const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const DEMO_CASE = { entityType: 'account', stableId: 'DEMO-1', caseRef: 'REF-DEMO-1' };

/** A phrase the page quotes must be in the README in quotes: the step then proves it exists in the built app. */
const quoted = (phrase: string): string => {
  expect(readme, phrase).toContain(`"${phrase}"`);
  return phrase;
};

const post = (page: Page, path: string, data: unknown = {}) => page.request.post(path, { data });

test.beforeEach(async ({ page }) => {
  expect((await post(page, '/__support/forget-investigations')).ok()).toBe(true);
  expect((await post(page, '/__support/sources', { 'banking-demo': { demoCase: DEMO_CASE } })).ok()).toBe(true);
});

test.afterEach(async ({ page }) => {
  await post(page, '/__support/reset');
  await post(page, '/__support/forget-investigations');
});

test.describe('the steps of the README Quickstart, in the built app', () => {
  test('first page, the demo case, the expand menu, the evidence panel, the Investigations page, close, export and delete', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: quoted('Investigations'), level: 1 })).toBeVisible();
    await expect(page.getByText(quoted('No sign-in'), { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: quoted('No investigations yet'), level: 2 })).toBeVisible();
    await page.getByRole('button', { name: /^Open demo case/ }).click();
    await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
    await expect(page.getByText(DEMO_CASE.caseRef)).toBeVisible();

    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('ContextMenu');
    for (const label of ['Expand neighbors', 'Expand by neighbor type']) {
      await expect(menuOf(page).first().getByRole('menuitem', { name: quoted(label), exact: true })).toBeVisible();
    }
    await page.keyboard.press('Escape');

    const header = page.getByRole('banner', { name: 'Investigation' });
    await page.getByRole('button', { name: 'Investigation menu' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Rename', 'Close', 'Archive', 'Delete'].map(quoted));
    await page.getByRole('menuitem', { name: 'Close' }).click();
    await expect(header.getByText(quoted('Closed · read-only'))).toBeVisible();
    await expect(page.getByRole('region', { name: 'Request status' })).toContainText('This investigation is closed and read-only.');
    await page.getByRole('button', { name: quoted('Reopen') }).click();
    await expect(header.getByText('Closed · read-only')).toHaveCount(0);

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: quoted('Export current view') });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: quoted('JSON') })).toBeVisible();
    await expect(dialog.getByRole('radio', { name: quoted('CSV') })).toBeVisible();
    await expect(dialog.getByRole('button', { name: quoted('Download JSON') })).toBeVisible();
    await expect(dialog.getByText(quoted('Exports are partial views, not signed evidence.'))).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('link', { name: 'Investigations', exact: true }).first().click();
    await expect(page).toHaveURL(/\/investigations$/);
    for (const column of ['Title and referral', 'Starting entity', 'Source', 'Last edited (UTC)', 'Entities / relationships', 'Actions']) {
      await expect(page.getByRole('columnheader', { name: quoted(column) })).toBeVisible();
    }
    await expect(page.locator('.investigations-table tbody tr').first()).toContainText(DEMO_CASE.caseRef);
    const row = page.getByRole('button', { name: /^Actions for / });
    await row.click();
    for (const item of ['Open', 'Rename', 'Close', 'Archive', 'Delete']) await expect(page.getByRole('menuitem', { name: quoted(item), exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(readme).toContain('"Actions for" and the title');

    await page.getByRole('link', { name: /account DEMO-1/ }).click();
    await page.getByRole('button', { name: 'Investigation menu' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: quoted('Delete this investigation?') });
    await confirm.getByRole('button', { name: quoted('Delete investigation') }).click();
    await expect(page).toHaveURL(/\/investigations$/);
    await page.getByRole('button', { name: quoted('Deleted') }).click();
    await expect(page.getByText(/Deleted ones stay restorable for \d+ days\./)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Restore/ }).first()).toBeVisible();
    quoted('Restore');
  });

  test('the evidence menu item and the panel with its tabs, on the sample the existing trust cases use', async ({ page }) => {
    await sampleEnvironment.openEntity(page);
    await sampleEnvironment.reaches[0]?.open(page);
    const panel = evidenceOf(page);
    await expect(panel).toBeVisible();
    await expect(page.getByRole('complementary', { name: quoted('Relationship evidence') })).toBeVisible();
    for (const tab of ['Evidence', 'Properties', 'Source']) await expect(panel.getByRole('tab', { name: quoted(tab) })).toBeVisible();
    await expect(panel.getByText(quoted('Stored relationship'))).toBeVisible();
    quoted('Why is this relationship here?');
  });
});
