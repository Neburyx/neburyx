import { expect, test, type Page } from '@playwright/test';
import { canvasOf, menuOf, openSample } from './support/workspace.ts';

const total = { value: 3, quality: 'exact', scope: 'relationships' };

interface CoverageBody {
  readonly sourceId: string;
  readonly entities: readonly unknown[];
}

test.describe('the scope lines', () => {
  let previewed = 0;
  let asked: CoverageBody[] = [];

  test.beforeEach(async ({ page }) => {
    previewed = 0;
    asked = [];
    await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
      previewed += 1;
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
      await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, total, byType: [], byNeighborType: [{ entityType: body.ref.entityType, count: total }], warnings: [], pageSize: 25 } });
    });
    await page.route((url) => url.pathname === '/v1/graph/coverage', async (route) => {
      asked.push(route.request().postDataJSON() as CoverageBody);
      const notRetrieved = previewed === 0 ? { quality: 'unknown', scope: 'not yet retrieved' } : { value: 3, quality: 'lowerBound', scope: 'not yet retrieved' };
      await route.fulfill({ json: { notRetrieved } });
    });
  });

  const remainder = (page: Page) => page.locator('.graph-scope p').nth(1);

  test('carry no number until the server has one, then show the lower bound of the previewed node with its label, and keep the focus where it was', async ({ page }) => {
    await openSample(page);
    await expect(remainder(page)).toHaveText('10 shown · more not yet retrieved');
    expect(asked[0]?.entities).toHaveLength(10);

    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Expand by type' }).focus();
    await page.keyboard.press('ArrowRight');
    const rows = page.locator('.neighbor-types-row');
    await expect(rows.first()).toBeFocused();

    await expect(remainder(page)).toHaveText('10 shown · ≥ 3 not yet retrieved (lower bound)');
    await expect(rows.first()).toBeFocused();
    expect(asked.length).toBeGreaterThanOrEqual(2);
  });
});
