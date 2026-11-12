import { expect, test, type Page } from '@playwright/test';
import { canvasOf } from './support/workspace.ts';

const HINT = 'Select the entity and press E, or right-click it, to load its neighbors';

async function openOneEntity(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
}

test.describe('the hint on a canvas that shows only the starting entity', () => {
  test('shows beside the entity without covering it, reads as a status, takes no focus, and goes when an expansion has loaded', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/graph/expand', async (route) => {
      const body = route.request().postDataJSON() as { readonly sourceId: string; readonly ref: { readonly entityType: string; readonly stableId: string }; readonly neighborTypes: readonly string[] };
      const type = body.neighborTypes[0] ?? body.ref.entityType;
      const anchor = { sourceId: body.sourceId, ...body.ref };
      const neighbor = { sourceId: body.sourceId, entityType: type, stableId: 'N-1' };
      await route.fulfill({
        json: {
          ref: anchor,
          pageSize: 25,
          nodes: [{ ref: neighbor, display: { title: `${type} N-1`, type }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } }],
          edges: [],
          pages: body.neighborTypes.map((neighborType) => ({ neighborType, returned: neighborType === type ? 1 : 0, hasMore: false, matchingTotal: { value: neighborType === type ? 1 : 0, quality: 'exact', scope: 'x' } })),
          warnings: [],
        },
      });
    });
    await openOneEntity(page);
    const hint = page.getByRole('status').filter({ hasText: HINT });
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText(HINT);
    const hintBox = await hint.boundingBox();
    const canvasBox = await canvasOf(page).boundingBox();
    if (hintBox === null || canvasBox === null) throw new Error('NO_BOX');
    const centre = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
    const covers = hintBox.x <= centre.x && centre.x <= hintBox.x + hintBox.width && hintBox.y <= centre.y && centre.y <= hintBox.y + hintBox.height;
    expect(covers, 'the hint sits over the centre, where the entity is drawn').toBe(false);
    await expect(hint).not.toBeFocused();

    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('e');
    await expect(hint).toHaveCount(0);
  });
});
