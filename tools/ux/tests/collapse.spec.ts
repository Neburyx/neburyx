import { expect, test, type Page } from '@playwright/test';
import { canvasOf, drawing, menuOf, positions } from './support/workspace.ts';

const total = { value: 4, quality: 'exact', scope: 'relationships' };

interface Body {
  readonly sourceId: string;
  readonly ref: { readonly entityType: string; readonly stableId: string };
  readonly neighborTypes: readonly string[];
  readonly cursors?: Record<string, string>;
}

/** The first page of the expanded node's own type holds two neighbors and has a next page of one; the first page of the customer type holds none and has a next page of one; every other type holds nothing. */
function pageFor(body: Body) {
  const anchor = { sourceId: body.sourceId, ...body.ref };
  const ids: Record<string, readonly string[]> = {
    [`${body.ref.entityType}:first`]: ['N-1', 'N-2'],
    [`${body.ref.entityType}:next`]: ['N-3'],
    'customer:first': [],
    'customer:next': ['C-1'],
  };
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  const pages = body.neighborTypes.map((type) => {
    const next = body.cursors?.[type] !== undefined;
    const returned = ids[`${type}:${next ? 'next' : 'first'}`] ?? [];
    const more = !next && (type === body.ref.entityType || type === 'customer');
    for (const stableId of returned) {
      const to = { sourceId: body.sourceId, entityType: type, stableId };
      nodes.push({ ref: to, display: { title: `${type} ${stableId}`, type }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
      edges.push({ ref: { sourceId: body.sourceId, type: 'LINK', from: body.ref.entityType, to: type, stableId: `R-${stableId}` }, from: anchor, to, type: 'LINK', direction: 'out', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] });
    }
    return { neighborType: type, returned: returned.length, hasMore: more, ...(more ? { nextCursor: `v1.${type}.next` } : {}), matchingTotal: more ? { quality: 'unknown', scope: 'relationships' } : { value: returned.length, quality: 'exact', scope: 'relationships' } };
  });
  return { ref: anchor, pageSize: 25, nodes, edges, pages, warnings: [] };
}

test.describe('collapse', () => {
  let sourceReads: string[] = [];

  test.beforeEach(async ({ page }) => {
    sourceReads = [];
    await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
      sourceReads.push('preview-expansion');
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
      await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, total, byType: [], byNeighborType: [{ entityType: body.ref.entityType, count: { value: 3, quality: 'exact', scope: 'relationships' } }, { entityType: 'customer', count: { value: 1, quality: 'exact', scope: 'relationships' } }], warnings: [], pageSize: 25, heavyOpThreshold: 500 } });
    });
    await page.route((url) => url.pathname === '/v1/graph/expand', async (route) => {
      sourceReads.push('expand');
      await route.fulfill({ json: pageFor(route.request().postDataJSON() as Body) });
    });
    await page.route((url) => url.pathname === '/v1/graph/coverage', async (route) => {
      await route.fulfill({ json: { notRetrieved: { value: 2, quality: 'lowerBound', scope: 'not yet retrieved' } } });
    });
  });

  const lines = (page: Page) => page.locator('.graph-scope p').allTextContents();

  async function openOneEntity(page: Page): Promise<void> {
    await page.goto('/dev/open-entity');
    await page.getByRole('button', { name: 'banking-demo' }).click();
    const form = page.getByRole('form', { name: 'Open an entity' });
    await form.getByLabel('Stable ID').fill('AC-1');
    await form.getByRole('button', { name: 'Open' }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  }

  async function choose(page: Page, name: string): Promise<void> {
    await canvasOf(page).focus();
    await page.keyboard.press('ContextMenu');
    await menuOf(page).first().getByRole('menuitem', { name, exact: true }).focus();
    await page.keyboard.press('Enter');
  }

  test('takes back what one expansion loaded, restores the scope lines and the places of the nodes that stay, and reads nothing from the source', async ({ page }) => {
    await openOneEntity(page);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    // the panel is opened first, so the node is touched and its preview held: its figures are the same before and after
    await choose(page, 'Expand by type');
    const panel = page.getByRole('complementary', { name: 'Expand relationships' });
    await expect(panel).toBeVisible();
    await expect.poll(async () => (await lines(page))[1]).toContain('not yet retrieved (lower bound)');
    const captions = async () => ({
      lines: await lines(page),
      description: await canvasOf(page).evaluate((element) => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? '').then((text) => text.replace(/; \d+ selected/, '')),
      rows: await panel.locator('.supernode-card-type').allTextContents(),
    });
    // the snapshot is taken once the node is touched and its aggregate nodes are drawn (the panel touches it in an effect after it opens): taken earlier, it would lack them, and the collapse, which keeps the node touched, would show them
    await expect.poll(async () => (await captions()).description).toContain('aggregate nodes for relationships not loaded');
    const before = await captions();
    const placesBefore = await positions(page);

    await panel.getByRole('button', { name: /^Load .* per type$/ }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '3');
    await panel.getByRole('button', { name: /^Load 25 more: Account/ }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '4');
    await panel.getByRole('button', { name: /^Load 25 more: Customer/ }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '5');
    expect(await captions()).not.toEqual(before);

    const readsBefore = sourceReads.length;
    await panel.getByRole('button', { name: 'Collapse', exact: true }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    await expect.poll(captions).toEqual(before);
    expect(sourceReads.length, 'a collapse reads nothing from the source').toBe(readsBefore);
    expect(await positions(page)).toEqual(placesBefore);

    await expect(panel.getByRole('button', { name: 'Collapse', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await expect(panel.getByText('Nothing was loaded from this node.')).toBeVisible();
  });
  test('keeps a pinned entity where it was through an expansion', async ({ page }) => {
    await openOneEntity(page);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('p');
    await expect.poll(async () => (await drawing(page)).nodes.filter((node) => node.badgeShown).length).toBe(1);
    const before = await positions(page);
    await choose(page, 'Expand by type');
    const panel = page.getByRole('complementary', { name: 'Expand relationships' });
    await panel.getByRole('button', { name: /^Load .* per type$/ }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '3');
    const after = await positions(page);
    for (const [id, at] of Object.entries(before)) expect(after[id], 'the pinned entity did not move').toEqual(at);
  });

  test('draws no placeholder and no link to one while focus is on, and draws them again on leaving focus', async ({ page }) => {
    await openOneEntity(page);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await choose(page, 'Expand by type');
    const panel = page.getByRole('complementary', { name: 'Expand relationships' });
    await panel.getByRole('button', { name: /^Load .* per type$/ }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '3');
    const placeholders = async () => ((await drawing(page)) as unknown as { remainders: unknown[] }).remainders.length;
    expect(await placeholders()).toBeGreaterThan(0);
    const reads = sourceReads.length;
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await page.keyboard.press('f');
    await expect(page.getByRole('button', { name: 'Leave focus' })).toBeVisible();
    await expect.poll(placeholders).toBe(0);
    const drawn = await drawing(page);
    const ids = new Set(drawn.nodes.map((node) => node.id));
    expect(drawn.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)), 'every drawn link joins two drawn entities').toBe(true);
    await page.getByRole('button', { name: 'Leave focus' }).click();
    await expect.poll(placeholders).toBeGreaterThan(0);
    expect(sourceReads.length, 'focus reads nothing from the source').toBe(reads);
  });
});
