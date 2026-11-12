import { expect, test, type Page } from '@playwright/test';
import { canvasOf, menuOf } from './support/workspace.ts';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const remainder = (page: Page) => page.locator('.graph-scope p').nth(1);

interface AskBody {
  readonly sourceId: string;
  readonly ref: { readonly entityType: string; readonly stableId: string };
  readonly neighborTypes: readonly string[];
}

interface CoverageBody {
  readonly entities: readonly { readonly ref: { readonly stableId: string }; readonly loadedRelationships: number }[];
}

function expandAnswer(body: AskBody, call: number) {
  const type = body.neighborTypes[0] ?? body.ref.entityType;
  const anchor = { sourceId: body.sourceId, ...body.ref };
  const id = call === 0 ? 'N-1' : 'N-2';
  const neighbor = { sourceId: body.sourceId, entityType: type, stableId: id };
  return {
    ref: anchor,
    pageSize: 25,
    nodes: [{ ref: neighbor, display: { title: `${type} ${id}`, type }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } }],
    edges: [{ ref: { sourceId: body.sourceId, type: 'LINK', from: body.ref.entityType, to: type, stableId: call === 0 ? 'R-1' : 'R-2' }, from: anchor, to: neighbor, type: 'LINK', direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] }],
    pages: body.neighborTypes.map((neighborType) => ({ neighborType, returned: neighborType === type ? 1 : 0, hasMore: false, matchingTotal: { value: neighborType === type ? 1 : 0, quality: 'exact', scope: 'relationships' } })),
    warnings: [],
  };
}

/** The server's rule over the previews it holds: what is left at each previewed entity, a lower bound while an entity has no preview, exact for one entity with something left, an estimate for several. */
function coverageAnswer(body: CoverageBody, previewed: ReadonlySet<string>, totals: Readonly<Record<string, number>>) {
  const scope = 'not yet retrieved';
  const remainders = body.entities.filter((entity) => previewed.has(entity.ref.stableId)).map((entity) => Math.max(0, (totals[entity.ref.stableId] ?? 0) - entity.loadedRelationships));
  const uncounted = body.entities.length - remainders.length;
  const floor = Math.max(0, ...remainders);
  if (uncounted > 0) return { notRetrieved: floor > 0 ? { value: floor, quality: 'lowerBound', scope } : { quality: 'unknown', scope }, uncounted };
  const contributors = remainders.filter((value) => value > 0).length;
  return { notRetrieved: { value: remainders.reduce((sum, value) => sum + value, 0), quality: contributors > 1 ? 'estimated' : 'exact', scope }, uncounted };
}

async function routeReads(page: Page, totals: Readonly<Record<string, number>>): Promise<void> {
  const previewed = new Set<string>();
  let expansions = 0;
  await page.route((url) => url.pathname === '/v1/graph/expand', (route) => route.fulfill({ json: expandAnswer(route.request().postDataJSON() as AskBody, expansions++) }));
  await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
    const body = route.request().postDataJSON() as AskBody;
    previewed.add(body.ref.stableId);
    const total = { value: totals[body.ref.stableId] ?? 0, quality: 'exact', scope: 'relationships' };
    await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, total, byType: [], byNeighborType: [{ entityType: body.ref.entityType, count: total }], warnings: [], pageSize: 25, heavyOpThreshold: 500 } });
  });
  await page.route((url) => url.pathname === '/v1/graph/coverage', (route) => route.fulfill({ json: coverageAnswer(route.request().postDataJSON() as CoverageBody, previewed, totals) }));
}

async function openOneEntity(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
}

async function select(page: Page, id: string): Promise<void> {
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('Space');
    if (((await inspector(page).getByRole('heading', { level: 2 }).textContent().catch(() => '')) ?? '').includes(id)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('ENTITY_NOT_FOUND_BY_WALK');
}

const exportButton = (page: Page) => page.getByRole('button', { name: 'Export', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Export current view' });
const filtersButton = (page: Page) => page.getByRole('group', { name: 'Tools' }).getByRole('button', { name: 'Filters' });

/** What the Export dialog says its coverage line is, with the dialog closed again. */
async function exportCoverage(page: Page): Promise<string | null> {
  await exportButton(page).click();
  const line = dialog(page).getByText(/^coverage: /);
  await expect(line).toBeVisible();
  const text = await line.textContent();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  return text;
}

async function sameInExport(page: Page, expected: string): Promise<void> {
  await expect(remainder(page)).toHaveText(expected);
  expect(await exportCoverage(page)).toBe(`coverage: ${expected}`);
}

const ANCHOR_SCOPE = (page: Page) => inspector(page).locator('.inspector-scope').first();
const TOTALS_EXACT = { 'AC-1': 3, 'N-1': 1 };

test.describe('the header and the inspector through Expand, a count and Collapse', () => {
  test('say a lower bound with its reason after Expand, the exact count equal to the inspector once every entity is counted, and the exact count again after Collapse', async ({ page }) => {
    await routeReads(page, TOTALS_EXACT);
    await openOneEntity(page);
    await sameInExport(page, '1 shown · more not yet retrieved (1 entity not yet counted)');
    await select(page, 'AC-1');
    await expect(remainder(page)).toHaveText('1 shown · 3 not yet retrieved (exact)');

    await page.keyboard.press('e');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    await sameInExport(page, '2 shown · ≥ 2 not yet retrieved (lower bound · 1 entity not yet counted)');
    await select(page, 'AC-1');
    await expect(inspector(page).locator('.inspector-scope').first()).toHaveText('1 of 3 sourced relationship ends loaded · 2 not loaded');

    await select(page, 'N-1');
    await sameInExport(page, '2 shown · 2 not yet retrieved (exact)');
    await select(page, 'AC-1');
    await expect(inspector(page).locator('.inspector-scope').first()).toHaveText('1 of 3 sourced relationship ends loaded · 2 not loaded');

    await canvasOf(page).focus();
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Collapse', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    await sameInExport(page, '1 shown · 3 not yet retrieved (exact)');
    await expect(inspector(page).locator('.inspector-scope').first()).toHaveText('0 of 3 sourced relationship ends loaded · 3 not loaded');
  });
});

test.describe('the header when several entities have something left, after a load by neighbor type, and under a filter', () => {
  test('says an estimate with its word, equal in the header and the Export dialog, when two counted entities have something left', async ({ page }) => {
    await routeReads(page, { 'AC-1': 3, 'N-1': 3 });
    await openOneEntity(page);
    await select(page, 'AC-1');
    await page.keyboard.press('e');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    await select(page, 'N-1');
    await sameInExport(page, '2 shown · ~4 not yet retrieved (estimated)');
    await expect(ANCHOR_SCOPE(page)).toHaveText('1 of 3 sourced relationship ends loaded · 2 not loaded');
  });

  test('keeps the lower bound and its reason through a load by neighbor type, and counts both new entities as not yet counted', async ({ page }) => {
    await routeReads(page, TOTALS_EXACT);
    await openOneEntity(page);
    await select(page, 'AC-1');
    await page.keyboard.press('e');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    await select(page, 'AC-1');
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name: 'Expand by neighbor type' }).focus();
    await page.keyboard.press('ArrowRight');
    await page.locator('.neighbor-types-expand').click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '3');
    await sameInExport(page, '3 shown · ≥ 1 not yet retrieved (lower bound · 2 entities not yet counted)');
    await select(page, 'AC-1');
    await expect(ANCHOR_SCOPE(page)).toHaveText('2 of 3 sourced relationship ends loaded · 1 not loaded');
  });

  test('says the same count with an entity hidden by a filter, and counts what is shown as what is drawn', async ({ page }) => {
    await routeReads(page, TOTALS_EXACT);
    await openOneEntity(page);
    await select(page, 'AC-1');
    await page.keyboard.press('e');
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    await select(page, 'N-1');
    await sameInExport(page, '2 shown · 2 not yet retrieved (exact)');
    await filtersButton(page).click();
    await page.getByRole('group', { name: 'Entity types' }).getByRole('button').first().click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    await expect(page.locator('.graph-scope p').first()).toContainText('1 hidden by filters');
    await sameInExport(page, '1 shown · 2 not yet retrieved (exact)');
  });
});

