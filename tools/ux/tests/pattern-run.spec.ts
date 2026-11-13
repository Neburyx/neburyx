import { expect, test, type Page } from '@playwright/test';
import { drawing, openOneEntity } from './support/workspace.ts';
import { patternBuilder, patternsPanel as panelOf, previewTwoSteps } from './support/pattern-editor.ts';

const SOURCE = 'banking-demo';

const runOf = (page: Page) => panelOf(page).getByRole('button', { name: 'Run pattern' });
const headingOf = (page: Page, name: string) => panelOf(page).getByRole('heading', { name });
const countOf = (page: Page) => panelOf(page).getByRole('status').filter({ hasText: /matches? ·|matches?$|At least/ }).first();

/** Opens the entity `id`, builds Account → Device ← Account with choices only and shows it on the preview screen. */
async function previewed(page: Page, id: string): Promise<void> {
  await openOneEntity(page, SOURCE, id);
  await previewTwoSteps(page);
}

test.describe('running a pattern built in the panel', () => {
  test('shows the pattern in words on the preview, then the count, the path of each match, the notices and the evidence', async ({ page }) => {
    await previewed(page, 'AC-1');
    await expect(panelOf(page).getByText('Draft · not saved')).toBeVisible();
    await expect(panelOf(page).locator('.run-ok')).toHaveText('✓ The mapping can follow this pattern');
    await expect(panelOf(page).getByText('Starts at a account.')).toBeVisible();
    await expect(panelOf(page).getByText('Follows USES_DEVICE outgoing to a device.')).toBeVisible();
    await expect(panelOf(page).locator('.run-bounds')).toHaveText('Read-only · up to 50 matches per page · a count above 500 shows as “at least 500”');
    await expect(runOf(page)).toBeEnabled();
    await runOf(page).click();
    await expect(headingOf(page, 'Pattern result')).toBeVisible();
    await expect(countOf(page)).toHaveText('2 matches · Exact');
    const cards = panelOf(page).locator('.run-match');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0).getByRole('list', { name: 'Path' })).toContainText('MID-1');
    await expect(cards.nth(1).getByRole('list', { name: 'Path' })).toContainText('an entity without an ID');
    await expect(cards.nth(1).getByRole('list', { name: 'Path' })).toContainText('a relationship');
    await expect(panelOf(page)).toContainText('1 supernode was not traversed.');
    await expect(panelOf(page)).toContainText('The window did not apply to 1 relationship type.');
    await cards.nth(0).getByRole('button', { name: /^Evidence/ }).click();
    await expect(cards.nth(0)).toContainText('AUTH-77300');
  });

  test('walks the start field, Edit, Run pattern and Save pattern with Tab on the preview, and back with Shift+Tab', async ({ page }) => {
    await previewed(page, 'AC-1');
    const start = panelOf(page).getByRole('combobox', { name: 'Start from: Account' });
    const save = panelOf(page).getByRole('button', { name: 'Save pattern…' });
    const edit = panelOf(page).getByRole('button', { name: 'Edit' });
    await start.focus();
    await page.keyboard.press('Tab');
    await expect(save).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(edit).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(runOf(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(save).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(start).toBeFocused();
  });

  test('stops a heavy run with Refine filters and Continue with 25, and Continue shows the page as a lower bound', async ({ page }) => {
    await previewed(page, 'HEAVY-1');
    await runOf(page).click();
    await expect(headingOf(page, 'Run paused')).toBeVisible();
    await expect(panelOf(page).getByText('Estimated ≥ 500 matches')).toBeVisible();
    await expect(panelOf(page).getByText('The run stopped before reading matches, to protect the source. Nothing was changed.')).toBeVisible();
    await expect(panelOf(page).locator('.run-match')).toHaveCount(0);
    await panelOf(page).getByRole('button', { name: 'Refine filters' }).click();
    await expect(patternBuilder(page)).toBeVisible();
    await panelOf(page).getByRole('button', { name: 'Preview' }).click();
    await runOf(page).click();
    await panelOf(page).getByRole('button', { name: 'Continue with 25' }).first().click();
    await expect(headingOf(page, 'Pattern result')).toBeVisible();
    await expect(panelOf(page).locator('.run-match')).toHaveCount(2);
  });

  test('adds the result once: the second press finds it on the canvas, and a cancelled run adds nothing', async ({ page }) => {
    await previewed(page, 'AC-1');
    await runOf(page).click();
    await expect(headingOf(page, 'Pattern result')).toBeVisible();
    const before = (await drawing(page)).nodes.length;
    await panelOf(page).getByRole('button', { name: 'Add all 2 to graph' }).click();
    await expect(panelOf(page).getByText(/^Added \d+ entities? and \d+ relationships?\./)).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'On the graph' })).toBeDisabled();
    await expect(panelOf(page).getByText('On the graph').first()).toBeVisible();
    const added = (await drawing(page)).nodes.length;
    expect(added).toBeGreaterThan(before);
    await panelOf(page).getByRole('button', { name: 'Edit pattern' }).click();
    await panelOf(page).getByRole('button', { name: 'Preview' }).click();
    await runOf(page).click();
    await expect(panelOf(page).getByRole('button', { name: 'On the graph' })).toBeDisabled();
    expect((await drawing(page)).nodes.length).toBe(added);
  });

  test('shows Running with Cancel run focused, and adds nothing when the run is cancelled', async ({ page }) => {
    await previewed(page, 'SLOW-1');
    const before = (await drawing(page)).nodes.length;
    await runOf(page).click();
    await expect(headingOf(page, 'Running pattern')).toBeVisible();
    await expect(panelOf(page).getByText(/s elapsed\. Large sources can take longer\./)).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Cancel run' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panelOf(page).getByText('Run cancelled. Nothing was added to the graph. Your draft is kept.')).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Run again' })).toBeVisible();
    await expect(panelOf(page).locator('.run-match')).toHaveCount(0);
    expect((await drawing(page)).nodes.length).toBe(before);
  });

  test('says the source is busy and keeps the pattern on the preview', async ({ page }) => {
    await previewed(page, 'BUSY-1');
    await runOf(page).click();
    await expect(panelOf(page).getByText(/is busy\./)).toBeVisible();
    await expect(runOf(page)).toBeVisible();
    await expect(panelOf(page).getByText('Follows USES_DEVICE outgoing to a device.')).toBeVisible();
  });

  test('says so plainly for an empty result and offers another start', async ({ page }) => {
    await previewed(page, 'EMPTY-1');
    await runOf(page).click();
    await expect(countOf(page)).toHaveText('0 matches · Exact');
    await expect(panelOf(page)).toContainText('Nothing in this source follows this pattern from');
    await expect(panelOf(page).getByRole('button', { name: 'Run from another Account' })).toBeVisible();
    await expect(panelOf(page).locator('.run-match')).toHaveCount(0);
  });

  test('reads a second page with Next, keeps the first for Previous, and words the later page as a lower bound', async ({ page }) => {
    await previewed(page, 'PAGED-1');
    await runOf(page).click();
    await expect(countOf(page)).toHaveText('4 matches · Exact');
    await expect(panelOf(page).getByRole('heading', { name: /^Matches · showing 1 to 2 of 4/ })).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Previous' })).toBeDisabled();
    await panelOf(page).getByRole('button', { name: /^Next/ }).click();
    await expect(countOf(page)).toHaveText('At least 4 matches · Lower bound');
    await expect(panelOf(page).getByRole('heading', { name: /^Match 3$/ })).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: /^Next/ })).toBeDisabled();
    await panelOf(page).getByRole('button', { name: /^Previous/ }).click();
    await expect(countOf(page)).toHaveText('4 matches · Exact');
  });

  test('keeps every control and the result inside the window, the panel scrolling inside itself', async ({ page }) => {
    await previewed(page, 'AC-1');
    await runOf(page).click();
    await expect(headingOf(page, 'Pattern result')).toBeVisible();
    const size = page.viewportSize();
    const box = await panelOf(page).boundingBox();
    expect(box, 'the panel is drawn').not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(size?.height ?? 0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size?.width ?? 0);
    await panelOf(page).getByRole('button', { name: 'Add all 2 to graph' }).scrollIntoViewIfNeeded();
    await expect(panelOf(page).getByRole('button', { name: 'Add all 2 to graph' })).toBeVisible();
  });
});
