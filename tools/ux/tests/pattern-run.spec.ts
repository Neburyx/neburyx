import { expect, test, type Page } from '@playwright/test';
import { drawing, openOneEntity } from './support/workspace.ts';
import { buildStepThroughUi } from './support/pattern-editor.ts';

const SOURCE = 'banking-demo';

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Patterns' });
const builderOf = (page: Page) => panelOf(page).getByRole('region', { name: 'New pattern' });
const stepOf = (page: Page, n: number) => builderOf(page).getByRole('tabpanel', { name: `Step ${n}` });
const runOf = (page: Page) => builderOf(page).getByRole('button', { name: 'Run pattern' });
const resultOf = (page: Page) => builderOf(page).getByRole('region', { name: 'Result' });

const buildStep = (page: Page, n: number, direction: string, arrivesAt: string, types: readonly string[]): Promise<void> => buildStepThroughUi(page, builderOf(page), n, direction, arrivesAt, types);

/** Opens the builder on the entity `id` and builds Account → Device ← Account with choices only; the preview and the check have answered when it returns. */
async function built(page: Page, id: string): Promise<void> {
  await openOneEntity(page, SOURCE, id);
  await page.getByRole('button', { name: 'Patterns', exact: true }).click();
  await panelOf(page).getByRole('button', { name: 'New pattern' }).click();
  await builderOf(page).getByLabel('Starting entity type').selectOption({ label: 'Account' });
  await buildStep(page, 1, 'out', 'Device', ['USES_DEVICE']);
  await buildStep(page, 2, 'in', 'Account', ['USES_DEVICE']);
  await expect(builderOf(page).getByRole('region', { name: 'Preview' })).toBeVisible();
}

test.describe('running a pattern built in the panel', () => {
  test('shows the pattern in words before the first run, then the count, the path of each match, the notices and the evidence', async ({ page }) => {
    await built(page, 'AC-1');
    const preview = builderOf(page).getByRole('region', { name: 'Preview' });
    await expect(preview).toContainText('Starts at a account.');
    await expect(preview).toContainText('Follows USES_DEVICE outgoing to a device.');
    await expect(preview).toContainText('At most 4 steps.');
    await expect(runOf(page)).toBeEnabled();
    await runOf(page).click();
    await expect(resultOf(page).getByRole('status').first()).toHaveText('2 · exact');
    const rows = resultOf(page).getByRole('row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText('USES_DEVICE → MID-1 → USES_DEVICE');
    await expect(rows.nth(2)).toContainText('a relationship → an entity without an ID → USES_DEVICE');
    await expect(resultOf(page)).toContainText('1 supernode was not traversed.');
    await expect(resultOf(page)).toContainText('The window did not apply to 1 relationship type.');
    await expect(resultOf(page)).toContainText('AUTH-77300, AUTH-77301');
  });

  test('walks Starts from, its search, Run pattern and Add to graph with Tab and back with Shift+Tab', async ({ page }) => {
    await built(page, 'AC-1');
    await runOf(page).click();
    await expect(resultOf(page)).toBeVisible();
    const start = builderOf(page).getByLabel('Starts from');
    const search = builderOf(page).getByRole('searchbox', { name: 'Search the source' }).last();
    const add = resultOf(page).getByRole('button', { name: 'Add to graph' });
    await start.focus();
    await page.keyboard.press('Tab');
    await expect(search).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(runOf(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(add).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(runOf(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(search).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(start).toBeFocused();
  });

  test('stops a heavy run with Refine filters and Continue with 25, and Continue shows the page', async ({ page }) => {
    await built(page, 'HEAVY-1');
    await runOf(page).click();
    await expect(builderOf(page).getByText('Estimated ≥ 500 matches · warning threshold 500')).toBeVisible();
    await expect(builderOf(page).getByText('Refine filters or continue with a bounded limit of 25.')).toBeVisible();
    await expect(resultOf(page)).toHaveCount(0);
    await builderOf(page).getByRole('button', { name: 'Refine filters' }).click();
    await expect(builderOf(page).getByLabel('Starting entity type')).toBeFocused();
    await runOf(page).click();
    await builderOf(page).getByRole('button', { name: 'Continue with 25' }).click();
    await expect(resultOf(page)).toBeVisible();
    await expect(builderOf(page).getByText(/Estimated/)).toHaveCount(0);
  });

  test('adds the result once: the second press finds it on the canvas, and a cancelled run adds nothing', async ({ page }) => {
    await built(page, 'AC-1');
    await runOf(page).click();
    const before = (await drawing(page)).nodes.length;
    await resultOf(page).getByRole('button', { name: 'Add to graph' }).click();
    await expect(resultOf(page).getByText(/^Added \d+ entities? and \d+ relationships?\./)).toBeVisible();
    await expect(resultOf(page).getByRole('button', { name: 'On canvas' })).toBeDisabled();
    const added = (await drawing(page)).nodes.length;
    expect(added).toBeGreaterThan(before);
    await runOf(page).click();
    await expect(resultOf(page).getByRole('button', { name: /Add to graph|On canvas/ })).toBeVisible();
    expect((await drawing(page)).nodes.length).toBe(added);
  });

  test('shows Running with Cancel and adds nothing when the run is cancelled', async ({ page }) => {
    await built(page, 'SLOW-1');
    const before = (await drawing(page)).nodes.length;
    await runOf(page).click();
    await expect(builderOf(page).getByText(/^Running/)).toBeVisible();
    await builderOf(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(builderOf(page).getByText('Cancelled. No new matches shown.')).toBeVisible();
    await expect(resultOf(page)).toHaveCount(0);
    expect((await drawing(page)).nodes.length).toBe(before);
  });

  test('says the source is busy and keeps the pattern', async ({ page }) => {
    await built(page, 'BUSY-1');
    await runOf(page).click();
    await expect(builderOf(page).getByText(/is busy\. No read slot freed within the wait\./)).toBeVisible();
    await expect(stepOf(page, 2)).toBeVisible();
  });

  test('says so plainly for an empty result', async ({ page }) => {
    await built(page, 'EMPTY-1');
    await runOf(page).click();
    await expect(resultOf(page)).toContainText('No matches found.');
    await expect(resultOf(page).getByRole('table')).toHaveCount(0);
  });

  test('keeps every control and the result inside the window, the panel scrolling inside itself', async ({ page }) => {
    await built(page, 'AC-1');
    await runOf(page).click();
    await expect(resultOf(page)).toBeVisible();
    const size = page.viewportSize();
    const box = await panelOf(page).boundingBox();
    expect(box, 'the panel is drawn').not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(size?.height ?? 0);
    await resultOf(page).getByRole('button', { name: 'Add to graph' }).scrollIntoViewIfNeeded();
    await expect(resultOf(page).getByRole('button', { name: 'Add to graph' })).toBeVisible();
  });
});
