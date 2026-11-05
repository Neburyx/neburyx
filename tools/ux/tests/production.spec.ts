import { expect, test } from '@playwright/test';

const PRODUCTION = 'http://127.0.0.1:4174';
const UX = 'http://127.0.0.1:4173';

test.describe('the production build', () => {
  test('has no fixture page: its address shows the page that does not exist', async ({ page }) => {
    await page.goto(`${PRODUCTION}/dev/fixture`);
    await expect(page.getByText('Page not found')).toBeVisible();
    await expect(page.getByText('Fixture graph')).toHaveCount(0);
    await page.goto(`${PRODUCTION}/dev/frame-sample`);
    await expect(page.getByText('Page not found')).toBeVisible();
  });

  test('draws a canvas with no development read-out and none of the functions a recorded run reads it by', async ({ page }) => {
    await page.goto(`${PRODUCTION}/explore`);
    const canvas = page.getByRole('application', { name: 'Graph canvas' });
    await expect(canvas, 'the canvas is there, so an absent attribute is not a missed element').toBeVisible();
    expect(await canvas.getAttribute('data-dev-readout')).toBeNull();
    for (const name of ['readDrawnPositions', 'inspectDrawing']) expect(await canvas.evaluate((element, hook) => typeof Reflect.get(element, hook), name), name).toBe('undefined');
  });
});

test.describe('the build of the tests, as the control of the production checks', () => {
  test('does have the fixture page, and a canvas with the read-out and the functions', async ({ page }) => {
    await page.goto(`${UX}/dev/fixture`);
    await expect(page.getByText('Fixture graph')).toBeVisible();
    await page.goto(`${UX}/explore`);
    const canvas = page.getByRole('application', { name: 'Graph canvas' });
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute('data-dev-readout', /.+/);
    for (const name of ['readDrawnPositions', 'inspectDrawing']) expect(await canvas.evaluate((element, hook) => typeof Reflect.get(element, hook), name), name).toBe('function');
  });
});
