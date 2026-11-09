import { expect, test, type Page } from '@playwright/test';
import { announcement, canvasOf, drawing } from './support/workspace.ts';

const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
const SOURCE = 'banking-demo';

const node = (stableId: string) => ({
  ref: { sourceId: SOURCE, entityType: 'account', stableId },
  display: { title: `Account ${stableId}`, type: 'account' },
  properties: [],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

const derivedEdge = (ruleId: string, from: string, to: string) => ({
  ref: { sourceId: SOURCE, derived: { ruleId, from: { sourceId: SOURCE, entityType: 'account', stableId: from }, to: { sourceId: SOURCE, entityType: 'account', stableId: to } } },
  from: { sourceId: SOURCE, entityType: 'account', stableId: from },
  to: { sourceId: SOURCE, entityType: 'account', stableId: to },
  type: ruleId,
  direction: 'from-to',
  semantics: 'derived',
  derivation: { ruleId, ruleVersion: 1, supportingEdgeRefs: [] },
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
});

const result = (ruleId: string, from: string, to: string, count: { value: number; quality: 'exact' | 'lowerBound' }) => ({
  ruleId,
  ruleVersion: 1,
  count: { ...count, scope: 'derived:neighbors' },
  nodes: [node(to)],
  edges: [derivedEdge(ruleId, from, to)],
  warnings: [],
});

async function openEntity(page: Page, stableId: string): Promise<void> {
  await page.goto(`/${SOURCE}/entity/account/${stableId}`);
  await expect(page).toHaveURL(/\/explore\/[0-9a-f-]{36}$/);
  await expect(canvasOf(page)).toBeVisible();
  await canvasOf(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(inspector(page)).toBeVisible();
}

test.describe('the rule-derived neighbors of the inspector', () => {
  let failures = 0;
  let asked: string[] = [];

  test.beforeEach(async ({ page }) => {
    failures = 0;
    asked = [];
    await page.route((url) => url.pathname === '/v1/graph/preview-expansion', async (route) => {
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
      const total = { value: 2, quality: 'exact', scope: 'relationships' };
      await route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, total, byType: [], byNeighborType: [{ entityType: 'device', count: total }], warnings: [], pageSize: 25, heavyOpThreshold: 500 } });
    });
    await page.route((url) => url.pathname === '/v1/graph/derived-neighbors', async (route) => {
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
      const id = body.ref.stableId;
      asked.push(id);
      const ref = { sourceId: body.sourceId, ...body.ref };
      if (id === 'bad-1' && failures === 0) {
        failures += 1;
        return route.fulfill({ status: 503, json: { error: { code: 'SOURCE_UNAVAILABLE', message: 'x', retryable: true, traceId: 'tr-1', details: { reason: 'unreachable' } } } });
      }
      const capped = id === 'many-1';
      const results = [result('shared-device', id, 'acc-2', capped ? { value: 25, quality: 'lowerBound' } : { value: 1, quality: 'exact' }), result('shared-address', id, 'acc-3', { value: 0, quality: 'exact' })];
      return route.fulfill({ json: { ref, results: results.map((entry, index) => (index === 1 ? { ...entry, nodes: [], edges: [] } : entry)) } });
    });
  });

  test('count an exact link, say a capped one is a lower bound, and ask once for the entity', async ({ page }) => {
    await openEntity(page, 'one-1');
    const rows = inspector(page).getByRole('group', { name: /^Linked/ });
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveText(/^Linked Account · 1 · rule-derived(Show)?$/);
    await expect(rows.nth(1)).toHaveText('Linked Account · 0 · rule-derived');
    expect(asked).toEqual(['one-1']);
    await page.goto(`/${SOURCE}/entity/account/many-1`);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect(inspector(page).getByRole('group', { name: /^Linked/ }).first()).toHaveText(/^Linked Account · ≥ 25 · rule-derived · lower bound(Show 25)?$/);
  });

  test('keep the rest of the inspector when the run fails, and count again on Retry', async ({ page }) => {
    await openEntity(page, 'bad-1');
    await expect(inspector(page).getByRole('alert')).toBeVisible();
    await expect(inspector(page).getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await inspector(page).getByRole('button', { name: 'Retry' }).last().click();
    await expect(inspector(page).getByRole('group', { name: /^Linked/ }).first()).toHaveText(/^Linked Account · 1 · rule-derived(Show)?$/);
  });

  test('load the neighbors with Show by keyboard, draw the derived relationship, and keep the inspector and the focus', async ({ page }) => {
    await openEntity(page, 'one-1');
    const before = await drawing(page);
    const show = inspector(page).getByRole('button', { name: /^Show Account \(shared-device\)/ });
    await show.focus();
    await page.keyboard.press('Enter');
    await expect(announcement(page)).toHaveText('1 neighbor added');
    await expect(show).toBeFocused();
    const after = await drawing(page);
    expect(after.nodes.length).toBe(before.nodes.length + 1);
    expect(after.edges.length).toBe(before.edges.length + 1);
    expect(asked).toEqual(['one-1']);
    await page.keyboard.press('Space');
    await expect(announcement(page)).toHaveText('Already shown');
    expect((await drawing(page)).edges.length).toBe(after.edges.length);
  });
});
