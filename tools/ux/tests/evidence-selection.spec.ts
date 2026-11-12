import { expect, test, type Page } from '@playwright/test';
import { announcement, canvasOf, openSample, screenOf } from './support/workspace.ts';

const panel = (page: Page) => page.getByRole('complementary', { name: 'Relationship evidence' });

async function clickBetween(page: Page, from: string, to: string): Promise<void> {
  const a = await screenOf(page, from);
  const b = await screenOf(page, to);
  await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2);
}

test.describe('selecting a relationship', () => {
  test('opens the relationship evidence panel with one click, and closes it when the selection is cleared', async ({ page }) => {
    await openSample(page, '?evidence=on');
    await expect(panel(page)).toHaveCount(0);
    await clickBetween(page, 'holder', 'led-1');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText('REC-1')).toBeVisible();
    await expect(panel(page).getByText('Selected relationship · source is read-only')).toBeVisible();
    const box = await canvasOf(page).boundingBox();
    if (box === null) throw new Error('NO_BOX');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12);
    await expect(panel(page)).toHaveCount(0);
  });

  test('opens from the keyboard walk without taking the focus, and Esc on the canvas clears the selection and closes it', async ({ page }) => {
    await openSample(page, '?evidence=on');
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    for (let step = 0; step < 40; step += 1) {
      if (((await announcement(page).textContent()) ?? '').startsWith('HAS_LINE')) break;
      await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Space');
    await expect(panel(page)).toBeVisible();
    await expect(canvasOf(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
  });

  test('closes with Esc inside it, returning the focus to the canvas, and does not open again until the selection changes', async ({ page }) => {
    await openSample(page, '?evidence=on');
    await clickBetween(page, 'holder', 'led-1');
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('tab', { name: 'Evidence' }).focus();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(canvasOf(page)).toBeFocused();
    await page.waitForTimeout(300);
    await expect(panel(page)).toHaveCount(0);
  });

  test('opens nothing for an entity or for several elements', async ({ page }) => {
    await openSample(page, '?evidence=on');
    const holder = await screenOf(page, 'holder');
    await page.mouse.click(holder.x, holder.y);
    await expect(panel(page)).toHaveCount(0);
    const other = await screenOf(page, 'led-1');
    await page.keyboard.down('Shift');
    await page.mouse.click(other.x, other.y);
    await page.keyboard.up('Shift');
    await expect(panel(page)).toHaveCount(0);
  });
});
