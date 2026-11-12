import { expect, test, type Page } from '@playwright/test';
import { canvasOf, menuOf } from './support/workspace.ts';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const total = { value: 3, quality: 'exact', scope: 'relationships' };

interface AskBody {
  readonly sourceId: string;
  readonly ref: { readonly entityType: string; readonly stableId: string };
  readonly neighborTypes: readonly string[];
}

interface CoverageBody {
  readonly entities: readonly { readonly ref: { readonly stableId: string }; readonly loadedRelationships: number; readonly loadedQuality: string }[];
}

async function openOneEntity(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
}

function expandAnswer(body: AskBody, withSelfLoop: boolean) {
  const type = body.neighborTypes[0] ?? body.ref.entityType;
  const anchor = { sourceId: body.sourceId, ...body.ref };
  const neighbor = { sourceId: body.sourceId, entityType: type, stableId: 'N-1' };
  const edge = (stableId: string, to: typeof anchor, toType: string) => ({
    ref: { sourceId: body.sourceId, type: 'LINK', from: body.ref.entityType, to: toType, stableId },
    from: anchor,
    to,
    type: 'LINK',
    direction: 'from-to',
    semantics: 'stored',
    properties: [],
    evidenceRefs: [],
    qualityFlags: [],
  });
  return {
    ref: anchor,
    pageSize: 25,
    nodes: [{ ref: neighbor, display: { title: `${type} N-1`, type }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } }],
    edges: [edge('R-1', neighbor, type), ...(withSelfLoop ? [edge('R-2', anchor, body.ref.entityType)] : [])],
    pages: body.neighborTypes.map((neighborType) => ({ neighborType, returned: neighborType === type ? 1 : 0, hasMore: false, matchingTotal: { value: neighborType === type ? 1 : 0, quality: 'exact', scope: 'x' } })),
    warnings: [],
  };
}

async function routeReads(page: Page, withSelfLoop: boolean, coverage: CoverageBody[]): Promise<void> {
  await page.route((url) => url.pathname === '/v1/graph/expand', (route) => route.fulfill({ json: expandAnswer(route.request().postDataJSON() as AskBody, withSelfLoop) }));
  await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
    const body = route.request().postDataJSON() as AskBody;
    await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, total, byType: [], byNeighborType: [{ entityType: body.ref.entityType, count: total }], warnings: [], pageSize: 25, heavyOpThreshold: 500 } });
  });
  await page.route((url) => url.pathname === '/v1/graph/coverage', async (route) => {
    coverage.push(route.request().postDataJSON() as CoverageBody);
    await route.fulfill({ json: { notRetrieved: { quality: 'unknown', scope: 'not yet retrieved' }, uncounted: 1 } });
  });
}

async function selectAnchor(page: Page): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('Space');
    if (((await inspector(page).getByRole('heading', { level: 2 }).textContent().catch(() => '')) ?? '').includes('AC-1')) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('ANCHOR_NOT_FOUND_BY_WALK');
}

test.describe('the counts of loaded relationships', () => {
  test('are the same in the inspector sentence and in the coverage request, a relationship from the entity to itself counting at both of its ends', async ({ page }) => {
    const coverage: CoverageBody[] = [];
    await routeReads(page, true, coverage);
    await openOneEntity(page);
    await selectAnchor(page);
    await page.keyboard.press('e');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    await selectAnchor(page);
    await expect(inspector(page).locator('.inspector-scope').first()).toHaveText('3 of 3 sourced relationship ends loaded · 0 not loaded');
    await expect.poll(() => coverage.at(-1)?.entities.find((entity) => entity.ref.stableId === 'AC-1')?.loadedRelationships).toBe(3);
  });
});

test.describe('a load that finds nothing new', () => {
  test('says so, and says nothing for a load that adds something', async ({ page }) => {
    await routeReads(page, false, []);
    await openOneEntity(page);
    await selectAnchor(page);
    await page.keyboard.press('e');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    const note = page.getByRole('status').filter({ hasText: 'Nothing new: everything on this page is already loaded' });
    await expect(note).toHaveCount(0);
    await selectAnchor(page);
    await page.keyboard.press('e');
    await expect(note).toBeVisible();
    await expect(note).not.toBeFocused();
  });
});

test.describe('the Expand button of the neighbor type flyout', () => {
  test('says how many types it loads and how many neighbors of each at most, not a count of neighbors', async ({ page }) => {
    await routeReads(page, false, []);
    await openOneEntity(page);
    await selectAnchor(page);
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Expand by neighbor type' }).focus();
    await page.keyboard.press('ArrowRight');
    const button = page.locator('.neighbor-types-expand');
    await expect(button).toHaveText(/^Expand \d+ types? \(up to 25 each\)$/);
    await expect(button).not.toContainText('neighbor');
  });
});

test.describe('a load of the Expand relationships panel that adds nothing', () => {
  test('says so beside the open panel each time, and says nothing for a load that adds something', async ({ page }) => {
    await routeReads(page, false, []);
    await page.route((url) => url.pathname === '/v1/graph/expand', (route) => {
      const answer = expandAnswer(route.request().postDataJSON() as AskBody, false);
      return route.fulfill({ json: { ...answer, pages: answer.pages.map((entry) => ({ ...entry, hasMore: true, nextCursor: 'v1.c.m' })) } });
    });
    await openOneEntity(page);
    await selectAnchor(page);
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Expand by type', exact: true }).focus();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('complementary', { name: 'Expand relationships' });
    await expect(panel).toBeVisible();
    const note = page.getByRole('status').filter({ hasText: 'Nothing new: everything on this page is already loaded' });
    const load = panel.getByRole('button', { name: /^Load \d+ per type$/ });
    await load.click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    await expect(panel.getByText('Loading neighbors')).toHaveCount(0);
    await expect(note).toHaveCount(0);
    await load.click();
    await expect(note).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(load).toBeFocused();
    await load.click();
    await expect(note).toBeVisible();
  });
});
