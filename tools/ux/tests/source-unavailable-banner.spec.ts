import { expect, test, type Page } from '@playwright/test';
import { canvasOf } from './support/workspace.ts';

interface ExpandBody {
  readonly sourceId: string;
  readonly ref: { readonly entityType: string; readonly stableId: string };
  readonly neighborTypes: readonly string[];
}

const UNAVAILABLE = (retryAfterMs: number) => ({ error: { code: 'SOURCE_UNAVAILABLE', message: 'The source has timed out repeatedly and is being left to recover. Try again shortly.', retryable: true, traceId: 'tr-ux-breaker', details: { reason: 'repeated-timeouts', retryAfterMs } } });

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

test.describe('the Source unavailable banner after repeated timeouts', () => {
  test('shows the wait and holds Retry until it is over, keeps the graph, and Retry by keyboard sends the same expansion and loads its page', async ({ page }) => {
    const asked: ExpandBody[] = [];
    await page.route((url) => url.pathname === '/v1/graph/expand', async (route) => {
      const body = route.request().postDataJSON() as ExpandBody;
      asked.push(body);
      if (asked.length === 1) await route.fulfill({ status: 503, headers: { 'retry-after': '2' }, json: UNAVAILABLE(2000) });
      else await route.fulfill({ json: pageFor(body) });
    });
    await openOneEntity(page);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('e');

    const banner = page.getByRole('region', { name: 'Request status' });
    await expect(banner).toBeVisible();
    await expect(banner.getByText('Repeated timeouts', { exact: true })).toBeVisible();
    await expect(banner.getByText('banking-demo unavailable after repeated timeouts. The loaded graph remains available.')).toBeVisible();
    await expect(banner.getByText('Filters and saved view preserved; retry does not discard the graph.')).toBeVisible();
    await expect(banner.getByRole('button', { name: /^Retry in \d s$/ })).toBeDisabled();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    expect(asked).toHaveLength(1);

    const retry = banner.getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeEnabled({ timeout: 5000 });
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(banner).toBeHidden();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    expect(asked).toHaveLength(2);
    expect(asked[1]).toEqual(asked[0]);
  });
});
