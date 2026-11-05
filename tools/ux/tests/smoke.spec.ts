import { expect, test } from '@playwright/test';

test('the built app draws the frame sample canvas', async ({ page }) => {
  await page.goto('/dev/frame-sample');
  const canvas = page.getByRole('application', { name: 'Graph canvas' });
  await expect(canvas).toHaveAttribute('data-drawn-entities', '10');
  await expect(canvas).toHaveAttribute('data-drawn-relationships', '13');
});
