import { expect, test, type Page } from '@playwright/test';
import { canvasOf } from './support/workspace.ts';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });

test('the masking switch masks the personal name in the Properties tab and the title, and turns it back, with the inspector open', async ({ page }) => {
  await page.goto('/banking-demo/entity/customer/pii-1');
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  await expect(canvasOf(page)).toBeVisible();
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await inspector(page).getByRole('tab', { name: 'Properties' }).click();
  const control = inspector(page).getByRole('switch', { name: 'Mask sensitive values' });
  await expect(control).not.toBeChecked();
  await expect(inspector(page).getByText('Ana Silva').first()).toBeVisible();

  await control.focus();
  await page.keyboard.press('Space');
  await expect(inspector(page).getByRole('switch', { name: 'Mask sensitive values' })).toBeChecked();
  await expect(inspector(page).getByText('A••• S•••').first()).toBeVisible();
  await expect(inspector(page).getByRole('switch', { name: 'Mask sensitive values' })).toBeFocused();
  await expect(page.getByText('Ana Silva')).toHaveCount(0);

  await page.keyboard.press('Space');
  await expect(inspector(page).getByText('Ana Silva').first()).toBeVisible();
  await expect(page.getByText('A••• S•••')).toHaveCount(0);
  await expect(inspector(page)).toBeVisible();
});
