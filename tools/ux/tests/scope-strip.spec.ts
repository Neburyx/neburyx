import { expect, test, type Page } from '@playwright/test';
import { canvasOf } from './support/workspace.ts';

async function openWorkspace(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
}

const boxOf = async (page: Page, selector: string) => {
  const box = await page.locator(selector).boundingBox();
  const region = await page.locator('.canvas-region').boundingBox();
  return { top: (box?.y ?? 0) - (region?.y ?? 0), bottom: (box?.y ?? 0) + (box?.height ?? 0) - (region?.y ?? 0), height: box?.height ?? 0 };
};

test.describe('the tool strip under the scope lines', () => {
  test('stays 64 px below the top of the canvas while the scope lines take two lines', async ({ page }) => {
    await openWorkspace(page);
    expect((await boxOf(page, '.region-tool-strip')).top).toBe(64);
  });

  test('starts 4 px below the scope lines when they wrap to three lines, and nothing of them is hidden behind it', async ({ page }) => {
    await openWorkspace(page);
    const lineHeight = (await boxOf(page, '.graph-scope')).height;
    await page.locator('.graph-scope').evaluate((element) => {
      const line = document.createElement('p');
      line.textContent = 'a long scope line '.repeat(40);
      element.appendChild(line);
    });
    await expect.poll(async () => (await boxOf(page, '.graph-scope')).height).toBeGreaterThan(lineHeight);
    await expect
      .poll(async () => Math.round((await boxOf(page, '.region-tool-strip')).top - (await boxOf(page, '.graph-scope')).bottom))
      .toBe(4);
    expect((await boxOf(page, '.region-tool-strip')).top).toBeGreaterThan(64);
  });
});
