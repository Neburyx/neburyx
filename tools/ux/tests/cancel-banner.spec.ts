import { expect, test, type Page } from '@playwright/test';
import { canvasOf } from './support/workspace.ts';

interface ExpandBody {
  readonly sourceId: string;
  readonly ref: { readonly entityType: string; readonly stableId: string };
  readonly neighborTypes: readonly string[];
}

const BUSY = { error: { code: 'SOURCE_BUSY', message: 'The data source is busy. Try again shortly.', retryable: true, traceId: 'tr-ux-busy' } };

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

test.describe('cancelling a running expansion', () => {
  test('shows Running after a moment, Cancel aborts the request and keeps the graph, and Run again loads the page', async ({ page }) => {
    const asked: ExpandBody[] = [];
    const aborted: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    page.on('requestfailed', (request) => {
      if (new URL(request.url()).pathname === '/v1/graph/expand') aborted.push(request.url());
    });
    await page.route((url) => url.pathname === '/v1/graph/expand', async (route) => {
      const body = route.request().postDataJSON() as ExpandBody;
      asked.push(body);
      if (asked.length === 1) await held;
      else await route.fulfill({ json: pageFor(body) });
    });
    await openOneEntity(page);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('e');

    const banner = page.getByRole('region', { name: 'Request status' });
    await expect(banner).toBeHidden();
    await expect(banner.getByText('Running', { exact: true })).toBeVisible();
    await expect(banner.getByText('Loaded graph and filters preserved.')).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Dismiss' })).toBeHidden();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');

    await banner.getByRole('button', { name: 'Cancel' }).click();
    await expect(banner.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(banner.getByText('Cancelled. No new relationships added.')).toBeVisible();
    await expect(banner.getByText('Loaded graph and filters preserved; no complete-result claim.')).toBeVisible();
    await expect.poll(() => aborted.length).toBe(1);
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');

    await banner.getByRole('button', { name: 'Run again' }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual(asked[0]);
    release();
  });
});
