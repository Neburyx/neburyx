import { expect, test, type Page } from '@playwright/test';
import { boxOf } from './support/regions.ts';
import { announcement, canvasOf, menuItems, menuOf, openSample, screenOf } from './support/workspace.ts';

const panel = (page: Page) => page.getByRole('complementary', { name: 'Relationship evidence' });
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });

async function rightClickBetween(page: Page, from: string, to: string): Promise<void> {
  const a = await screenOf(page, from);
  const b = await screenOf(page, to);
  await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2, { button: 'right' });
  await expect(menuOf(page)).toHaveCount(1);
}

/** Walks the canvas, element by element, to the first relationship of the sample. */
async function walkToRelationship(page: Page): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    if (((await announcement(page).textContent()) ?? '').startsWith('HAS_LINE')) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('NEVER_REACHED_BY_THE_WALK');
}

const choose = (page: Page, name: string | RegExp) => menuOf(page).getByRole('menuitem', { name }).click();

test.describe('the relationship evidence panel', () => {
  test('opens from the relationship menu, takes focus on its Evidence tab, and Esc closes it with the focus back on the canvas', async ({ page }) => {
    await openSample(page, '?evidence=on');
    await rightClickBetween(page, 'holder', 'led-1');
    expect(await menuItems(page)).toEqual(expect.arrayContaining(['Why is this relationship here?', 'View supporting records']));
    await choose(page, /Why is this relationship here/);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('heading', { name: 'Relationship evidence' })).toBeVisible();
    await expect(panel(page).getByRole('tab')).toHaveText(['Evidence', 'Properties', 'Source']);
    await expect(panel(page).getByRole('heading', { name: 'Why is this relationship here?' })).toBeVisible();
    await expect(panel(page).getByText('REC-1')).toBeVisible();
    await expect(panel(page).getByRole('tab', { name: 'Evidence' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(canvasOf(page)).toBeFocused();
  });

  test('opens by keyboard alone: the menu key on the selected relationship, then Enter on the first row', async ({ page }) => {
    await openSample(page, '?evidence=on');
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await walkToRelationship(page);
    await page.keyboard.press('Space');
    await expect(announcement(page)).toHaveText('HAS_LINE, from Jordan Lee to LIN-1042');
    await page.keyboard.press('ContextMenu');
    await expect(menuOf(page)).toHaveCount(1);
    await expect(menuOf(page).getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText('REC-sample-r-0')).toBeVisible();
    await expect(panel(page).getByRole('tab', { name: 'Evidence' })).toBeFocused();
  });

  test('without the menu, Enter on the canvas still starts the walk with a relationship selected', async ({ page }) => {
    await openSample(page, '?evidence=on');
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await walkToRelationship(page);
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect(announcement(page)).toHaveText('');
    await page.keyboard.press('Enter');
    await expect(announcement(page)).not.toHaveText('');
    await expect(panel(page)).toHaveCount(0);
  });

  test('opens from a row of the inspector Evidence tab, the inspector staying, and Esc returns the focus to the row', async ({ page }) => {
    await openSample(page, '?evidence=on');
    const at = await screenOf(page, 'led-1');
    await page.mouse.click(at.x, at.y);
    await expect(inspector(page)).toBeVisible();
    await expect(inspector(page).getByRole('tab')).toHaveText(['Overview', 'Relationships', 'Properties', 'Evidence']);
    await inspector(page).getByRole('tab', { name: 'Evidence' }).click();
    const row = inspector(page).getByRole('button', { name: /^SENDS,/ });
    await row.click();
    await expect(panel(page)).toBeVisible();
    await expect(inspector(page)).toBeVisible();
    await expect(panel(page).getByRole('tab', { name: 'Evidence' })).toBeFocused();
    await expect(row).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test('shows Evidence not available as an ordinary state, with Properties and Source still there', async ({ page }) => {
    await openSample(page, '?evidence=on');
    await rightClickBetween(page, 'holder', 'cas');
    await choose(page, /Why is this relationship here/);
    await expect(panel(page).getByText('Evidence not available')).toBeVisible();
    await expect(panel(page).getByText('For legacy edges without retained source records.')).toBeVisible();
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
    await panel(page).getByRole('tab', { name: 'Properties' }).click();
    await expect(panel(page).getByText('21 Oct 2026, 08:15:00 UTC')).toBeVisible();
    await panel(page).getByRole('tab', { name: 'Source' }).click();
    await expect(panel(page).getByText('Source is read-only').first()).toBeVisible();
  });

  test('shows a failed read in the panel, leaves the canvas as it was, and reads again on Try again', async ({ page }) => {
    await openSample(page, '?evidence=on');
    await rightClickBetween(page, 'cas', 'trn');
    await choose(page, /Why is this relationship here/);
    await expect(panel(page).getByRole('alert')).toContainText('SOURCE_BUSY');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '10');
    await panel(page).getByRole('button', { name: 'Try again' }).click();
    await expect(panel(page).getByText('REC-sample-r-3')).toBeVisible();
    await expect(panel(page).getByRole('alert')).toHaveCount(0);
  });

  test('keeps the Legend, the inspector and the dock from overlapping, and the page from scrolling sideways', async ({ page }) => {
    await openSample(page, '?evidence=on');
    await page.keyboard.press('l');
    const legend = page.getByRole('complementary', { name: 'Legend' });
    await expect(legend).toBeVisible();
    const at = await screenOf(page, 'led-1');
    await page.mouse.click(at.x, at.y);
    await inspector(page).getByRole('tab', { name: 'Evidence' }).click();
    await inspector(page).getByRole('button', { name: /^SENDS,/ }).click();
    await expect(panel(page)).toBeVisible();
    const boxes = [await boxOf(legend), await boxOf(inspector(page)), await boxOf(panel(page))];
    for (const [index, first] of boxes.entries()) {
      for (const second of boxes.slice(index + 1)) {
        const apart = first.x + first.width <= second.x + 0.5 || second.x + second.width <= first.x + 0.5 || first.y + first.height <= second.y + 0.5 || second.y + second.height <= first.y + 0.5;
        expect(apart, `${JSON.stringify(first)} overlaps ${JSON.stringify(second)}`).toBe(true);
      }
    }
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBe(0);
  });
});
