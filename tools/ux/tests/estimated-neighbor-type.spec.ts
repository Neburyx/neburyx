import { expect, test } from '@playwright/test';
import { menuOf, openSample, screenOf } from './support/workspace.ts';

const estimated = { value: 10_000, quality: 'estimated', scope: 'degree:neighbor:mapped-relationship-ends', observedAt: '2026-01-02T03:04:05Z' };
const exact = { value: 3, quality: 'exact', scope: 'degree:neighbor:mapped-relationship-ends' };

test.describe('the neighbor types submenu with an estimated count', () => {
  test.beforeEach(async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
      await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, total: estimated, byType: [], byNeighborType: [{ entityType: body.ref.entityType, count: estimated }, { entityType: 'other-kind', count: exact }], warnings: [], pageSize: 25, heavyOpThreshold: 500 } });
    });
  });

  test('says the type is estimated, says more can be loaded page by page, shows no date, and leaves an exact row without the note', async ({ page }) => {
    await openSample(page);
    const at = await screenOf(page, 'holder');
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await menuOf(page).first().getByRole('menuitem', { name: 'Expand by neighbor type' }).click();
    const rows = page.locator('.neighbor-types-item');
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toContainText('~');
    await expect(rows.first().locator('.neighbor-types-paged')).toHaveText('More can be loaded page by page.');
    await expect(rows.nth(1).locator('.neighbor-types-paged')).toHaveCount(0);
    expect(await page.locator('.context-submenu').innerText()).not.toContain('2026-01-02');
    const shot = process.env['NEBURYX_UX_SHOT'];
    if (shot !== undefined) await page.screenshot({ path: shot });
  });
});
