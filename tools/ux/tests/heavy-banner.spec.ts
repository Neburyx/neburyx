import { expect, test, type Page } from '@playwright/test';
import { canvasOf } from './support/workspace.ts';

interface ExpandBody {
  readonly sourceId: string;
  readonly ref: { readonly entityType: string; readonly stableId: string };
  readonly neighborTypes: readonly string[];
  readonly limit?: number;
}


/** One page with one neighbor of the first asked type, joined to the expanded node. */
function pageFor(body: ExpandBody) {
  const neighborType = body.neighborTypes[0] ?? body.ref.entityType;
  const anchor = { sourceId: body.sourceId, ...body.ref };
  const neighbor = { sourceId: body.sourceId, entityType: neighborType, stableId: 'N-1' };
  return {
    ref: anchor,
    pageSize: 25,
    nodes: [{ ref: neighbor, display: { title: `${neighborType} N-1`, type: neighborType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } }],
    edges: [{ ref: { sourceId: body.sourceId, type: 'LINK', from: body.ref.entityType, to: neighborType, stableId: 'R-1' }, from: anchor, to: neighbor, type: 'LINK', direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] }],
    pages: body.neighborTypes.map((type) => ({ neighborType: type, returned: type === neighborType ? 1 : 0, hasMore: false, matchingTotal: { value: type === neighborType ? 1 : 0, quality: 'exact', scope: 'relationships' } })),
    warnings: [],
  };
}

async function openOneEntity(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
}

const exact = (value: number) => ({ value, quality: 'exact', scope: 'degree' });
const pair = (relationshipType: string, direction: 'out' | 'in', value: number, neighborTypes: string[]) => ({ relationshipType, direction, count: exact(value), neighborTypes });

test.describe('the Heavy operation banner', () => {
  test('stops an expansion estimated over the threshold, keeps the graph, and Continue loads one bounded page', async ({ page }) => {
    const asked: ExpandBody[] = [];
    await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
      await route.fulfill({
        json: {
          ref: { sourceId: body.sourceId, ...body.ref },
          total: exact(1245),
          byType: [pair('INITIATED', 'out', 1240, ['transaction']), pair('HOLDS_ACCOUNT', 'in', 1, ['customer']), pair('USES_DEVICE', 'out', 1, ['device']), pair('CONNECTS_FROM', 'out', 1, ['ip_address']), pair('TRANSFERRED_TO', 'out', 1, ['account']), pair('TRANSFERRED_TO', 'in', 1, ['account'])],
          byNeighborType: [],
          warnings: [],
          pageSize: 25,
          heavyOpThreshold: 500,
        },
      });
    });
    await page.route((url) => url.pathname === '/v1/graph/expand', async (route) => {
      const body = route.request().postDataJSON() as ExpandBody;
      asked.push(body);
      await route.fulfill({ json: pageFor(body) });
    });
    await openOneEntity(page);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('e');

    const banner = page.getByRole('region', { name: 'Request status' });
    await expect(banner).toBeVisible();
    await expect(banner.getByText('Heavy operation', { exact: true })).toBeVisible();
    await expect(banner.getByText('Estimated 1,245 matches · warning threshold 500')).toBeVisible();
    await expect(banner.getByText('Estimated matches', { exact: true })).toBeVisible();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    expect(asked).toHaveLength(0);

    await banner.getByRole('button', { name: 'Continue with 25' }).click();
    await expect(banner).toBeHidden();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.limit).toBe(25);
  });
});
