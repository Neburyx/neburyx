import { expect, test, type Page } from '@playwright/test';
import { canvasOf, drawing, menuItems, menuOf, openSample, screenOf } from './support/workspace.ts';

const panel = (page: Page) => page.getByRole('complementary', { name: 'Relationship evidence' });

async function rightClickBetween(page: Page, from: string, to: string): Promise<void> {
  const a = await screenOf(page, from);
  const b = await screenOf(page, to);
  await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2, { button: 'right' });
  await expect(menuOf(page)).toHaveCount(1);
}

test.describe('the evidence of an aggregate relationship', () => {
  test('is drawn as a bold relationship labelled with its type and count, as frame 74 draws it up to the quality label', async ({ page }) => {
    await openSample(page);
    const bold = (await drawing(page)).edges.filter((edge) => edge.width === 3.5);
    expect(bold.map((edge) => edge.label)).toEqual(['USES_GADGET · 42 · exact']);
  });

  test('opens from the relationship menu with the keyboard, shows its own count of all members beside the canvas label of the drawn ones, the dates and the sample with no link, and Esc closes it with the focus back on the canvas', async ({ page }) => {
    await openSample(page, '?evidence=on');
    expect((await drawing(page)).edges.filter((edge) => edge.width === 3.5).map((edge) => edge.label)).toEqual(['USES_GADGET · 42 · exact']);
    await rightClickBetween(page, 'led-1', 'gad-1');
    expect(await menuItems(page)).toEqual(expect.arrayContaining(['Why is this relationship here?', 'View supporting records']));
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText('Aggregate relationship')).toBeVisible();
    await expect(panel(page).getByText('Members 57 · exact')).toBeVisible();
    await expect(panel(page).getByText("Counts every USES_GADGET relationship between these two, whatever the view's filters.")).toBeVisible();
    await expect(panel(page).getByText('Sample · first 3 by most recent observed time')).toBeVisible();
    await expect(panel(page).getByText('… 54 more in this sample. There is no paging.')).toBeVisible();
    await expect(panel(page).getByRole('link')).toHaveCount(0);
    await expect(panel(page).getByRole('tab', { name: 'Evidence' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(canvasOf(page)).toBeFocused();
  });
});
